// imapRoutes.js — IMAP fetch/classify with tier check (email or licenseKey)
// Uses smartemail_tier only (per your schema). Keeps testLogin but isolated.

import express from 'express';
import crypto from 'crypto';
import { fetchEmails, testLogin } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

// Supabase (service role)
import { createClient as createSupabase } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const router = express.Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s||'')).digest('hex');
const userIdFromEmail = (email) => sha256(String(email).trim().toLowerCase());

// Basic sanity check to avoid DB pattern errors
const isLikelyEmail = (s) => typeof s === 'string' && /\S+@\S+\.\S+/.test(s);

function rowsToSet(rows, key) {
  return new Set((rows || [])
    .map(r => String(r[key] || '').toLowerCase())
    .filter(Boolean));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// --- Tier helpers (email-first, key fallback) ---
// IMPORTANT: Only read the 'smartemail_tier' column from 'licenses'
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();

  // Lookup by license key
  try {
    if (licenseKey && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier')
        .eq('license_key', licenseKey)
        .maybeSingle();
      if (data && data.smartemail_tier) {
        return String(data.smartemail_tier).toLowerCase();
      }
    }
  } catch (e) { console.warn('tier by license key failed:', e?.message || e); }

  // Fallback by email (newest record)
  try {
    if (em && isLikelyEmail(em) && supa) {
      const { data } = await supa
        .from('licenses')
        .select('smartemail_tier, created_at')
        .eq('email', em)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data && data.smartemail_tier) {
        return String(data.smartemail_tier).toLowerCase();
      }
    }
  } catch (e) { console.warn('tier by email failed:', e?.message || e); }

  return 'free';
}

async function isPaid(tier) {
  if (process.env.PAID_FEATURES_FOR_ALL === '1') return true;
  return !!tier && tier !== 'free';
}

// Personalization lists + learned weights (paid users only)
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

// ---------- Free-tier caps ----------
const lastFetchAt = new Map(); // key=userId
function applyFreeCapsIfNeeded(tier, body) {
  const isFree = !tier || tier === 'free';
  const caps = { isFree, rangeMax: 7, limitMax: 20, minFetchMs: 30_000 };
  if (isFree) {
    body.rangeDays = Math.min(Number(body.rangeDays || 7), caps.rangeMax);
    body.limit     = Math.min(Number(body.limit || 20),   caps.limitMax);
  }
  return caps;
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
      host = '', port = 993, tls = true, authType = 'password',
      licenseKey = '',
      monthStart = '', monthEnd = ''
    } = req.body || {};

    // protect DB: only use plausible email for tier lookup + userId
    const safeEmail = isLikelyEmail(email) ? email : '';

    const tier = await getTier({ licenseKey, email: safeEmail });
    const paid = await isPaid(tier);

    const userId = userIdFromEmail(safeEmail || 'anon');
    const caps = applyFreeCapsIfNeeded(tier, req.body);
    if (caps.isFree && caps.minFetchMs > 0) {
      const now = Date.now();
      const last = lastFetchAt.get(userId) || 0;
      if (now - last < caps.minFetchMs) {
        const wait = Math.ceil((caps.minFetchMs - (now - last)) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s (free plan limit).` });
      }
      lastFetchAt.set(userId, now);
    }

    // ---- Date selection strategy ----
    // 1) If monthStart & monthEnd provided (ISO strings), prefer exact month range
    // 2) Else fall back to rangeDays -> SINCE
    let search;
    const ms = String(monthStart || '').trim();
    const me = String(monthEnd || '').trim();

    if (ms && me && !Number.isNaN(Date.parse(ms)) && !Number.isNaN(Date.parse(me))) {
      // pass through as object; imapService understands { monthStart, monthEnd }
      search = { monthStart: ms, monthEnd: me };
    } else {
      // ✅ Critical fix preserved: SINCE must receive a Date object
      const days = Math.max(0, Number(req.body.rangeDays) || 0);
      search = days > 0
        ? ['SINCE', new Date(Date.now() - days * 864e5)]
        : ['ALL'];
    }

    const { items, nextCursor, hasMore } = await fetchEmails({
      email: safeEmail, password, accessToken, host, port, tls, authType,
      search, limit: Number(req.body.limit) || 20
    });

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

    res.json({ emails: merged, nextCursor: nextCursor || null, hasMore: !!hasMore, tier, notice });
  } catch (e) {
    console.error('IMAP /fetch error:', e?.message || e);
    res.status(500).json({ error: 'Server error while fetching mail.' });
  }
});

router.post('/test', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password'
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
        const payload = { user_id:userId, kind:(fromEmail?'email':'domain'), identity:(fromEmail||fromDomain).toLowerCase(), pos:0, neg:0 };
        await supa.from('mail_importance_feedback').upsert(payload, { onConflict: 'user_id,kind,identity' });
        await supa.from('mail_importance_feedback')
          .update({ pos: pos, neg: neg, updated_at: new Date().toISOString() })
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
