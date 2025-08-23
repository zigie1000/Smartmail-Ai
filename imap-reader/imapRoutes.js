// imapRoutes.js — IMAP fetch/classify with full-body hydration, month/range,
// VIP & weights, user overrides, plus a batch body endpoint for export.

import express from 'express';
import crypto from 'crypto';
import { fetchEmails, testLogin, getMessageById } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';
import { createClient as createSupabase } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const router = express.Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const userIdFromEmail = (email) => sha256(String(email).trim().toLowerCase());
const isLikelyEmail = (s) => typeof s === 'string' && /\S+@\S+\.\S+/.test(s);

function rowsToSet(rows, key) {
  return new Set((rows || [])
    .map(r => String(r[key] || '').toLowerCase())
    .filter(Boolean));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ---------- Helpers for range windows ---------- */
function startEndFromRangeDays(rangeDays) {
  const now = new Date();
  // End = today 23:59:59Z, Start = end - (days-1)
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const start = new Date(end.getTime() - Math.max(0, (Number(rangeDays) || 0) - 1) * 24 * 3600 * 1000);
  const toISO = d => d.toISOString().slice(0, 10);
  return { dateStartISO: toISO(start), dateEndISO: toISO(end) };
}

/* ---------------- Tier helpers ---------------- */
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();

  // License key first
  try {
    if (licenseKey && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier')
        .eq('license_key', licenseKey)
        .maybeSingle();
      if (data && data.smartemail_tier) return String(data.smartemail_tier).toLowerCase();
    }
  } catch (e) { console.warn('tier by license key failed:', e?.message || e); }

  // Email fallback
  try {
    if (em && isLikelyEmail(em) && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier, created_at')
        .eq('email', em)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data && data.smartemail_tier) return String(data.smartemail_tier).toLowerCase();
    }
  } catch (e) { console.warn('tier by email failed:', e?.message || e); }

  return 'free';
}

async function isPaid(tier) {
  if (process.env.PAID_FEATURES_FOR_ALL === '1') return true;
  return !!tier && tier !== 'free';
}

/* ---------------- Personalization & weights ---------------- */
async function fetchListsFromSql(userId = 'default') {
  const empty = {
    vip: new Set(),
    legal: new Set(),
    government: new Set(),
    bulk: new Set(),
    weights: { email: new Map(), domain: new Map() }
  };
  if (!supa) return empty;

  try {
    const [vipSenders, vipDomains, legalDomains, govDomains, bulkDomains, weights] =
      await Promise.all([
        supa.from('vip_senders').select('email'),
        supa.from('vip_domains').select('domain'),
        supa.from('legal_domains').select('domain'),
        supa.from('government_domains').select('domain'),
        supa.from('bulk_domains').select('domain'),
        supa.from('mail_importance_feedback').select('kind,identity,pos,neg').eq('user_id', userId)
      ]).then(rs => rs.map(r => r.data || []));

    const vip = new Set([...rowsToSet(vipSenders, 'email'), ...rowsToSet(vipDomains, 'domain')]);
    const legal = rowsToSet(legalDomains, 'domain');
    const government = rowsToSet(govDomains, 'domain');
    const bulk = rowsToSet(bulkDomains, 'domain');

    const wEmail = new Map(), wDomain = new Map();
    (weights || []).forEach(r => {
      const pos = Number(r.pos) || 0, neg = Number(r.neg) || 0;
      const prob = (pos + 2) / (pos + neg + 5);
      const logit = Math.log(Math.max(1e-6, prob / (1 - prob)));
      const v = clamp(logit, -4, 4);
      if (String(r.kind) === 'email')  wEmail.set(String(r.identity).toLowerCase(), v);
      if (String(r.kind) === 'domain') wDomain.set(String(r.identity).toLowerCase(), v);
    });

    return { vip, legal, government, bulk, weights: { email: wEmail, domain: wDomain } };
  } catch (e) {
    console.warn('fetchListsFromSql failed:', e?.message || e);
    return empty;
  }
}

/* ---------------- User overrides (learning your relabels) ---------------- */
async function fetchOverridesFromSql(userId = 'default') {
  if (!supa) return { byEmail: new Map(), byDomain: new Map() };
  try {
    const { data } = await supa
      .from('user_label_overrides')
      .select('kind, identity, preferred_category, force_important, force_unimportant, vip')
      .eq('user_id', userId);

    const byEmail = new Map();
    const byDomain = new Map();
    (data || []).forEach(r => {
      const rec = {
        category: (r.preferred_category || '').toLowerCase() || null,
        forceImportant: !!r.force_important,
        forceUnimportant: !!r.force_unimportant,
        vip: r.vip === true
      };
      const id = String(r.identity || '').toLowerCase();
      if (String(r.kind) === 'email') byEmail.set(id, rec);
      if (String(r.kind) === 'domain') byDomain.set(id, rec);
    });
    return { byEmail, byDomain };
  } catch (e) {
    console.warn('fetchOverridesFromSql error:', e?.message || e);
    return { byEmail: new Map(), byDomain: new Map() };
  }
}

