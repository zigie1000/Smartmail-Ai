// imapRoutes.js — IMAP fetch/classify with tier check, month/range, cursor paging,
// VIP & weights, PLUS user overrides (learning) that refine future classifications.
import express from 'express';
import crypto from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

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

/* --- Tier helpers --- */
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();
  try {
    if (licenseKey && supa) {
      const { data } = await supa
        .from('licenses').select('smartemail_tier')
        .eq('license_key', licenseKey).maybeSingle();
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
        .limit(1).maybeSingle();
      if (data && data.smartemail_tier) return String(data.smartemail_tier).toLowerCase();
    }
  } catch (e) { console.warn('tier by email failed:', e?.message || e); }

  return 'free';
}

async function isPaid(tier) {
  if (process.env.PAID_FEATURES_FOR_ALL === '1') return true;
  return !!tier && tier !== 'free';
}

/* --- Personalization & weights --- */
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

/* --- User overrides (learning) --- */
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
    text: e.text || '',           // ← keep full text
    html: e.html || '',           // ← keep full html
    date: e.date || '',
    headers: e.headers || {},
    hasIcs: !!e.hasIcs,
    attachTypes: e.attachTypes || [],
    unread: !!e.unread,
    flagged: !!e.flagged,
    contentType: e.contentType || ''
  }));
}

/* --- Free-tier caps --- */
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

/* --- Routes --- */
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
      query = ''
    } = req.body || {};

    if (!email || !host) return res.status(400).json({ error: 'email and host are required' });

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

    const rangeDays = useMonth ? undefined : Math.max(0, Number(capped.rangeDays) || 0);
    const limit = Math.max(1, Number(capped.limit) || 20);

    // Lists (VIP, weights…)
    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };
    const vipSenders = Array.from(lists.vip);

    // Fetch from IMAP
    const { items, nextCursor, hasMore } = await fetchEmails({
      email: safeEmail, password, accessToken, host, port, tls, authType,
      monthStart: useMonth ? msStr : undefined,
      monthEnd:   useMonth ? meStr : undefined,
      rangeDays,
      limit,
      cursor,
      query,
      vipSenders,
      // Aug 29 behavior: force full bodies in Month; pass-through client flag for Range
      fullBodies: useMonth ? true : !!req.body.fullBodies
    });

    // Stage 2 classifier
    const norm = normalizeForClassifier(items);
    let cls = [];
    try {
      const out = await classifyEmails(norm, { userId, lists });
      cls = Array.isArray(out) ? out : Array.isArray(out?.results) ? out.results : [];
    } catch (err) {
      console.warn('classifyEmails failed:', err?.message || err);
      cls = [];
    }

    // Merge base + classifier + VIP
    let merged = norm.map((it, i) => ({
      ...it,
      ...(cls[i] || {}),
      isVip:
        lists.vip.has((it.fromEmail || '').toLowerCase()) ||
        lists.vip.has((it.fromDomain || '').toLowerCase())
    }));

    // Apply overrides
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

/* --- Full-body batch hydrator ------------------------------------------- */
router.post('/bodyBatch', async (req, res) => {
  const {
    email = '', password = '', accessToken = '',
    host = '', port = 993, tls = true, authType = 'password',
    ids = []
  } = req.body || {};

  if (!email || !host) return res.status(400).json({ error: 'email and host are required' });
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ items: [] });

  const normBool = (v) => v === true || String(v).toLowerCase() === 'true';
  const makeAuth = () => {
    const kind = String(authType || 'password').toLowerCase();
    if (kind === 'xoauth2') return { user: email, accessToken: accessToken || '' };
    return { user: email, pass: password || '' };
  };

  let client;
  try {
    client = new ImapFlow({
      host,
      port: Number(port) || 993,
      secure: normBool(tls),
      auth: makeAuth(),
      logger: false
    });
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });

    const out = [];
    const uniq = Array.from(new Set(ids.map(x => Number(x)).filter(Number.isFinite)));
    for (const uid of uniq) {
      try {
        // IMPORTANT: tell ImapFlow that uid is a UID (not seqno)
        const dl = await client.download(uid, { uid: true }); // ← UID mode
        if (!dl) continue;

        const readable =
          (dl && typeof dl.pipe === 'function') ? dl :
          (dl && dl.content && typeof dl.content.pipe === 'function') ? dl.content :
          (dl && dl.message && typeof dl.message.pipe === 'function') ? dl.message :
          null;
        if (!readable) continue;

        const parsed = await simpleParser(readable);
        const text = (parsed.text || '').toString().trim();
        const html = (parsed.html || '').toString().trim();
        const textish = (text || html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        out.push({
          id: String(uid),
          text,
          html,
          snippet: textish ? textish.slice(0, 600) : ''
        });
      } catch (_) { /* skip one uid on error */ }
    }

    try { await client.logout(); } catch (_) {}
    res.json({ items: out });
  } catch (e) {
    try { if (client) await client.logout(); } catch (_) {}
    console.error('IMAP /bodyBatch error:', e?.message || e);
    res.status(500).json({ error: 'Failed to fetch bodies' });
  }
});

/* --- Learning endpoint (overrides + weights) ---------------------------- */
router.post('/feedback', async (req, res) => {
  try {
    const {
      label, importance, category, vip,
      fromEmail = '', fromDomain = '',
      email: ownerEmail = '', licenseKey = ''
    } = req.body || {};

    const safeOwner = isLikelyEmail(ownerEmail) ? ownerEmail : '';
    const tier = await getTier({ licenseKey, email: safeOwner });
    const paid = await isPaid(tier);
    if (!paid) return res.status(402).json({ ok:false, error: 'Upgrade to enable learning/overrides.' });
    if (!fromEmail && !fromDomain) return res.status(400).json({ ok:false, error: 'fromEmail or fromDomain required' });

    const userId = userIdFromEmail(safeOwner || 'anon');

    // 1) learn importance weights
    const imp = String(importance || label || '').toLowerCase();
    if (imp === 'important' || imp === 'unimportant') {
      const pos = imp === 'important' ? 1 : 0;
      const neg = imp === 'important' ? 0 : 1;
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
            .update({ pos, neg, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('kind', payload.kind).eq('identity', payload.identity);
        }
      }
    }

    // 2) persist explicit overrides
    if (supa && (category || typeof vip === 'boolean' || imp)) {
      const kind = fromEmail ? 'email' : 'domain';
      const identity = (fromEmail || fromDomain).toLowerCase();
      const row = {
        user_id: userId,
        kind,
        identity,
        preferred_category: category || null,
        force_important: imp === 'important' ? true : null,
        force_unimportant: imp === 'unimportant' ? true : null,
        vip: (typeof vip === 'boolean') ? vip : null,
        updated_at: new Date().toISOString()
      };
      await supa.from('user_label_overrides').upsert(row, { onConflict: 'user_id,kind,identity' });
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('IMAP /feedback error:', e?.message || e);
    res.status(500).json({ ok:false, error:'failed to save feedback' });
  }
});

export default router;
