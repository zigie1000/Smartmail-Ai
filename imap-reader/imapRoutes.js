// imap-reader/imapRoutes.js — caps, login probe, clear errors
import express from 'express';
import { fetchEmails, testLogin } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

// ---- Defaults & caps (keep requests small/fast) ----
const DEFAULT_RANGE_DAYS = 2;
const DEFAULT_LIMIT      = 20;
const MAX_RANGE_DAYS     = 7;   // cap to 1 week unless user explicitly changes
const MAX_LIMIT          = 50;

function clamp(n, lo, hi){
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo;
}

/** Build IMAP search criteria safely */
function buildCriteria(rangeDays){
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    // imapService will normalize Date in search() call
    return ['SINCE', since];
  }
  return ['ALL'];
}

/** POST /api/imap/test — attempts login only and returns exact reason */
router.post('/test', async (req, res) => {
  try {
    const {
      email, password, host, port = 993,
      authType = 'password', accessToken = '', tls = true
    } = req.body || {};

    if (!email || !host) return res.status(400).json({ ok:false, error:'Email and host required' });
    if (authType === 'password' && !password) return res.status(400).json({ ok:false, error:'Password/App Password required' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ ok:false, error:'Access token required for XOAUTH2' });

    await testLogin({ email, password, host, port: Number(port)||993, tls: !!tls, authType, accessToken });
    return res.json({ ok:true, message:'Login OK' });
  } catch (e) {
    return res.status(401).json({ ok:false, error: e?.message || 'Auth failed' });
  }
});

/** POST /api/imap/fetch — main fetch (uses caps) */
router.post('/fetch', async (req, res) => {
  try {
    let {
      email, password, host, port = 993,
      limit = DEFAULT_LIMIT, rangeDays = DEFAULT_RANGE_DAYS,
      authType = 'password', accessToken = '',
      tls = true
    } = req.body || {};

    // clamp user input
    limit = clamp(limit, 1, MAX_LIMIT);
    rangeDays = clamp(rangeDays, 0, MAX_RANGE_DAYS);

    if (!email || !host || !port) return res.status(400).json({ success:false, error:'Email, host and port are required.' });
    if (authType === 'password' && !password) return res.status(400).json({ success:false, error:'Password/App Password required.' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ success:false, error:'Access token required for XOAUTH2.' });

    const criteria = buildCriteria(rangeDays);

    const emails = await fetchEmails({
      email, password, host, port: Number(port)||993,
      criteria, limit, tls: !!tls, authType, accessToken
    });

    return res.json({ success:true, emails });
  } catch (err) {
    console.error('IMAP /fetch error:', err?.message||err);
    return res.status(502).json({ success:false, error: err?.message || 'IMAP fetch failed' });
  }
});

/** GET /api/imap/list — for clients that still use GET (also capped) */
router.get('/list', async (req, res) => {
  try {
    let {
      email, password, host,
      port = '993', limit = String(DEFAULT_LIMIT),
      range = String(DEFAULT_RANGE_DAYS), authType = 'password',
      accessToken = '', tls = 'on'
    } = req.query || {};

    const limitNum = clamp(limit, 1, MAX_LIMIT);
    const rangeNum = clamp(range, 0, MAX_RANGE_DAYS);

    if (!email || !host || !port) return res.status(400).json({ success:false, error:'Email, host and port are required.' });
    if (authType === 'password' && !password) return res.status(400).json({ success:false, error:'Password/App Password required.' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ success:false, error:'Access token required for XOAUTH2.' });

    const criteria = buildCriteria(rangeNum);
    const tlsOn = String(tls).toLowerCase() !== 'off';

    const emails = await fetchEmails({
      email, password, host, port: Number(port)||993,
      criteria, limit: limitNum, tls: tlsOn, authType, accessToken
    });

    const out = (emails||[]).map((m, i) => ({
      id: m.uid || m.id || String(i+1),
      from: m.from || '',
      to: m.to || '',
      subject: m.subject || '(no subject)',
      date: m.date || m.internalDate || null,
      snippet: (m.text || '').slice(0, 500),
      importance: m.importance || 'unimportant',
      intent: m.intent,
      urgency: m.urgency,
      action_required: m.action_required,
      reasons: m.reasons
    }));

    return res.json({ success:true, emails: out });
  } catch (err) {
    console.error('IMAP /list error:', err?.message||err);
    return res.status(502).json({ success:false, error: err?.message || 'IMAP list failed' });
  }
});

/** POST /api/imap/classify — runs the classifier */
router.post('/classify', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json([]);

    // truncate snippet defensively before model
    const normalized = items.map(e => ({
      subject: e.subject || '',
      from: e.from || '',
      fromEmail: (e.from || '').split('<').pop().replace('>','').trim(),
      fromDomain: (e.from || '').split('@').pop()?.replace(/[^a-z0-9\.-]/ig,'') || '',
      to: e.to || '',
      cc: e.cc || '',
      date: e.date || '',
      snippet: (e.snippet || e.text || '').slice(0, 500)
    }));

    const results = await classifyEmails(normalized);
    return res.json(Array.isArray(results) ? results : []);
  } catch (err) {
    console.error('IMAP /classify error:', err?.message||err);
    return res.status(500).json({ error: 'Classification failed' });
  }
});

export default router;
