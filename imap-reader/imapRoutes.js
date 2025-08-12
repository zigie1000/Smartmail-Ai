// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';

const router = express.Router();

router.post('/fetch', async (req, res) => {
  try {
    const {
      email, password, host, port,
      tls = true,
      rangeDays = 2,
      limit = 50,
      authType = 'password',
      accessToken
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ success: false, error: 'Missing email, host, or port' });
    }
    if (authType === 'password' && !password) {
      return res.status(400).json({ success: false, error: 'Password/App Password required' });
    }
    if (authType === 'xoauth2' && !accessToken) {
      return res.status(400).json({ success: false, error: 'Access token required for XOAUTH2' });
    }

    // Build IMAP criteria (SINCE N days) — 0 means ALL
    let criteria = ['ALL'];
    const n = Number(rangeDays);
    if (Number.isFinite(n) && n > 0) {
      const since = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
      criteria = ['SINCE', since];
    }

    const emails = await fetchEmails({
      email,
      password,
      host,
      port,
      criteria,
      limit,
      tls: !!tls,
      authType,
      accessToken
    });

    return res.json({ success: true, emails });
  } catch (err) {
    console.error('IMAP fetch failed:', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'IMAP fetch failed' });
  }
});

export default router;
