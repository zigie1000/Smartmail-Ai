// server.js — SmartEmail + IMAP UI/API + Google & Microsoft OAuth

// Force IPv4 to avoid IPv6 stalls with iCloud IMAP on Render
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import Stripe from 'stripe';
import stripeWebHook from './stripeWebHook.js'; // optional
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// ✅ IMAP REST routes
import imapRoutes from './imap-reader/imapRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const USE_GOOGLE_AUTH = (process.env.USE_GOOGLE_AUTH || 'true') === 'true';
const USE_MS_AUTH     = (process.env.USE_MS_AUTH || 'true') === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Core middleware ----------
app.set('trust proxy', 1);
app.use(cors());

// Make payloads big enough for generator + small images
const BODY_LIMIT = process.env.BODY_LIMIT || '5mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); }
}));

// ---------- SUPABASE ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------- GOOGLE OAUTH (optional) ----------
let googleClient;
if (USE_GOOGLE_AUTH) {
  googleClient = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || '',
    process.env.GOOGLE_CLIENT_SECRET || '',
    process.env.AZURE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || ''
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

// ---------- MICROSOFT OAUTH (Graph) ----------
const {
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  AZURE_TENANT_ID,
  AZURE_REDIRECT_URI,
  AZURE_SCOPES
} = process.env;

const TENANT     = (AZURE_TENANT_ID && AZURE_TENANT_ID.trim()) || 'common';
const MS_SCOPES  = (AZURE_SCOPES && AZURE_SCOPES.trim())
  || 'openid profile email offline_access https://graph.microsoft.com/Mail.Read';

const MS_AUTH  = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const MS_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';

app.get('/auth/microsoft', (req, res) => {
  if (!USE_MS_AUTH) return res.status(403).send('Microsoft login is disabled.');
  if (!AZURE_CLIENT_ID || !AZURE_REDIRECT_URI) {
    return res.status(500).send('Microsoft OAuth not configured (.env).');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: AZURE_REDIRECT_URI,
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    prompt: 'select_account'
  });
  res.redirect(`${MS_AUTH}?${params.toString()}`);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  if (!USE_MS_AUTH) return res.status(403).send('Microsoft login is disabled.');
  try {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing authorization code');

    const tokenRes = await fetch(MS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: AZURE_REDIRECT_URI,
        scope: MS_SCOPES
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('MS token error:', tokens);
      return res.status(500).json({ error: 'Failed to exchange token', detail: tokens });
    }

    const meRes = await fetch(GRAPH_ME, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const me = await meRes.json();
    if (!meRes.ok) {
      console.error('Graph /me error:', me);
      return res.status(500).json({ error: 'Failed to fetch profile from Graph' });
    }

    const email = (me.mail || me.userPrincipalName || '').toLowerCase();
    if (email) {
      try {
        await supabase
          .from('oauth_tokens')
          .upsert(
            {
              provider: 'microsoft',
              email,
              access_token: tokens.access_token || null,
              refresh_token: tokens.refresh_token || null,
              expires_at: tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
                : null,
              scope: MS_SCOPES
            },
            { onConflict: 'provider,email' }
          );
      } catch (dbErr) {
        console.error('Supabase save error:', dbErr);
      }
    }

    res.redirect('/imap?ms=ok');
  } catch (err) {
    console.error('Microsoft OAuth Error:', err);
    res.status(500).send('Microsoft OAuth failed.');
  }
});

// ---------- HOME (SmartEmail UI) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- STATUS ----------
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', googleLogin: USE_GOOGLE_AUTH, microsoftLogin: USE_MS_AUTH, mode: 'SmartEmail' });
});

// ---------- LICENSE HELPERS (EMAIL-ONLY primary; key fallback) ----------
async function checkLicense(email, licenseKey) {
  const e = String(email || '').trim().toLowerCase();

  // If licenseKey provided, try by key first (still reading smartemail_* columns)
  if (licenseKey) {
    const byKey = await supabase
      .from('licenses')
      .select('smartemail_tier, smartemail_expires, tier, expires_at')
      .eq('license_key', licenseKey)
      .maybeSingle();

    if (byKey.data) {
      const tier = byKey.data.smartemail_tier || byKey.data.tier || 'free';
      const expires = byKey.data.smartemail_expires || byKey.data.expires_at || null;
      return { tier, expires };
    }
  }

  // Primary: by email (latest). Only email columns; NO app filter.
  let { data } = await supabase
    .from('licenses')
    .select('smartemail_tier, smartemail_expires, tier, expires_at, created_at')
    .eq('email', e)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // If not found, create a free stub (email only).
  if (!data) {
    await supabase
      .from('licenses')
      .upsert({ email: e, smartemail_tier: 'free', smartemail_expires: null }, { onConflict: 'email' });
    return { tier: 'free', expires: null, reason: 'inserted-free' };
  }

  const tier = data.smartemail_tier || data.tier || 'free';
  const expires = data.smartemail_expires || data.expires_at || null;
  return { tier, expires };
}

