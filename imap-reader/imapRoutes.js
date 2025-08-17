// imapRoutes.js — full routes with tier, fetch, classify, feedback (email or licenseKey)
// Keeps your original behavior, adds robustness around host, caps, throttling, and service args.

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

// ---------- Tier helpers (email-first, key fallback). Only smartemail_tier ----------
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();

  try {
    if (licenseKey && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier')
        .eq('license_key', licenseKey)
        .maybeSingle();
      if (data?.smartemail_tier) return String(data.smartemail_tier).toLowerCase();
    }
  } catch (e) {
    console.warn('tier by license key failed:', e?.message || e);
  }

  try {
    if (em && isLikelyEmail(em) && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier, created_at')
        .eq('email', em)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.smartemail_tier) return String(data.smartemail_tier).toLowerCase();
    }
  } catch (e) {
    console.warn('tier by email failed:', e?.message || e);
  }

  return 'free';
}

async function isPaid(tier) {
  if (process.env.PAID_FEATURES_FOR_ALL === '1') return true;
  return !!tier && tier !== 'free';
}

// ---------- Personalization lists + learned weights (paid only) ----------
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

function normalizeForClassifier(items) {
  return (items || []).map((e, i) => ({
    id: e.id ?? e.uid ?? String(i + 1),
    from: e.from || '',
    fromEmail: e.fromEmail || '',
    fromDomain: e.fromDomain || '',
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

// ---------- Free-tier caps (no body mutation) ----------
const lastFetchAt = new Map(); // userId -> timestamp
const LAST_SEEN_TTL_MS = 24 * 3600 * 1000;
function applyFreeCaps(tier, requested) {
  const isFree = !tier || tier === 'free';
  const caps = { isFree, rangeMax: 7, limitMax: 20, minFetchMs: 30_000 };
  const daysRange = isFree
    ? Math.min(Math.max(0, requested.daysRange), caps.rangeMax)
    : Math.max(0, requested.daysRange);
  const limit = isFree
    ? Math.min(Math.max(1, requested.limit), caps.limitMax)
    : Math.max(1, requested.limit);
  return { caps, daysRange, limit };
}
function noteFetch(userId, caps) {
  const now = Date.now();
  // prune old entries opportunistically
  for (const [k, ts] of lastFetchAt) {
    if (now - ts > LAST_SEEN_TTL_MS) lastFetchAt.delete(k);
  }
  if (caps.isFree) lastFetchAt.set(userId, now);
}
function enforceThrottle(userId, caps) {
  if (!caps.isFree) return null;
  const now = Date.now();
  const last = lastFetchAt.get(userId) || 0;
  if (now - last < caps.minFetchMs) {
    const wait = Math.ceil((caps.minFetchMs - (now - last)) / 1000);
    return `Please wait ${wait}s (free plan limit).`;
  }
  return null;
}

// ---------- ROUTES ----------
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
      host: hostIn = '', port = 993, tls = true, authType = 'password',
      licenseKey = ''
    } = req.body || {};

    const safeEmail = isLikelyEmail(email) ? email : '';
    const host = hostIn || 'imap.gmail.com';

    const tier = await getTier({ licenseKey, email: safeEmail });
    const paid = await isPaid(tier);

    const userId = userIdFromEmail(safeEmail || 'anon');

    const requested = {
      daysRange: Number(req.body.rangeDays) || 0,
      limit: Number(req.body.limit) || 20
    };
    const { caps, daysRange, limit } = applyFreeCaps(tier, requested);

    const throttleMsg = enforceThrottle(userId, caps);
    if (throttleMsg) return res.status(429).json({ error: throttleMsg });

    // For services that want IMAP criteria (imap-simple)
    const searchCriteria = daysRange > 0
      ? ['SINCE', new Date(Date.now() - daysRange * 864e5)]
      : ['ALL'];

    // Call the service with BOTH flavors; it can use what it supports.
    const { items = [], nextCursor = null, hasMore = false } = await fetchEmails({
      user: safeEmail,
      email: safeEmail,           // (compat)
      password,
      accessToken,
      host,
      port,
      tls,
      authType,
      daysRange,
      limit,
      search: searchCriteria,     // (compat)
      searchCriteria              // (explicit)
    });

    noteFetch(userId, caps);

    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };

    const norm = normalizeForClassifier(items);
    const cls = await classifyEmails(norm, { userId, lists });
    const merged = (items || []).map((it, i) => ({ ...it, ...(cls[i] || {}) }));

    const notice = !paid
      ? 'Free plan: up to 20 emails from the last 7 days. Upgrade for more range, higher limits, VIP boosts, and learning.'
      : null;

    res.json({ emails: merged, nextCursor, hasMore: !!hasMore, tier, notice });
  } catch (e) {
    console.error('IMAP /fetch error:', e?.message || e);
    res.status(500).json({ error: 'Server error while fetching mail.' });
  }
});

router.post('/test', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = 'imap.gmail.com', port = 993, tls = true, authType = 'password'
    } = req.body || {};
    const ok = await testLogin({ email, password, accessToken, host, port, tls, authType });
    res.json({ ok: !!ok });
  } catch (e) {
    console.error('IMAP /test error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'IMAP login failed' });
  }
});

router.post('/classify', async (req, res) => {
  try {
    const { items = [], email: mailboxEmail = '', licenseKey = '' } = req.body || {};
    const safeEmail = isLikelyEmail(mailboxEmail) ? mailboxEmail : '';
    const tier = await getTier({ licenseKey, email: safeEmail });
    const paid = await isPaid(tier);
    const userId = userIdFromEmail(safeEmail || 'anon');

    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };

    const norm = normalizeForClassifier(items);
    const results = await classifyEmails(norm, { userId, lists });
    res.json(results);
  } catch (e) {
    console.error('IMAP /classify error:', e?.message || e);
    res.status(500).json({ error: 'Classification failed' });
  }
});

router.post('/feedback', async (req, res) => {
  try {
    const { label, fromEmail = '', fromDomain = '', email: ownerEmail = '', licenseKey = '' } = req.body || {};
    const safeOwner = isLikelyEmail(ownerEmail) ? ownerEmail : '';
    const tier = await getTier({ licenseKey, email: safeOwner });
    const paid = await isPaid(tier);
    if (!paid) {
      return res.status(402).json({ ok:false, error: 'Upgrade to enable learning (Important ⭐).' });
    }
    if (!label || (!fromEmail && !fromDomain)) {
      return res.status(400).json({ ok:false, error: 'label and fromEmail/fromDomain required' });
    }

    const userId = userIdFromEmail(safeOwner || 'anon');
    const important = label === 'important';
    const pos = important ? 1 : 0;
    const neg = important ? 0 : 1;

    if (supa) {
      try {
        await supa.rpc('increment_feedback_h', {
          p_user_id: userId,
          p_kind: fromEmail ? 'email' : 'domain',
          p_identity: fromEmail || fromDomain,
          p_pos: pos, p_neg: neg
        });
      } catch {
        const payload = {
          user_id: userId,
          kind: (fromEmail ? 'email' : 'domain'),
          identity: (fromEmail || fromDomain).toLowerCase(),
          pos: 0, neg: 0
        };
        await supa.from('mail_importance_feedback')
          .upsert(payload, { onConflict: 'user_id,kind,identity' });
        await supa.from('mail_importance_feedback')
          .update({ pos, neg, updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('kind', payload.kind).eq('identity', payload.identity);
      }
    } else {
      console.log('[feedback] no DB, ignored');
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('IMAP /feedback error:', e?.message || e);
    res.status(500).json({ ok:false, error:'failed to save feedback' });
  }
});

export default router;
