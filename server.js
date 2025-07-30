// server.js

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const USE_GOOGLE_AUTH = process.env.USE_GOOGLE_AUTH === 'true';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ------------------ PATH SETUP FOR FRONTEND ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ------------------ GOOGLE OAUTH ------------------
let oauth2Client;
if (USE_GOOGLE_AUTH) {
  oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ------------------ AI PROMPT ------------------
function generateAIPrompt(content, action = 'generate') {
  if (action === 'enhance') {
    return `Enhance the professionalism, clarity, and tone of the following email:\n\n"${content}"`;
  }
  return `Reply professionally to this email:\n\n"${content}"`;
}

// ------------------ MAIN PAGE ------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    googleLogin: USE_GOOGLE_AUTH,
    mode: 'SmartEmail',
  });
});

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

// ------------------ LICENSE ------------------
async function checkLicense(email) {
  const { data, error } = await supabase
    .from('licenses')
    .select('tier, product')
    .eq('email', email)
    .maybeSingle();

  if (error || !data) return { tier: 'free', reason: 'not found' };

  return {
    tier: data.tier,
    product: data.product || 'SmartEmail',
  };
}

// ------------------ AI GENERATION ------------------
app.post('/generate', async (req, res) => {
  const { email, content, action } = req.body;

  if (!email || !content) {
    return res.status(400).json({ error: 'Missing email or content' });
  }

  const license = await checkLicense(email);

  if (content === 'license-check') {
    return res.json({ tier: license.tier });
  }

  if (license.tier === 'free') {
    return res.status(403).json({ error: 'Upgrade required for this feature.' });
  }

  const prompt = generateAIPrompt(content, action);

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
    const reply = result.choices?.[0]?.message?.content || '';

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

// ------------------ SECONDARY RESPONSE ROUTE ------------------
app.post('/api/respond', async (req, res) => {
  const { email, action } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid email content' });
  }

  const prompt = generateAIPrompt(email, action);

  try {
    const aiResponse = await fetch("https://api.openai.com/v1/completions", {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-davinci-003',
        prompt,
        temperature: 0.6,
        max_tokens: 250
      })
    });

    const data = await aiResponse.json();

    if (!data || !data.choices || !data.choices[0]) {
      throw new Error('Invalid OpenAI response');
    }

    res.json({
      success: true,
      response: data.choices[0].text.trim()
    });

  } catch (err) {
    console.error('AI respond error:', err);
    res.status(500).json({ error: 'AI processing failed' });
  }
});

// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`✅ SmartEmail backend running on port ${PORT}`);
});
