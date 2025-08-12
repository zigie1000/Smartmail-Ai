// routes/microsoft.js
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { getTokensFor, refreshMicrosoftToken } from '../helpers/msAuth.js';

dotenv.config();

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Step 5) Graph read helper
async function listInbox(accessToken) {
  const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=25', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Graph inbox error: ${r.status} ${t}`);
  }
  return r.json(); // { value: [...] }
}

// Quick “hello” route (optional)
router.get('/api/ms/profile', async (req, res) => {
  try {
    const email = String(req.query.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query required' });

    const row = await getTokensFor(email);
    if (!row) return res.status(404).json({ error: 'No tokens stored for this email' });

    // refresh if needed
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    let accessToken = row.access_token;

    if (!accessToken || Date.now() > exp - 60 * 1000) {
      const fresh = await refreshMicrosoftToken(row.refresh_token);
      accessToken = fresh.access_token;

      // save back
      const expiresAt = new Date(Date.now() + (Number(fresh.expires_in) || 3600) * 1000 - 30 * 1000);
      await supabase
        .from('oauth_tokens')
        .upsert(
          {
            provider: 'microsoft',
            email,
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token || row.refresh_token,
            scope: fresh.scope || row.scope,
            expires_at: expiresAt.toISOString()
          },
          { onConflict: 'provider,email' }
        );
    }

    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const me = await meRes.json();
    if (!meRes.ok) throw new Error(me.error?.message || 'Graph /me failed');

    res.json(me);
  } catch (e) {
    res.status(500).json({ error: e.message || 'profile error' });
  }
});

// Main: list inbox for stored account
router.get('/api/ms/inbox', async (req, res) => {
  try {
    const email = String(req.query.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'email query required' });

    const row = await getTokensFor(email);
    if (!row) return res.status(404).json({ error: 'No tokens stored for this email' });

    // Refresh if expiring
    const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    let accessToken = row.access_token;

    if (!accessToken || Date.now() > exp - 60 * 1000) {
      const fresh = await refreshMicrosoftToken(row.refresh_token);
      accessToken = fresh.access_token;

      const expiresAt = new Date(Date.now() + (Number(fresh.expires_in) || 3600) * 1000 - 30 * 1000);
      await supabase
        .from('oauth_tokens')
        .upsert(
          {
            provider: 'microsoft',
            email,
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token || row.refresh_token,
            scope: fresh.scope || row.scope,
            expires_at: expiresAt.toISOString()
          },
          { onConflict: 'provider,email' }
        );
    }

    const inbox = await listInbox(accessToken);
    res.json(inbox);
  } catch (e) {
    res.status(500).json({ error: e.message || 'inbox error' });
  }
});

export default router;
