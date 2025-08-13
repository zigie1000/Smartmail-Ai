// imap-reader/imapRoutes.js (fixed & backward-compatible)
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from '../emailClassifier.js';

const router = express.Router();

/** Date -> DD-Mon-YYYY (UTC) for IMAP SINCE */
function toImapSince(dateObj) {
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const y = dateObj.getUTCFullYear();
  return `${d}-${mon}-${y}`;
}

/** Build IMAP search criteria safely */
function buildCriteria(rangeDays){
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    return ['SINCE', since];
  }
  return ['ALL'];
}

/** Existing endpoint (kept) */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email, password, host, port = 993,
      limit = 50, rangeDays = 2,
      authType = 'password', accessToken = '',
      tls = true
    } = req.body || {};

    if (!email || !host || !port) return res.status(400).json({ success:false, error:'Email, host and port are required.' });
    if (authType === 'password' && !password) return res.status(400).json({ success:false, error:'Password/App Password required.' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ success:false, error:'Access token required for XOAUTH2.' });

    const criteria = buildCriteria(rangeDays);

    const emails = await fetchEmails({
      email, password, host, port: Number(port)||993,
      criteria, limit: Number(limit)||50, tls: !!tls,
      authType, accessToken
    });

    return res.json({ success:true, emails });
  } catch (err) {
    console.error('IMAP /fetch error:', err?.message||err);
    return res.status(502).json({ success:false, error: err?.message || 'IMAP fetch failed' });
  }
});

/** New: GET /list to match UI expectations */
router.get('/list', async (req, res) => {
  try {
    const {
      email, password, host,
      port = '993', limit = '50',
      range = '2', authType = 'password',
      accessToken = '', tls = 'on'
    } = req.query || {};

    if (!email || !host || !port) return res.status(400).json({ success:false, error:'Email, host and port are required.' });
    if (authType === 'password' && !password) return res.status(400).json({ success:false, error:'Password/App Password required.' });
    if (authType === 'xoauth2' && !accessToken) return res.status(400).json({ success:false, error:'Access token required for XOAUTH2.' });

    const criteria = buildCriteria(range);
    const tlsOn = String(tls).toLowerCase() !== 'off';

    const emails = await fetchEmails({
      email, password, host, port: Number(port)||993,
      criteria, limit: Number(limit)||50, tls: tlsOn,
      authType, accessToken
    });

    // Normalize a minimal shape for clients (id & snippet)
    const out = (emails||[]).map((m, i) => ({
      id: m.uid || m.id || String(i+1),
      from: m.from || '',
      to: m.to || '',
      subject: m.subject || '(no subject)',
      date: m.date || m.internalDate || null,
      snippet: (m.text || '').slice(0, 500),
      importance: m.importance || 'unimportant'
    }));

    return res.json({ success:true, emails: out });
  } catch (err) {
    console.error('IMAP /list error:', err?.message||err);
    return res.status(502).json({ success:false, error: err?.message || 'IMAP list failed' });
  }
});

/** New: POST /classify to run emailClassifier on the fetched messages */
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
      snippet: e.snippet || ''
    }));

    const results = await classifyEmails(normalized);
    return res.json(results);
  } catch (err) {
    console.error('IMAP /classify error:', err?.message||err);
    return res.status(500).json({ error: 'Classification failed' });
  }
});

export default router;
