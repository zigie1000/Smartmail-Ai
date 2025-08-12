// imap-reader/imapRoutes.js
import { Router } from 'express';
import { fetchEmails } from './imapService.js';

const router = Router();

/**
 * POST /api/imap/fetch
 * Body: { email, password, host, port, tls, rangeDays, limit, authType, accessToken }
 */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email, password, host,
      port = 993,
      tls = true,
      rangeDays = 2,
      limit = 50,
      authType = 'password',
      accessToken = ''
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ success: false, error: 'Missing email, host or port' });
    }
    if (authType === 'password' && !password) {
      return res.status(400).json({ success: false, error: 'Missing password/app password' });
    }
    if (authType === 'xoauth2' && !accessToken) {
      return res.status(400).json({ success: false, error: 'Missing access token for XOAUTH2' });
    }

    // Build IMAP criteria: last N days or ALL
    let criteria = ['ALL'];
    const days = Number(rangeDays);
    if (Number.isFinite(days) && days > 0) {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days);
      criteria = ['SINCE', since]; // imapService normalizes to DD-Mon-YYYY
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
    console.error('IMAP fetch error:', err?.message || err);
    return res.status(500).json({ success: false, error: err?.message || 'IMAP error' });
  }
});

export default router;
