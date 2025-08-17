// routes/imapRoutes.js
import express from 'express';
import { fetchEmails } from '../services/imapService.js';
import { getLicenseByEmail } from '../services/licenseService.js';

export const imapRouter = express.Router();

/**
 * POST /imap/fetch
 * body: { email, password, host, port, provider, limit, range, tls }
 */
imapRouter.post('/fetch', async (req, res) => {
  const {
    email,
    password,
    host = 'imap.gmail.com',
    port = 993,
    provider = 'Gmail',
    limit: limitIn,
    range,             // 'All' | 'Last7d' | 'Last30d' etc.
    tls = true,
  } = req.body || {};

  // Resolve tier correctly: smartemail_tier only; never read "tier"
  const license = await getLicenseByEmail(email);
  const tier = (license?.smartemail_tier || '').toLowerCase() || 'free';

  // Enforce tier caps (UI shows badge from this same decision)
  const isPremium = tier === 'premium';
  const hardLimit = Math.min(Number(limitIn || 20), isPremium ? 200 : 20);

  // Translate UI "Range" to days
  const daysRange = (() => {
    if (range === 'All') return isPremium ? 30 : 7; // protect free from huge scans
    if (typeof range === 'number') return Math.max(1, range);
    if (range === 'Last30d') return 30;
    if (range === 'Last7d') return 7;
    return isPremium ? 30 : 7;
  })();

  const result = await fetchEmails({
    host,
    port,
    tls,
    user: email,
    password,
    daysRange,
    limit: hardLimit,
  });

  if (!result.ok) {
    // Map specific codes to HTTP & messages you saw in the UI
    const map = {
      BAD_SINCE: { status: 400, msg: 'Server rejected date filter. Try a shorter range.' },
      TLS:       { status: 502, msg: 'TLS trust failed to remote server.' },
      TIMEOUT:   { status: 504, msg: 'IMAP timed out. Try a shorter range or retry.' },
      IMAP:      { status: 500, msg: result.message || 'IMAP error.' },
    };
    const info = map[result.code] || map.IMAP;
    return res.status(info.status).json({ ok: false, error: info.msg });
  }

  return res.json({
    ok: true,
    tier: isPremium ? 'premium' : 'free',
    limit: hardLimit,
    rangeDays: daysRange,
    items: result.items,
  });
});