// ---------- GENERATE (always available) ----------
app.post('/generate', async (req, res) => {
  try {
    const {
      email, email_type, emailType,
      tone, language,
      target_audience, audience,
      email_content, content,
      sender_details, agent,
      action,
      formality, length, audience_role
    } = req.body || {};

    const finalEmail     = email;
    const finalEmailType = email_type || emailType;
    const finalTone      = tone;
    const finalLanguage  = language;
    const finalAudience  = target_audience || audience;
    const finalContent   = email_content || content;
    const finalAgent     = sender_details || agent;

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
- Formality: ${formality || ''}
- Preferred Length: ${length || ''}
- Audience Role: ${audience_role || ''}

Include greeting, body, and closing with a strong sign-off.
${finalAgent ? '**Sender Info:**\n' + finalAgent : ''}`.trim();

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_GENERATE_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.5
      })
    });

    const result = await aiResp.json();
    const reply = (result?.choices?.[0]?.message?.content || '').trim();
    if (!aiResp.ok || !reply) {
      console.error('Generate error:', result?.error || result);
      return res.status(502).json({ error: 'AI generation failed.' });
    }

    try {
      await supabase.from('leads').insert([{
        email: finalEmail, original_message: finalContent, generated_reply: reply, product: 'SmartEmail'
      }]);
    } catch {}

    // Generation is always available — we still return the current tier for the UI badge.
    const lic = await checkLicense(finalEmail, req.body?.licenseKey);
    res.json({ generatedEmail: reply, tier: lic.tier || 'free' });
  } catch (err) {
    console.error('Generate route error:', err?.message || err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ---------- ENHANCE (tier-gated) ----------
app.post('/enhance', async (req, res) => {
  try {
    const { email, enhance_request, enhance_content } = req.body || {};
    if (!email || !enhance_request || !enhance_content) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const lic = await checkLicense(email, req.body?.licenseKey); // ← fixed variable
    if ((lic.tier || 'free').toLowerCase() === 'free') {
      return res.status(403).json({ error: 'Enhancement is Pro/Premium only.' });
    }

    const enhancePrompt = `
Rewrite the email based on the user's request. Keep it professional.

Original:
${enhance_content}

User request:
${enhance_request}`.trim();

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_ENHANCE_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: enhancePrompt }],
        max_tokens: 500,
        temperature: 0.4
      })
    });

    const result = await aiResp.json();
    const reply = (result?.choices?.[0]?.message?.content || '').trim();
    if (!aiResp.ok || !reply) {
      console.error('Enhance error:', result?.error || result);
      return res.status(502).json({ error: 'AI enhancement failed.' });
    }

    try {
      await supabase.from('enhancements').insert([{
        email, original_text: enhance_content, enhancement_prompt: enhance_request, enhanced_result: reply, product: 'SmartEmail'
      }]);
    } catch {}

    res.status(200).json({ generatedEmail: reply, tier: lic.tier || 'free' });
  } catch (err) {
    console.error('Enhance route error:', err?.message || err);
    res.status(500).json({ error: 'Something went wrong while enhancing.' });
  }
});

// ---------- FREE USER REG (email-only) & CONFIG ----------
app.post('/api/register-free-user', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data, error } = await supabase
      .from('licenses')
      .upsert({ email, smartemail_tier: 'free', smartemail_expires: null }, { onConflict: 'email' })
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'DB error', detail: error.message });
    res.json({ status: data ? 'inserted' : 'exists' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unknown error' });
  }
});

app.get('/config', (req, res) => {
  res.json({ PRO_URL: process.env.PRO_URL || '', PREMIUM_URL: process.env.PREMIUM_URL || '' });
});

// ---------- LICENSE VALIDATION (email-only primary; key fallback) ----------
app.get('/validate-license', async (req, res) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    const licenseKeyRaw = typeof req.query.licenseKey === 'string' ? req.query.licenseKey.trim() : '';
    if (!email && !licenseKeyRaw) return res.status(400).json({ error: 'Missing email or licenseKey' });

    let row = null;

    if (licenseKeyRaw) {
      const byKey = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires, tier, expires_at, status')
        .eq('license_key', licenseKeyRaw)
        .maybeSingle();
      row = byKey.data || null;
    }

    if (!row && email) {
      const byEmail = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires, tier, expires_at, status, created_at')
        .eq('email', email)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      row = byEmail.data || null;
    }

    if (!row && email) {
      const newLicenseKey = `free_${email.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;
      const ins = await supabase
        .from('licenses')
        .insert([{ email, license_key: newLicenseKey, smartemail_tier: 'free', smartemail_expires: null }])
        .select()
        .maybeSingle();
      row = ins.data;
    }

    const now = new Date();
    const tier = (row?.smartemail_tier || row?.tier || 'free');
    const expiresAt = (row?.smartemail_expires || row?.expires_at || null);
    const active = tier === 'free'
      ? true
      : !!(expiresAt ? new Date(expiresAt) >= now : (row?.status === 'active' || row?.status === 'paid'));

    return res.status(200).json({
      status: active ? 'active' : 'expired',
      tier,
      email: row?.email || null,
      licenseKey: row?.license_key || null,
      expiresAt
    });
  } catch (err) {
    console.error('validate-license error:', err?.message || err);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// ---------- IMAP UI + API ----------
app.get('/imap', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'imap.html'));
});
app.use('/api/imap', imapRoutes);

// --- SQL-backed email-only tier check (used by the front-end badge) ---
app.post('/api/license/check', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data, error } = await supabase
      .from('licenses')
      .select('smartemail_tier, smartemail_expires, status, created_at')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json({ found: false, active: false, tier: 'free' });

    const tier   = (data.smartemail_tier || 'free').toLowerCase();
    const exp    = data.smartemail_expires ? new Date(data.smartemail_expires) : null;
    const active = (tier === 'free')
      ? true
      : !!(exp ? exp > new Date() : (data.status === 'active' || data.status === 'paid'));

    return res.json({ found: true, active, tier });
  } catch (e) {
    // Do not block UI if SQL fails
    return res.json({ found: false, active: false, tier: 'free' });
  }
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
