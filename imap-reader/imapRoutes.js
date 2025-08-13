// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js'; // ✅ correct relative path

const router = express.Router();

/** Build IMAP search criteria safely */
function buildCriteria(rangeDays) {
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    return ['SINCE', since];
  }
  return ['ALL'];
}

/** POST /fetch — fetch messages (default: last 2 days, limit 50) */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email, password, host,
      port = 993, limit = 50, rangeDays = 2,
      authType = 'password', accessToken = '',
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

    const criteria = buildCriteria(rangeDays);

    const emails = await fetchEmails({
      email,
      password,
      host,
      port: Number(port) || 993,
      criteria,
      limit: Number(limit) || 50,
      tls: !!tls,
      authType,
      accessToken
    });

    // Normalize so filters have something to work with
    const out = (emails || []).map((m, i) => ({
      id: m.uid || m.id || String(i + 1),
      from: m.from || '',
      to: m.to || '',
      subject: m.subject || '(no subject)',
      date: m.date || m.internalDate || null,
      text: m.text || '',
      html: m.html || '',
      // 👇 default anything unknown to "unimportant" (so Filter: Important works)
      importance: (m.importance && String(m.importance).toLowerCase() === 'important')
        ? 'important'
        : 'unimportant'
    }));

    return res.json({ success: true, emails: out });
  } catch (err) {
    const message = err?.message || 'IMAP fetch failed';
    console.error('IMAP /fetch error:', message);
    return res.status(502).json({ success: false, error: message });
  }
});

/** POST /test — can I login & open INBOX (no fetch) */
router.post('/test', async (req, res) => {
  try {
    const {
      email, password, host,
      port = 993, authType = 'password',
      accessToken = '', tls = true
    } = req.body || {};

    if (!email || !host || !port) return res.status(400).json({ ok: false, error: 'Email, host and port are required.' });
    if (authType === 'password' && !password) return res.status(400).json({ ok: false, error: 'Password/App Password required.' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ ok: false, error: 'Access token required for XOAUTH2.' });

    await fetchEmails({
      email,
      password,
      host,
      port: Number(port) || 993,
      criteria: ['ALL'],
      limit: 1,
      tls: !!tls,
      authType,
      accessToken
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e?.message || 'Login failed' });
  }
});

/** POST /classify — classify emails */
router.post('/classify', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json([]);

    const normalized = items.map(e => ({
      subject: e.subject || '',
      from: e.from || '',
      fromEmail: (e.from || '').split('<').pop().replace('>', '').trim(),
      fromDomain: (e.from || '').split('@').pop()?.replace(/[^a-z0-9\.-]/ig, '') || '',
      to: e.to || '',
      cc: e.cc || '',
      date: e.date || '',
      snippet: e.snippet || e.text || ''
    }));

    const results = await classifyEmails(normalized);
    return res.json(results);
  } catch (err) {
    console.error('IMAP /classify error:', err?.message || err);
    return res.status(500).json({ error: 'Classification failed' });
  }
});

export default router;
