// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';

const router = express.Router();

/** Date -> DD-Mon-YYYY (UTC) for IMAP SINCE */
function toImapSince(dateObj) {
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const y = dateObj.getUTCFullYear();
  return `${d}-${mon}-${y}`;
}

router.post('/fetch', async (req, res) => {
  try {
    const {
      email,
      password,
      host,
      port = 993,
      limit = 50,
      rangeDays = 2,
      authType = 'password',
      accessToken,
      tls = true
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ success: false, error: 'Email, host and port are required.' });
    }
    if (authType === 'password' && !password) {
      return res.status(400).json({ success: false, error: 'Password/App Password required.' });
    }
    if (authType === 'xoauth2' && !accessToken) {
      return res.status(400).json({ success: false, error: 'Access token required for XOAUTH2.' });
    }

    // Build criteria safely (avoid "Incorrect number of arguments for search option: SINCE")
    let criteria = ['ALL'];
    const days = Number(rangeDays);
    if (Number.isFinite(days) && days > 0) {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - days);
      criteria = ['SINCE', toImapSince(since)];
    }

    const emails = await fetchEmails({
      email,
      password,
      host,
      port: Number(port) || 993,
      criteria,
      limit: Number(limit) || 50
      // NOTE: imapService currently uses user/pass TLS. XOAUTH2 wiring can be added later.
    });

    return res.json({ success: true, emails });
  } catch (err) {
    const message = err?.message || 'IMAP fetch failed';
    console.error('IMAP /fetch error:', message);
    return res.status(502).json({ success: false, error: message });
  }
});

export default router;
