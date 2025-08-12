// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';

const router = express.Router();

/**
 * POST /api/imap/fetch
 * Body: {
 *   email, password, host, port,
 *   tls=true|false,
 *   rangeDays=2,         // number of days back; 0 or missing => ALL
 *   limit=200,
 *   authType='password', // or 'xoauth2'
 *   accessToken          // required if authType==='xoauth2'
 * }
 */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email = '',
      password = '',
      host = '',
      port = 993,
      tls = true,
      rangeDays = 2,
      limit = 200,
      authType = 'password',
      accessToken = ''
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ success: false, error: 'Missing email, host or port.' });
    }
    if (authType === 'password' && !password) {
      return res.status(400).json({ success: false, error: 'Password/App Password required.' });
    }
    if (authType === 'xoauth2' && !accessToken) {
      return res.status(400).json({ success: false, error: 'Access token required for XOAUTH2.' });
    }

    // Build IMAP search criteria
    let criteria = ['ALL'];
    const nDays = Number(rangeDays);
    if (!Number.isNaN(nDays) && nDays > 0) {
      const since = new Date();
      since.setDate(since.getDate() - nDays);
      criteria = ['SINCE', since]; // imapService will normalize Date → "DD-Mon-YYYY"
    }

    const emails = await fetchEmails({
      email,
      password,
      host,
      port,
      tls,
      criteria,
      limit,
      authType,
      accessToken
    });

    return res.json({ success: true, emails });
  } catch (err) {
    const message = err?.message || String(err);
    console.error('IMAP fetch failed:', message);
    // ⬇️ Return the real reason so the UI can show it instead of a generic 502.
    return res.status(502).json({
      success: false,
      error: message,
      code: 'IMAP_FETCH_FAILED'
    });
  }
});

// Optional: quick health probe for your logs/monitoring
router.get('/health', (_req, res) => res.json({ ok: true }));

export default router;
