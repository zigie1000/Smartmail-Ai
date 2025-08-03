// server.js (SmartEmail Restored Full Functionality)

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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const USE_GOOGLE_AUTH = process.env.USE_GOOGLE_AUTH === 'true';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use('/webhook', stripeWebHook);
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
// Check license via Supabase
async function checkLicense(email) {
  try {
  const { data, error } = await supabase
    .from('licenses')
    .select('smartemail_tier, smartemail_expires')
    .eq('email', email)
    .maybeSingle();

  if (error || !data) {
    return { tier: 'free', reason: 'not found' };
  }

  const now = new Date();
  const expiry = data.smartemail_expires ? new Date(data.smartemail_expires) : null;

  if (expiry && expiry < now) {
    await supabase
      .from('licenses')
      .update({ smartemail_tier: 'free' })
      .eq('email', email);

    return { tier: 'free', reason: 'expired' };
  }

  return {
    tier: data?.smartemail_tier || 'free',
    expires: data?.smartemail_expires || null,
    status: 'active'
  };

} catch (err) {
  console.error("❌ Supabase checkLicense error:", {
    email,
    message: err.message,
    stack: err.stack
  });
  return {
    tier: 'free',
    reason: 'error',
    debug: err.message || 'unknown server error'
  };
}
}
}

// New endpoint: Allow frontend to check license by email
app.post('/check-license', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ tier: 'free', reason: 'missing email' });

  const license = await checkLicense(email);
  return res.json(license);
});

// ✅ New GET endpoint for frontend license check
app.get('/validate-license', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ status: 'error', reason: 'Missing email' });
  }

  try {
    const license = await checkLicense(email);
    return res.json({
      status: 'ok',
      tier: license.tier,
      reason: license.reason || null,
      expires: license.expires || null
    });
  } catch (err) {
    console.error("❌ /validate-license error:", err.message || err);
    return res.status(500).json({
      status: 'error',
      reason: 'server failure',
      debug: err.message || 'unknown error'
    });
  }
});


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
const license = await checkLicense(finalEmail);
// ✅ Step 1: check for license-check early
if (req.body?.content === 'license-check') {
  return res.json({ tier: license.tier || 'free' });
}

// ✅ Step 2: enforce full payload for real generation

if (!finalEmail || !finalEmailType || !finalTone || !finalLanguage || !finalAudience || !finalContent) {
  return res.status(400).json({ error: 'Missing required fields.' });
}

  // ✅ Free tier users are allowed to generate
console.log(`Tier: ${license.tier} — generation allowed for all users`);
  
const agentInfo = finalAgent ? `\n👤 **Sender Information:**\n${finalAgent}` : '';

const prompt = `
You are a senior email copywriter helping a user write a reply email.

The user received this message and wants to respond to it:
"""
${finalContent}
"""

Write a professional reply email using the following creative brief:

- **Email Type:** ${finalEmailType}
- **Tone and Style:** ${finalTone}
- **Target Audience:** ${finalAudience}
- **Primary Goal / Call-to-Action:** ${finalAction}
- **Language:** ${finalLanguage}

Please follow these instructions:
- Write in a clear and persuasive tone aligned with ${finalTone}.
- Ensure the response is appropriate for ${finalAudience}.
- Keep it concise, professional, and suitable for email communication.
- Include a greeting, body, and closing.
- End with a strong sign-off.

${finalAgent ? '**Sender Info:**\n' + finalAgent : ''}
`.trim();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: "gpt-4-1106-preview",
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
    });

    const result = await response.json();
    const reply = (result.choices?.[0]?.message?.content || '').trim();

if (!reply) {
  console.error("❌ OpenAI returned an empty reply. Response:", JSON.stringify(result, null, 2));
  return res.status(500).json({ error: 'AI failed to generate a response.' });
}
    try {
  await supabase.from('leads').insert([
    {
      email: finalEmail,
      original_message: finalContent,
      generated_reply: reply,
      product: 'SmartEmail',
    },
  ]);
} catch (logErr) {
  console.warn('Non-fatal: Failed to insert lead into Supabase:', logErr.message);
}
    res.json({ generatedEmail: reply, tier: license.tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ✅ SmartEmail: Enhancement endpoint (Pro and Premium only)
app.post('/enhance', async (req, res) => {
  const { email, enhance_request, enhance_content } = req.body;

  if (!email || !enhance_request || !enhance_content) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const license = await checkLicense(email);

    console.log('✅ Retrieved license tier:', license?.tier); // useful debug

    if (!license || !license.tier || !['pro', 'premium'].includes(license.tier.toLowerCase())) {
      return res.status(403).json({ error: 'Enhancement is only available for Pro and Premium users.' });
    }

    const enhancePrompt = `
You are an AI email enhancement assistant. A user has generated an email and requested a specific improvement.

📩 **Original Email:**
${enhance_content}

🔧 **User Enhancement Request:**
${enhance_request}

✍️ **Instructions**
- Rewrite or modify the original email based on the enhancement request.
- Maintain professional tone and formatting.
- Make the email more effective, clear, and impactful where appropriate.
- Only change what’s necessary based on the request.
`.trim();

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

    if (!reply) {
      console.error('❌ Enhancement failed. AI returned empty.', JSON.stringify(result, null, 2));
      return res.status(500).json({ error: 'AI failed to enhance content.' });
    }

    try {
      await supabase.from('enhancements').insert([
        {
          email,
          original_text: enhance_content,
          enhancement_prompt: enhance_request,
          enhanced_result: reply,
          product: 'SmartEmail'
        }
      ]);
    } catch (logErr) {
      console.warn('Non-fatal: Failed to log enhancement:', logErr.message);
    }

    res.json({ generatedEmail: reply, tier: license.tier });
  } catch (err) {
    console.error('❌ OpenAI enhancement error:', err.message || err);
    res.status(500).json({ error: 'Something went wrong while enhancing the content.' });
  }
});

// Stripe Webhook

/*const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
});*/

// ✅ License validation endpoint used by frontend
app.get('/validate-license', async (req, res) => {
  const { email, licenseKey } = req.query;

let tier = "free"; // default
let status = "inactive";
let userEmail = "";

const { data, error } = await supabase
  .from("smartemail_licenses")
  .select("email, tier, status")
  .or(`license_key.eq.${licenseKey},email.eq.${email}`)
  .single();

if (data && data.status === "active") {
  tier = data.tier || "free";
  status = "active";
  userEmail = data.email || email;
}
  
  if (!email && !licenseKey) {
    return res.status(400).json({ error: 'Missing email or licenseKey' });
  }

  try {
    const { data, error } = await supabase
      .from('licenses')
      .select('smartemail_tier, smartemail_expires, license_key, email')
      .or(`email.eq.${email},license_key.eq.${licenseKey}`)
      .maybeSingle();

    if (error || !data) {
      return res.json({ status: "not_found", tier: "free" });
    }

const now = new Date();
const expiry = data?.smartemail_expires ? new Date(data.smartemail_expires) : null;
const isActive = expiry ? expiry >= now : false;

    res.json({
  tier: data.smartemail_tier || "free",
  status: expiry ? (isActive ? "active" : "expired") : "unknown",
  email: data.email || null
});
  } catch (err) {
    console.error("❌ Error in validate-license:", err.message || err);
    res.status(500).json({ error: "Validation failed" });
  }
});

app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
