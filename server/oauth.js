// server/oauth.js
import express from 'express';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Scopes: read-only access to Gmail
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Step 1: Redirect user to Google's OAuth 2.0 server
router.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

// Step 2: Handle OAuth2 callback
router.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;

  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // You now have tokens.access_token and tokens.refresh_token
    // Store securely in DB or session (not plain localStorage in production)
    return res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expiry_date
    });
  } catch (err) {
    console.error('OAuth Error:', err);
    res.status(500).send('OAuth callback failed');
  }
});

export default router;
