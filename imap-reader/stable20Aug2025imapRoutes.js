// imapRoutes.js — IMAP fetch/classify with robust month handling and tier check
import express from 'express';
import crypto from 'crypto';
import { fetchEmails, testLogin } from './imapService.js';
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

/* ---------- tier helpers ---------- */
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();

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

/* ---------- personalization lists (paid only) ---------- */
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
    const [
      vipSenders, vipDomains, legalDomains, govDomains, bulkDomains, weights
    ] = await Promise.all([
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

/* ---------- month parsing (accepts single month label) ---------- */
function parseMonthWindow({ monthStart = '', monthEnd = '', monthLabel = '' }) {
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const ms = clean(monthStart);
  const me = clean(monthEnd);
  const ml = clean(monthLabel);

  const isValid = (s) => !!s && !Number.isNaN(Date.parse(s));

  if (isValid(ms) && isValid(me)) {
    return { monthStart: new Date(ms).toISOString(), monthEnd: new Date(me).toISOString() };
  }

  if (isValid(ml) || isValid(ms)) {
    const d = new Date(isValid(ml) ? ml : ms);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return { monthStart: start.toISOString(), monthEnd: end.toISOString() };
  }

  return { monthStart: undefined, monthEnd: undefined };
}

/* ---------- free-tier caps ---------- */
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

/* ---------- ROUTES ---------- */

router.post('/fetch', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password',
      licenseKey = '',
      // UI may send any of the below:
      monthStart = '', monthEnd = '', month = '',
      cursor = null,
      rangeDays: qRangeDays,
      limit: qLimit
    } = req.body || {};

    if (!email || !host) return res.status(400).json({ error: 'email and host are required' });

    const safeEmail = isLikelyEmail(email) ? email : '';
    const tier = await getTier({ licenseKey, email: safeEmail });
    const paid = await isPaid(tier);
    const userId = userIdFromEmail(safeEmail || 'anon');

    // caps
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

    // auth validation
    if (String(authType).toLowerCase() === 'password') {
      if (!password) return res.status(400).json({ error: 'No password configured' });
    } else if (String(authType).toLowerCase() === 'xoauth2') {
      if (!accessToken) return res.status(400).json({ error: 'XOAUTH2 requires accessToken' });
    }

    // Month window: accept single month label
    const { monthStart: msIso, monthEnd: meIso } =
      parseMonthWindow({ monthStart, monthEnd, monthLabel: month });

    const rangeDays = msIso && meIso ? undefined : Math.max(0, Number(capped.rangeDays) || 0);
    const limit = Math.max(1, Number(capped.limit) || 20);

    // personalization (paid)
    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };
    const vipSenders = Array.from(lists.vip);

    const { items, nextCursor, hasMore } = await fetchEmails({
      email: safeEmail, password, accessToken, host, port, tls, authType,
      monthStart: msIso, monthEnd: meIso,
      rangeDays, limit, cursor, vipSenders
    });

    // optional second-stage classifier (kept, but robust)
    const norm = (items || []).map(e => ({
      id: e.id, from: e.from, fromEmail: e.fromEmail, fromDomain: e.fromDomain,
      to: e.to, subject: e.subject, snippet: e.snippet, date: e.date,
      headers: e.headers || {}, hasIcs: !!e.hasIcs, attachTypes: e.attachTypes || [],
      unread: !!e.unread, flagged: !!e.flagged, contentType: e.contentType || ''
    }));

    let cls = [];
    try {
      const out = await classifyEmails(norm, { userId, lists });
      cls = Array.isArray(out) ? out : Array.isArray(out?.results) ? out.results : [];
    } catch { cls = []; }

    const merged = (items || []).map((it, i) => ({
      ...it,
      ...(cls[i] || {}),
      isVip:
        lists.vip.has((it.fromEmail || '').toLowerCase()) ||
        lists.vip.has((it.fromDomain || '').toLowerCase())
    }));

    const notice = !paid
      ? 'Free plan: up to 20 emails from the last 7 days.'
      : null;

    res.json({ emails: merged, nextCursor: nextCursor || null, hasMore: !!hasMore, tier, notice });
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

export default router;
