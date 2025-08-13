// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js'; // keep this path relative to this folder

const router = express.Router();

/** Build IMAP search criteria safely (use a real Date for SINCE) */
function buildCriteria(rangeDays) {
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    return ['SINCE', since]; // imapService will normalize to [['SINCE', Date]]
  }
  return ['ALL'];
}

/**
 * POST /api/imap/fetch
 * Body: { email, password, host, port?, rangeDays?, limit?, tls?, authType?, accessToken? }
 * Defaults: port=993, rangeDays=2, limit=50, tls=true, authType='password'
 */
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

    // Normalize minimal shape expected by the UI
    const out = (emails || []).map((m, i) => ({
      id: m.uid || m.id || String(i + 1),
      from: m.from || '',
      to: m.to || '',
      subject: m.subject || '(no subject)',
      date: m.date || m.internalDate || null,
      text: m.text || '',
      html: m.html || '',
      importance: m.importance || 'unclassified',
      intent: m.intent,
      urgency: m.urgency,
      action_required: m.action_required,
      confidence: m.confidence,
      reasons: m.reasons
    }));

    return res.json({ success: true, emails: out });
  } catch (err) {
    const message = err?.message || 'IMAP fetch failed';
    console.error('IMAP /fetch error:', message);
    return res.status(502).json({ success: false, error: message });
  }
});

/**
 * POST /api/imap/test
 * Light credential check: attempts to connect/open INBOX (no message fetch).
 * Body: { email, password, host, port?, tls?, authType?, accessToken? }
 */
router.post('/test', async (req, res) => {
  try {
    const {
      email, password, host,
      port = 993, authType = 'password',
      accessToken = '', tls = true
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ ok: false, error: 'Email, host and port are required.' });
    }
    if (authType === 'password' && !password) {
      return res.status(400).json({ ok: false, error: 'Password/App Password required.' });
    }
    if (authType === 'xoauth2' && !accessToken) {
      return res.status(400).json({ ok: false, error: 'Access token required for XOAUTH2.' });
    }

    // Reuse fetchEmails with limit 1 to exercise login/openBox flow
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

/**
 * POST /api/imap/classify
 * Body: { items: [{ subject, from, to, cc, date, snippet/text/html, ... }] }
 * Returns array aligned with input (importance/intent/urgency/...).
 */
router.post('/classify', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json([]);

    // Normalize for classifier
    const normalized = items.map(e => {
      const fromText = e.from || '';
      const fromEmail = (fromText.split('<').pop() || '')
        .replace('>', '')
        .trim() || fromText;
      const fromDomain = (fromEmail.split('@')[1] || '')
        .replace(/[^a-z0-9.-]/ig, '')
        .toLowerCase();

      return {
        subject: e.subject || '',
        from: fromText,
        fromEmail,
        fromDomain,
        to: e.to || '',
        cc: e.cc || '',
        date: e.date || '',
        snippet: e.snippet || e.text || '' // keep payload small (no full HTML)
      };
    });

    const results = await classifyEmails(normalized);
    return res.json(results);
  } catch (err) {
    console.error('IMAP /classify error:', err?.message || err);
    return res.status(500).json({ error: 'Classification failed' });
  }
});

export default router;
