// imapRoutes.js — IMAP fetch/classify with tier check, month/range, cursor paging,
// VIP & weights, PLUS user overrides (learning) that refine future classifications.

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
// Table: user_label_overrides (suggested schema)
// user_id TEXT, kind TEXT ('email'|'domain'), identity TEXT, preferred_category TEXT NULL,
// force_important BOOLEAN NULL, force_unimportant BOOLEAN NULL, vip BOOLEAN NULL, updated_at TIMESTAMP

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

/* ---------------- Free-tier caps ---------------- */
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

/* ------------------- Snippet helpers (server-side preview) ------------------- */
function htmlToText(html='') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function makeSnippet(msg, max=180){
  const s = (msg?.snippet || '').trim();
  const t = (msg?.text || '').trim();
  if (s) return s.length>max ? (s.slice(0,max-1)+'…') : s;
  const base = t || htmlToText(msg?.html || msg?.bodyHtml || msg?.body || '');
  if (!base) return '';
  return base.length>max ? (base.slice(0,max-1)+'…') : base;
}

/* ---------------- Server-side body hydration (guaranteed full content) ---------------- */
async function hydrateBodiesForItems(items){
  const out = [];
  for (const m of (items||[])) {
    const hasBody = !!(m?.text && String(m.text).trim()) || !!(m?.html || m?.bodyHtml || m?.body);
    if (hasBody) { out.push(m); continue; }
    try {
      const resp = await fetchEmails({ byId: m.id });
      const got = Array.isArray(resp?.items) ? resp.items[0] : resp?.item || resp;
      if (got) {
        m.text = (got.text || '').trim();
        m.html = got.html || got.bodyHtml || got.body || '';
      }
    } catch (e) {
      // keep original item if hydration fails
    }
    out.push(m);
  }
  return out;
}


/* ------ Date window helpers (ensure range spans across months) ------ */
function startEndFromRangeDays(rangeDays){
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23,59,59,999));
  const start = new Date(end.getTime() - Math.max(0, (Number(rangeDays)||0)-1) * 24*3600*1000);
  const toISO = (d)=> d.toISOString().slice(0,10); // YYYY-MM-DD
  return { dateStartISO: toISO(start), dateEndISO: toISO(end) };
}

function auditStats(items){
  const stats = { total:(items||[]).length, haveSnippet:0, haveText:0, haveHtml:0, haveAny:0 };
  for(const m of (items||[])){
    const hasSnippet = !!(m?.snippet);
    const hasText = !!(m?.text && String(m.text).trim());
    const hasHtml = !!(m?.html || m?.bodyHtml || m?.body);
    if(hasSnippet) stats.haveSnippet++;
    if(hasText) stats.haveText++;
    if(hasHtml) stats.haveHtml++;
    if(hasSnippet || hasText || hasHtml) stats.haveAny++;
  }
  return stats;
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
      query = '',            // (optional) search string; month/range still applied
      debugAudit = false     // (optional) include audit stats in response
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

    const rangeDays = useMonth ? undefined : Math.max(0, Number(capped.rangeDays) || 0);
    const limit = Math.max(1, Number(capped.limit) || 20);

    // Personalization & lists
    const lists = paid
      ? await fetchListsFromSql(userId)
      : { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
          weights:{ email:new Map(), domain:new Map() } };
    const vipSenders = Array.from(lists.vip);

    // Compute absolute date window for range (spans across months)
    let dateStartISO, dateEndISO;
    if (!useMonth && typeof rangeDays === 'number' && rangeDays > 0) {
      const win = startEndFromRangeDays(rangeDays);
      dateStartISO = win.dateStartISO; // inclusive YYYY-MM-DD
      dateEndISO = win.dateEndISO;     // inclusive YYYY-MM-DD
    }

    // Fetch from IMAP (month/range/query supported by service)
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
      vipSenders
    });


    // --- Guarantee full bodies under sane limits or if explicitly requested
    const explicitFull = req.body && (req.body.fullBodies === true);
    const saneLimit = limit <= 50;
    const saneRange = (typeof rangeDays === 'number' ? rangeDays <= 31 : true) || useMonth;
    let itemsWithBodies = await hydrateBodiesForItems(items);

    // --- Add server-side bodySnippet for previews
    const withSnippets = (itemsWithBodies || []).map(m => ({
      ...m,
      bodySnippet: makeSnippet(m)
    }));

    // Optional: audit stats to logs and/or response
    const audit = auditStats(withSnippets);
    if (debugAudit || process.env.IMAP_AUDIT === '1') {
      console.log('[IMAP FETCH AUDIT]', JSON.stringify({
        userId,
        stats: audit,
        sample: withSnippets.slice(0, 3).map(x => ({
          id: x.id, subj: (x.subject||'').slice(0,120), hasSnippet: !!x.snippet,
          textLen: (x.text||'').length, html: !!(x.html||x.bodyHtml||x.body), bodySnippetLen: (x.bodySnippet||'').length
        }))
      }));
    }

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

    // Merge base + classifier and keep bodySnippet
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
      if (o.category) out.category = out.intent = o.category; // keep back-compat 'intent'
      if (o.forceImportant) out.importance = 'important';
      if (o.forceUnimportant) out.importance = 'unimportant';
      if (o.vip === true) out.isVip = true;
      return out;
    });

    const notice = !paid
      ? 'Free plan: up to 20 emails from the last 7 days. Upgrade for learning and overrides.'
      : null;

    const response = { emails: merged, nextCursor: nextCursor || null, hasMore: !!hasMore, tier, notice };
    if (debugAudit) response.audit = audit; // only if requested
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

