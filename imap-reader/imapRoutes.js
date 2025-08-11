// imapRoutes.js — IMAP API only (no HTML here)

import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

// Simple health check for API namespace
router.get('/', (req, res) => {
  res.status(200).json({ success: true, message: 'IMAP API is live' });
});

// POST /api/imap/fetch
router.post('/fetch', async (req, res) => {
  try {
    const { email, password, host, port, criteria, limit } = req.body;
    const rawEmails = await fetchEmails({ email, password, host, port, criteria, limit });
    const classified = await classifyEmails(rawEmails);
    res.json({ success: true, emails: classified });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'IMAP fetch failed' });
  }
});

export default router;
