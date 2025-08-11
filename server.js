// server.js — SmartEmail + IMAP UI/API + Google & Microsoft OAuth

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import Stripe from 'stripe';
import stripeWebHook from './stripeWebHook.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// ✅ IMAP REST routes
import imapRoutes from './imap-reader/imapRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const USE_GOOGLE_AUTH = (process.env.USE_GOOGLE_AUTH || 'true') === 'true';
const USE_MS_AUTH = (process.env.USE_MS_AUTH || 'true') === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Core middleware
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ----- SUPABASE -----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ----- GOOGLE OAUTH (optional) -----
let googleClient;
if (USE_GOOGLE_AUTH) {
  googleClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || '',
    process.env.GOOGLE_CLIENT_SECRET || '',
    process.env.GOOGLE_REDIRECT_URI || ''
  );
}

app.get('/auth/google', (req, res) => {
  if (!USE_GOOGLE_AUTH) return res.status(403).send('Google login is disabled.');
  const url = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!USE_GOOGLE_AUTH) return res.status(403).send('Google login is disabled.');
  try {
    const { tokens } = await googleClient.getToken(String(req.query.code || ''));
    googleClient.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: googleClient });
    const user = await oauth2.userinfo.get();
    res.json({ provider: 'google', user: user.data, tokens });
  } catch (e) {
    console.error('OAuth error:', e);
    res.status(500).send('Google authentication failed.');
  }
});

// ----- MICROSOFT OAUTH (for Outlook/Office 365 IMAP) -----
const MS_SCOPES = [
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
].join(' ');

app.get('/auth/microsoft', (req, res) => {
  if (!USE_MS_AUTH) return res.status(403).send('Microsoft login is disabled.');

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    response_type: 'code',
    redirect_uri: process.env.MS_REDIRECT_URI || '',
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    nonce,
    prompt: 'select_account'
  });

  res.redirect(
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' +
      params.toString()
  );
});

app.get('/auth/microsoft/callback', async (req, res) => {
  if (!USE_MS_AUTH) return res.status(403).send('Microsoft login is disabled.');

  const code = String(req.query.code || '');
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const tokenRes = await fetch(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.MS_CLIENT_ID || '',
          client_secret: process.env.MS_CLIENT_SECRET || '',
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.MS_REDIRECT_URI || '',
          scope: MS_SCOPES
        })
      }
    );

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('MS token error:', tokens);
      return res
        .status(500)
        .json({ error: 'Failed to exchange Microsoft token', detail: tokens });
    }

    // You can persist tokens in Supabase keyed by email if desired.
    return res.json({
      provider: 'microsoft',
      message: 'Microsoft OAuth successful',
      tokens
    });
  } catch (err) {
    console.error('Microsoft OAuth Error:', err);
    return res.status(500).json({ error: 'Microsoft OAuth exchange failed' });
  }
});

// Helper for clients: which providers are enabled
app.get('/auth/providers', (req, res) => {
  res.json({
    google_enabled: USE_GOOGLE_AUTH,
    microsoft_enabled: USE_MS_AUTH,
    google_url: USE_GOOGLE_AUTH ? '/auth/google' : null,
    microsoft_url: USE_MS_AUTH ? '/auth/microsoft' : null
  });
});

// ----- HOME (SmartEmail UI) -----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----- STATUS -----
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    googleLogin: USE_GOOGLE_AUTH,
    microsoftLogin: USE_MS_AUTH,
    mode: 'SmartEmail'
  });
});

// ---------- LICENSE HELPERS ----------
async function checkLicense(email) {
  const { data, error } = await supabase
    .from('licenses')
    .select('smartemail_tier, smartemail_expires')
    .eq('email', email)
    .maybeSingle();

  if (error || !data) {
    await supabase
      .from('licenses')
      .upsert(
        {
          email: String(email || '').trim().toLowerCase(),
          smartemail_tier: 'free',
          smartemail_expires: null
        },
        { onConflict: 'email' }
      );
    return { tier: 'free', expires: null, reason: 'inserted-free' };
  }

  return {
    tier: data.smartemail_tier || 'free',
    expires: data.smartemail_expires || null
  };
}

