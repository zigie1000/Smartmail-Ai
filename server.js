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

// ✅ Ensure email is saved if not found
async function saveEmailToDB(email) {
  const { data, error } = await supabase
    .from('licenses')
    .insert([{ email: email, tier: 'free' }], { upsert: false });

  if (error) {
    console.error("❌ Error inserting email:", error);
  } else {
    console.log("✅ Email saved to DB:", email);
  }
}

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
async function checkLicense(email) {
  const { data, error } = await supabase
    .from('licenses')
    .select('smartemail_tier, smartemail_expires')
    .eq('email', email)
    .maybeSingle();
  
const isFree = (data.smartemail_tier || 'free') === 'free';
const expiry = data.smartemail_expires ? new Date(data.smartemail_expires) : null;
const isActive = isFree ? true : (expiry && expiry >= new Date());
  
  if (error || !data) {
    console.warn(`⚠️ License not found for ${email}. Inserting as free tier...`);

// ✅ Save free-tier email to SQL if not already present
if (email) {
  const { data: existing } = await supabase
    .from('licenses')
    .select('email')
    .eq('email', email)
    .maybeSingle();

  if (!existing) {
    await supabase.from('licenses').insert([
      {
        email: email,
        smartemail_tier: 'free',
        smartemail_expires: null
      }
    ]);
    console.log(`📩 Free-tier email saved to SQL: ${email}`);
  }
}

    const insertResult = await supabase
  .from('licenses')
  .upsert(
    {
      email: email.trim().toLowerCase(),
      smartemail_tier: 'free',
      smartemail_expires: null
    },
    { onConflict: 'email' }
  )
  .select(); // ✅ forces Supabase to return the inserted/updated row

if (insertResult.error) {
  console.error('❌ Insert failed:', insertResult.error.message || insertResult.error);
  console.error('❌ Full insertResult:', JSON.stringify(insertResult, null, 2));
  return { tier: 'free', reason: 'insert failed' };
}

    // Recheck license immediately
    const { data: recheckData, error: recheckError } = await supabase
      .from('licenses')
      .select('smartemail_tier, smartemail_expires')
      .eq('email', email)
      .maybeSingle();

    if (recheckError || !recheckData) {
      console.warn(`⚠️ Recheck failed for ${email}. Defaulting to free.`);
      return { tier: 'free', reason: 'recheck failed' };
    }

    return {
      tier: recheckData.smartemail_tier || 'free',
      expires: recheckData.smartemail_expires || null,
      reason: 'fallback inserted and rechecked',
    };

  } else {
    // ✅ License was found on first try
    return {
      tier: data.smartemail_tier || 'free',
      expires: data.smartemail_expires || null,
    };
  }
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
const license = await checkLicense(finalEmail); // ✅ Always defined
// ✅ Step 1: check for license-check early
if (req.body?.content === 'license-check' && req.body?.email) {
  const license = await checkLicense(req.body.email);
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

  const license = await checkLicense(email);

  if (license.tier === 'free') {
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

    res.status(200).json({
  generatedEmail: reply,
  tier: license?.tier || 'free'
});
  } catch (err) {
    console.error('❌ OpenAI enhancement error:', err.message || err);
    res.status(500).json({ error: 'Something went wrong while enhancing the content.' });
  }
});

// ---- Add near other routes ----

// 1) Register free user (what the modal hits)
app.post('/api/register-free-user', async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data, error } = await supabase
      .from('licenses')
      .upsert(
        {
          email,
          smartemail_tier: 'free',
          smartemail_expires: null
        },
        { onConflict: ['email'] }
      )
      .select()
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'DB error', detail: error.message });

    // If it already existed, call it "exists"; otherwise "inserted"
    res.json({ status: data ? 'inserted' : 'exists' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unknown error' });
  }
});

// 2) Config (purchase URLs for buttons)
app.get('/config', (req, res) => {
  res.json({
    PRO_URL: process.env.PRO_URL || '',
    PREMIUM_URL: process.env.PREMIUM_URL || ''
  });
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
      return res.json({ status: 'not_found', tier: 'free' });
    }

    const tier = data.smartemail_tier || 'free';
    const expiry = data.smartemail_expires ? new Date(data.smartemail_expires) : null;
    const isActive = tier === 'free' || (expiry && expiry >= new Date());

    res.json({
      status: isActive ? 'active' : 'expired',
      tier,
      licenseKey: data.license_key || null,
      email: data.email || null
    });
  } catch (err) {
    console.error('❌ Error in validate-license:', err.message || err);
    res.status(500).json({ error: 'Validation failed' });
  }
});


app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