function normalizeForClassifier(items) {
  return (items || []).map((e, i) => ({
    id: e.id ?? e.uid ?? String(i + 1),
    from: e.from || '',
    fromEmail: (e.fromEmail || '').toLowerCase(),
    fromDomain: (e.fromDomain || '').toLowerCase(),
    to: e.to || '',
    subject: e.subject || '',
    snippet: e.snippet || e.text || '',
    date: e.date || '',
    headers: e.headers || {},
    hasIcs: !!e.hasIcs,
    attachTypes: e.attachTypes || [],
    unread: !!e.unread,
    flagged: !!e.flagged,
    contentType: e.contentType || ''
  }));
}

/* ---------------- Free-tier caps (kept, but bodies still fetched) ---------------- */
const lastFetchAt = new Map(); // key=userId
function applyFreeCapsIfNeeded(tier, rangeDays, limit) {
  const isFree = !tier || tier === 'free';
  const caps = { isFree, rangeMax: 7, limitMax: 20, minFetchMs: 30_000 };
  if (!isFree) return { ...caps, rangeDays, limit };

  return {
    ...caps,
    rangeDays: Math.min(Number(rangeDays ?? 7), caps.rangeMax),
    limit: Math.min(Number(limit ?? 20), caps.limitMax)
  };
}

/* ---------------- Helpers: snippets & audit ---------------- */
function htmlToText(html = '') {
  try {
    let s = String(html || '');
    s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
         .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
         .replace(/<[^>]+>/g, ' ')
         .replace(/\s+/g, ' ')
         .trim();
    return s;
  } catch { return ''; }
}
function makeSnippet(msg, max = 180) {
  const basis = (msg.snippet && String(msg.snippet).trim())
    || (msg.text && String(msg.text).trim())
    || htmlToText(msg.html || msg.bodyHtml || msg.body || '');
  if (!basis) return '';
  const s = basis.slice(0, max);
  return s.length < basis.length ? s + '…' : s;
}
function auditStats(items) {
  const a = { total: items.length, haveSnippet: 0, haveText: 0, haveHtml: 0 };
  items.forEach(m => {
    if (m.snippet) a.haveSnippet++;
    if (m.text) a.haveText++;
    if (m.html) a.haveHtml++;
  });
  return a;
}

/* ---------------- Routes ---------------- */
router.post('/tier', async (req, res) => {
  try {
    const { email = '', licenseKey = '' } = req.body || {};
    const tier = await getTier({ licenseKey, email });
    const paid = await isPaid(tier);
    const notice = paid ? null : 'Free plan: up to 20 emails from the last 7 days.';
    res.json({ tier, isPaid: paid, notice });
  } catch (e) {
    console.error('IMAP /tier error:', e?.message || e);
    res.status(500).json({ error: 'Could not determine tier' });
  }
});

