import express from 'express';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Google OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Scopes for Gmail access
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// 1️⃣ Route: /auth/google → Initiates login
router.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
  res.redirect(authUrl);
});

// 2️⃣ Route: /auth/google/callback → Handles Google's response
router.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Optionally: store access_token/refresh_token in DB or Supabase
    // For now, return it for testing
    res.json({
      message: '✅ Gmail OAuth successful',
      tokens,
    });
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

export default router;