// ---------- GENERATE ----------
app.post('/generate', async (req, res) => {
  const {
    email, email_type, emailType,
    tone, language,
    target_audience, audience,
    email_content, content,
    sender_details, agent,
    action
  } = req.body;

  const finalEmail = email;
  const finalEmailType = email_type || emailType;
  const finalTone = tone;
  const finalLanguage = language;
  const finalAudience = target_audience || audience;
  const finalContent = email_content || content;
  const finalAgent = sender_details || agent;

  if (!finalEmail || !finalEmailType || !finalTone || !finalLanguage || !finalAudience || !finalContent) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const prompt = `
You are a senior email copywriter helping a user write a reply email.

The user received this message and wants to respond to it:
"""
${finalContent}
"""

Write a professional reply email using the following creative brief:

- Email Type: ${finalEmailType}
- Tone and Style: ${finalTone}
- Target Audience: ${finalAudience}
- Primary Goal / Call-to-Action: ${action || ''}
- Language: ${finalLanguage}

Include greeting, body, and closing with a strong sign-off.
${finalAgent ? '**Sender Info:**\n' + finalAgent : ''}`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4-1106-preview',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
    });
    const result = await response.json();
    const reply = (result.choices?.[0]?.message?.content || '').trim();
    if (!reply) return res.status(500).json({ error: 'AI failed to generate a response.' });

    try {
      await supabase.from('leads').insert([{
        email: finalEmail,
        original_message: finalContent,
        generated_reply: reply,
        product: 'SmartEmail',
      }]);
    } catch {}

    const lic = await checkLicense(finalEmail);
    res.json({ generatedEmail: reply, tier: lic.tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- ENHANCE ----------
app.post('/enhance', async (req, res) => {
  const { email, enhance_request, enhance_content } = req.body;
  if (!email || !enhance_request || !enhance_content) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const lic = await checkLicense(email);
  if (lic.tier === 'free') return res.status(403).json({ error: 'Enhancement is Pro/Premium only.' });

  const enhancePrompt = `
Rewrite the email based on the user's request. Keep it professional.

Original:
${enhance_content}

User request:
${enhance_request}`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4-1106-preview',
        messages: [{ role: 'user', content: enhancePrompt }],
        max_tokens: 400,
      }),
    });
    const result = await response.json();
    const reply = (result.choices?.[0]?.message?.content || '').trim();
    if (!reply) return res.status(500).json({ error: 'AI failed to enhance.' });

    try {
      await supabase.from('enhancements').insert([{
        email,
        original_text: enhance_content,
        enhancement_prompt: enhance_request,
        enhanced_result: reply,
        product: 'SmartEmail',
      }]);
    } catch {}

    res.status(200).json({ generatedEmail: reply, tier: lic.tier });
  } catch (err) {
    console.error('Enhance error:', err);
    res.status(500).json({ error: 'Something went wrong while enhancing.' });
  }
});

// ---------- FREE USER & CONFIG ----------
app.post('/api/register-free-user', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data, error } = await supabase
      .from('licenses')
      .upsert(
        { email, smartemail_tier: 'free', smartemail_expires: null },
        { onConflict: ['email'] }
      )
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'DB error', detail: error.message });
    res.json({ status: data ? 'inserted' : 'exists' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unknown error' });
  }
});

app.get('/config', (req, res) => {
  res.json({
    PRO_URL: process.env.PRO_URL || '',
    PREMIUM_URL: process.env.PREMIUM_URL || ''
  });
});

// ---------- LICENSE VALIDATION ----------
app.get('/validate-license', async (req, res) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    const licenseKeyRaw = typeof req.query.licenseKey === 'string' ? req.query.licenseKey.trim() : '';
    if (!email && !licenseKeyRaw) return res.status(400).json({ error: 'Missing email or licenseKey' });

    let row = null;
    if (licenseKeyRaw) {
      const { data, error } = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires')
        .eq('license_key', licenseKeyRaw)
        .maybeSingle();
      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    if (!row && email) {
      const newLicenseKey = `free_${email.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;
      const { data: inserted, error: insertError } = await supabase
        .from('licenses')
        .insert([{ email, license_key: newLicenseKey, smartemail_tier: 'free', smartemail_expires: null }])
        .select()
        .maybeSingle();
      if (insertError) throw insertError;
      row = inserted;
    }

    const now = new Date();
    const tier = row.smartemail_tier || 'free';
    const expiresAt = row.smartemail_expires || null;
    const active = tier === 'free' ? true : !!(expiresAt && new Date(expiresAt) >= now);

    return res.status(200).json({
      status: active ? 'active' : 'expired',
      tier,
      email: row.email || null,
      licenseKey: row.license_key || null,
      expiresAt
    });
  } catch (err) {
    console.error('validate-license error:', err?.message || err);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// ---------- IMAP UI + API ----------
// UI
app.get('/imap', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'imap.html'));
});

// API
app.use('/api/imap', imapRoutes);

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