router.post('/fetch', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password',
      licenseKey = '',
      monthStart = '', monthEnd = '',
      cursor = null,
      rangeDays: qRangeDays,
      limit: qLimit,
      query = '',           // optional
      debugAudit = false
    } = req.body || {};

    if (!email || !host) {
      return res.status(400).json({ error: 'email and host are required' });
    }

    const safeEmail = isLikelyEmail(email) ? email : '';
    const tier = await getTier({ licenseKey, email: safeEmail });
    const paid = await isPaid(tier);

    const userId = userIdFromEmail(safeEmail || 'anon');
    const capped = applyFreeCapsIfNeeded(tier, qRangeDays, qLimit);

    if (capped.isFree && capped.minFetchMs > 0) {
      const now = Date.now();
      const last = lastFetchAt.get(userId) || 0;
      if (now - last < capped.minFetchMs) {
        const wait = Math.ceil((capped.minFetchMs - (now - last)) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s (free plan limit).` });
      }
      lastFetchAt.set(userId, now);
    }

    // Auth validation
    if (String(authType).toLowerCase() === 'password') {
      if (!password) return res.status(400).json({ error: 'No password configured' });
    } else if (String(authType).toLowerCase() === 'xoauth2') {
      if (!accessToken) return res.status(400).json({ error: 'XOAUTH2 requires accessToken' });
    }

    // Date selection
    const msStr = String(monthStart || '').trim();
    const meStr = String(monthEnd   || '').trim();
    const isValidISO = (s) => !!s && !Number.isNaN(Date.parse(s));
    const useMonth = isValidISO(msStr) && isValidISO(meStr);

    let rangeDays = useMonth ? undefined : Math.max(0, Number(capped.rangeDays) || 0);
    const limit = Math.max(1, Number(capped.limit) || 20);

    // Absolute window for range (crosses months)
    let dateStartISO, dateEndISO;
    if (!useMonth && typeof rangeDays === 'number' && rangeDays > 0) {
      const win = startEndFromRangeDays(rangeDays);
      dateStartISO = win.dateStartISO;
      dateEndISO = win.dateEndISO;
    }

    // Personalization & lists
    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };
    const vipSenders = Array.from(lists.vip);

    // --- Fetch from IMAP (always ask for bodies) ---
    const { items, nextCursor, hasMore } = await fetchEmails({
      email: safeEmail, password, accessToken, host, port, tls, authType,
      monthStart: useMonth ? msStr : undefined,
      monthEnd:   useMonth ? meStr : undefined,
      rangeDays,
      dateStartISO,
      dateEndISO,
      limit,
      cursor,
      query,
      vipSenders,
      fullBodies: true               // << ALWAYS hydrate bodies for previews/export
    });

    // Build server-side snippets for UI preview
    const withSnippets = (items || []).map(m => ({ ...m, bodySnippet: makeSnippet(m) }));
    const audit = auditStats(withSnippets);

    // Stage 2 classifier
    const norm = normalizeForClassifier(withSnippets);
    let cls = [];
    try {
      const out = await classifyEmails(norm, { userId, lists });
      cls = Array.isArray(out) ? out : Array.isArray(out?.results) ? out.results : [];
    } catch (err) {
      console.warn('classifyEmails failed:', err?.message || err);
      cls = [];
    }

    // Merge base + classifier
    let merged = norm.map((it, i) => ({
      ...it,
      ...(cls[i] || {}),
      bodySnippet: withSnippets[i]?.bodySnippet || '',
      isVip:
        lists.vip.has((it.fromEmail || '').toLowerCase()) ||
        lists.vip.has((it.fromDomain || '').toLowerCase())
    }));

    // APPLY USER OVERRIDES (learning) — email wins over domain
    const overrides = paid ? await fetchOverridesFromSql(userId) : { byEmail: new Map(), byDomain: new Map() };
    merged = merged.map(m => {
      const emailKey = (m.fromEmail || '').toLowerCase();
      const domainKey = (m.fromDomain || '').toLowerCase();
      const o = overrides.byEmail.get(emailKey) || overrides.byDomain.get(domainKey) || null;
      if (!o) return m;
      const out = { ...m };
      if (o.category) out.category = out.intent = o.category;
      if (o.forceImportant) out.importance = 'important';
      if (o.forceUnimportant) out.importance = 'unimportant';
      if (o.vip === true) out.isVip = true;
      return out;
    });

    const notice = !paid
      ? 'Free plan: up to 20 emails from the last 7 days. Upgrade for learning and overrides.'
      : null;

    const fetchMode = useMonth ? 'month' : (typeof rangeDays === 'number' && rangeDays > 0 ? 'range' : 'unbounded');
    const windowStart = useMonth ? msStr : (dateStartISO || null);
    const windowEnd   = useMonth ? meStr : (dateEndISO || null);

    const response = {
      emails: merged,
      nextCursor: nextCursor || null,
      hasMore: !!hasMore,
      tier,
      notice,
      fetchInfo: { mode: fetchMode, start: windowStart, end: windowEnd },
      audit: debugAudit ? audit : undefined
    };

    res.json(response);
  } catch (e) {
    console.error('IMAP /fetch error:', e?.message || e);
    const code = String(e?.code || '').toUpperCase();
    if (code === 'EAUTH') return res.status(401).json({ error: 'Authentication failed' });
    if (code === 'ENOTFOUND') return res.status(502).json({ error: 'IMAP host not found' });
    res.status(500).json({ error: 'Server error while fetching mail.' });
  }
});

router.post('/test', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password'
    } = req.body || {};
    if (!email || !host) return res.status(400).json({ ok:false, error: 'email and host are required' });

    const ok = await testLogin({ email, password, accessToken, host, port, tls, authType });
    res.json({ ok: !!ok });
  } catch (e) {
    console.error('IMAP /test error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'IMAP login failed' });
  }
});

/* ---------------- Batch body hydration for export ---------------- */
router.post('/bodyBatch', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password',
      ids = []
    } = req.body || {};

    const list = Array.isArray(ids) ? ids.slice(0, 100) : [];
    if (!email || !host) return res.status(400).json({ error: 'email and host are required' });
    if (!list.length) return res.json({ items: [] });

    const out = [];
    for (const id of list) {
      try {
        const m = await getMessageById({ email, password, accessToken, host, port, tls, authType, id });
        out.push({
          id,
          text: (m?.text || '').trim(),
          html: m?.html || '',
          snippet: (m?.text || m?.html || '').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').slice(0,180)
        });
      } catch (e) {
        out.push({ id, text: '', html: '', error: String(e?.message || e) });
      }
    }
    res.json({ items: out });
  } catch (e) {
    console.error('IMAP /bodyBatch error:', e?.message || e);
    res.status(500).json({ error: 'bodyBatch failed' });
  }
});

export default router;