/* ---------------- Learning endpoint (override + weights) ----------------
POST /api/imap/feedback
Body:
{
  email: "<owner mailbox email>",          // required to resolve userId/tier
  licenseKey: "...",                       // optional
  // Target scope (choose one — email preferred, else domain):
  fromEmail: "sender@acme.com",
  fromDomain: "acme.com",

  // What you corrected:
  importance: "important" | "unimportant" | "unclassified",   // optional
  category: "meeting"|"billing"|"security"|"newsletter"|"sales"|"social"|"legal"|"system"|"other", // optional
  vip: true|false                                              // optional
}
-------------------------------------------------------------------------- */
router.post('/feedback', async (req, res) => {
  try {
    const {
      label,                    // legacy: 'important' / 'unimportant' (still supported)
      importance,               // new optional explicit importance
      category,                 // new optional explicit category
      vip,                      // new optional VIP flag (true/false)
      fromEmail = '',
      fromDomain = '',
      email: ownerEmail = '',
      licenseKey = ''
    } = req.body || {};

    const safeOwner = isLikelyEmail(ownerEmail) ? ownerEmail : '';
    const tier = await getTier({ licenseKey, email: safeOwner });
    const paid = await isPaid(tier);
    if (!paid) {
      return res.status(402).json({ ok:false, error: 'Upgrade to enable learning/overrides.' });
    }
    if (!fromEmail && !fromDomain) {
      return res.status(400).json({ ok:false, error: 'fromEmail or fromDomain required' });
    }

    const userId = userIdFromEmail(safeOwner || 'anon');

    // ---- 1) Learn importance weights (same as before, but accept both legacy & new fields)
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
            .update({ pos: pos, neg: neg, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('kind', payload.kind).eq('identity', payload.identity);
        }
      }
    }

    // ---- 2) Persist explicit overrides (category/importance/vip) so /fetch applies them
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

      // Upsert (create-or-update)
      await supa.from('user_label_overrides')
        .upsert(row, { onConflict: 'user_id,kind,identity' });
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('IMAP /feedback error:', e?.message || e);
    res.status(500).json({ ok:false, error:'failed to save feedback' });
  }
});


/* ---------------- Batch body hydration for export ---------------- */
router.post('/bodyBatch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : [];
    if (!ids.length) return res.json({ items: [] });

    const out = [];
    for (const id of ids) {
      try {
        // Reuse underlying IMAP service single-message fetch.
        // Assumes fetchEmails or a sibling provides get by id; if not, replace with your getter.
        const m = await fetchEmails({ byId: id });
        const msg = Array.isArray(m?.items) ? m.items[0] : m?.item || m;
        out.push({
          id,
          text: (msg?.text || '').trim(),
          html: msg?.html || msg?.bodyHtml || ''
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
