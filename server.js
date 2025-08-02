// server.js (SmartEmail Restored Full Functionality)

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import Stripe from 'stripe';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const USE_GOOGLE_AUTH = process.env.USE_GOOGLE_AUTH === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Optional Google auth client
let oauth2Client;
if (USE_GOOGLE_AUTH) {
  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Generate OpenAI prompt
function generateAIPrompt(content, action = 'generate', agent = '') {
  let context = '';
  if (agent.trim() !== '') {
    context = `The individual or business sending the email. Sender details: ${agent}\n\n`;
  }

  switch (action) {
    case 'enhance':
      return `${context}Enhance the professionalism, clarity, and tone of the following email:\n\n"${content}"`;
    case 'summarize':
      return `${context}Summarize the following email clearly:\n\n"${content}"`;
    case 'translate':
      return `${context}Translate this email into professional English:\n\n"${content}"`;
    default:
      return `${context}Reply professionally to this email:\n\n"${content}"`;
  }
}
// Home route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Status check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    googleLogin: USE_GOOGLE_AUTH,
    mode: 'SmartEmail',
  });
});

// Google OAuth
app.get('/auth/google', (req, res) => {
  if (!USE_GOOGLE_AUTH) return res.status(403).send('Google login is disabled.');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['profile', 'email'],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!USE_GOOGLE_AUTH) return res.status(403).send('Google login is disabled.');
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    res.json({ user: userInfo.data });
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Google authentication failed.');
  }
});

// Check license via Supabase
async function checkLicense(email) {
  const { data, error } = await supabase
    .from('licenses')
    .select('smartemail_tier, smartemail_expires')
    .eq('email', email)
    .maybeSingle();

  if (error || !data) return { tier: 'free', reason: 'not found' };
  return {
    tier: data.smartemail_tier || 'free',
    expires: data.smartemail_expires || null,
  };
}

// ✅ FIXED: SmartEmail-Compatible /generate route
app.post('/generate', async (req, res) => {
  const {
    email,
    emailType,
    tone,
    language,
    audience,
    content,
    agent,
    action
  } = req.body;
// 🧠 SmartEmail compatibility aliasing (non-breaking)
const finalEmailType = req.body.email_type || emailType;
const finalContent = req.body.email_content || content;
const finalAudience = req.body.target_audience || audience;
const finalAgent = req.body.sender_details || agent;
const finalLanguage = req.body.language || language;
const finalTone = req.body.tone || tone;
const finalAction = req.body.action || action;
const finalEmail = req.body.email || email; // for safety  
const license = await checkLicense(email);
// ✅ Step 1: check for license-check early
if (req.body?.content === 'license-check' && req.body?.email) {
  const license = await checkLicense(req.body.email);
  return res.json({ tier: license.tier || 'free' });
}

// ✅ Step 2: enforce full payload for real generation

if (!finalEmail || !finalEmailType || !finalTone || !finalLanguage || !finalAudience || !finalContent) {
  return res.status(400).json({ error: 'Missing required fields.' });
}

  if (license.tier === 'free') {
    return res.status(403).json({ error: 'Upgrade required for this feature.' });
  }

const prompt = `
You are an expert AI email copywriter.

Write a "${finalEmailType}" email in "${language}".
Target Audience: ${audience}
Sender: ${finalAgent}

Base Email Content:
***
${finalContent}
***
`

${agent ? `Sign off using this sender block:\n${agent}` : ''}
`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
    });

    const result = await response.json();
    const reply = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '';

    await supabase.from('leads').insert([
      {
        email,
        original_message: content,
        generated_reply: reply,
        product: 'SmartEmail',
      },
    ]);

    res.json({ reply, tier: license.tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Stripe Webhook
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const tier_map = {
  'prod_SMARTEMAIL_BASIC': { tier: 'pro', durationDays: 30 },
  'prod_SMARTEMAIL_PREMIUM': { tier: 'premium', durationDays: 90 }
};

app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details.email;
    const productId = session.metadata?.product_id;
    const match = tier_map[productId];

    if (!match) {
      console.warn(`Unknown SmartEmail product ID: ${productId}`);
      return res.sendStatus(200);
    }

    const { tier, durationDays } = match;
    const newExpiry = new Date();
    newExpiry.setDate(newExpiry.getDate() + durationDays);

    const { error } = await supabase
      .from('licenses')
      .upsert(
        {
          email,
          smartemail_tier: tier,
          smartemail_expires: newExpiry.toISOString(),
        },
        { onConflict: ['email'] }
      );

    if (error) {
      console.error('Error upgrading SmartEmail license:', error);
      return res.sendStatus(500);
    }

    console.log(`SmartEmail license upgraded: ${email} → ${tier}`);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
