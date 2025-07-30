// server/server.js

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Supabase setup with secure SERVICE_KEY
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// License check
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

// POST /generate
app.post('/generate', async (req, res) => {
  const { email, content } = req.body;

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

  const prompt = `Reply professionally to this email:\n\n"${content}"`;

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

    // Store lead
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

app.listen(PORT, () => {
  console.log(`✅ SmartEmail backend running on port ${PORT}`);
});
