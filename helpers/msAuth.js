// helpers/msAuth.js
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const router = express.Router();

// ---- ENV (fallbacks keep things running if you forgot one) ----
const TENANT = process.env.AZURE_TENANT_ID || 'common';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const SCOPES =
  process.env.AZURE_SCOPES ||
  'openid profile email offline_access Mail.Read';
const CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.AZURE_REDIRECT_URI ||
  'https://smartemail.onrender.com/auth/microsoft/callback';

// Supabase (used to store access/refresh tokens per email)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---- Small helpers to persist tokens ----
async function saveTokens({ email, access_token, refresh_token, scope, expires_in }) {
  const expiresAt = new Date(Date.now() + (Number(expires_in) || 3600) * 1000 - 30 * 1000); // minus 30s buffer
  await supabase
    .from('oauth_tokens')
    .upsert(
      {
        provider: 'microsoft',
        email,
        access_token,
        refresh_token,
        scope,
        expires_at: expiresAt.toISOString()
      },
      { onConflict: 'provider,email' }
    );
}

export async function getTokensFor(email) {
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('access_token, refresh_token, scope, expires_at')
    .eq('provider', 'microsoft')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---- Step 4) Refresh helper (exported) ----
export async function refreshMicrosoftToken(refresh_token) {
  if (!refresh_token) throw new Error('Missing refresh_token');

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token,
      scope: SCOPES,
      redirect_uri: REDIRECT_URI
    })
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || 'Microsoft refresh failed');
  }
  return json; // { access_token, refresh_token, expires_in, ... }
}

// ---- OAuth: start sign-in ----
router.get('/auth/microsoft', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES,
    state,
    nonce,
    prompt: 'select_account'
  });

  res.redirect(`${AUTH_BASE}/authorize?${params.toString()}`);
});

// ---- OAuth: callback ----
router.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing authorization code');

    // Exchange code for tokens
    const tokenRes = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES
      })
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('MS token error:', tokens);
      return res.status(500).send(tokens.error_description || 'Token exchange failed');
    }

    // Who is the user?
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const me = await meRes.json();
    if (!meRes.ok) {
      console.error('Graph /me error:', me);
      return res.status(500).send('Failed to read profile');
    }

    const email = me.mail || me.userPrincipalName || '';
    if (!email) return res.status(500).send('Could not determine account email');

    // Persist tokens (per email)
    await saveTokens({
      email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      expires_in: tokens.expires_in
    });

    // Tiny success page
    res.send(`
      <html>
        <body style="font-family:system-ui; padding:20px">
          <h3>Microsoft sign-in successful</h3>
          <p>Connected: <b>${email}</b></p>
          <p>You can close this window and return to the app.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Microsoft OAuth callback error:', err);
    res.status(500).send('Microsoft OAuth callback failed');
  }
});

export default router;
