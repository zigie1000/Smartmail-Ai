// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from '../emailClassifier.js';

const router = express.Router();

/** Build IMAP search criteria safely (Date object, not string) */
function buildCriteria(rangeDays) {
  const n = Number(rangeDays);
  if (Number.isFinite(n) && n > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - n);
    return ['SINCE', since];
  }
  return ['ALL'];
}

/** Common input checks (no provider-specific gating) */
function validateCommon(body = {}) {
  const { email, password, host, port, authType = 'password', accessToken = '' } = body;
  if (!email || !host || !port) return 'Email, host and port are required.';
  if (authType === 'password' && !password) return 'Password/App Password required.';
  if (authType === 'xoauth2' && !accessToken) return 'Access token required for XOAUTH2.';
  return null;
}

/** POST /api/imap/fetch — fetch + parse emails */
router.post('/fetch', async (req, res) => {
  try {
    const err = validateCommon(req.body);
    if (err) return res.status(400).json({ success: false, error: err });

    const {
      email, password, host,
      port = 993, tls = true,
      rangeDays = 2, limit = 50,
      authType = 'password', accessToken = ''
    } = req.body;

    const emails = await fetchEmails({
      email,
      password,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      criteria: buildCriteria(rangeDays),
      limit: Number(limit) || 50,
      authType,
      accessToken
    });

    return res.json({ success: true, emails });
  } catch (e) {
    const message = e?.message || 'IMAP fetch failed';
    console.error('IMAP /fetch error:', message);
    return res.status(502).json({ success: false, error: message });
  }
});

/** POST /api/imap/test — fast handshake check (login + openBox) */
router.post('/test', async (req, res) => {
  try {
    const err = validateCommon(req.body);
    if (err) return res.status(400).json({ ok: false, error: err });

    const {
      email, password, host,
      port = 993, tls = true,
      authType = 'password', accessToken = ''
    } = req.body;

    // Do a tiny search (1 msg) to validate everything works end-to-end.
    await fetchEmails({
      email,
      password,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      criteria: ['ALL'],
      limit: 1,
      authType,
      accessToken
    });

    return res.json({ ok: true });
  } catch (e) {
    const message = e?.message || 'Login failed';
    console.error('IMAP /test error:', message);
    // 200 with ok:false lets the UI show the exact server message without throwing.
    return res.status(200).json({ ok: false, error: message });
  }
});

/** POST /api/imap/classify — run the lightweight classifier on items */
router.post('/classify', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json([]);

    const normalized = items.map(e => ({
      subject: e.subject || '',
      from: e.from || '',
      fromEmail: (e.from || '').split('<').pop().replace('>','').trim(),
      fromDomain: (e.from || '').split('@').pop()?.replace(/[^a-z0-9\.-]/ig,'') || '',
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
