// imapRoutes.js — minimal-impact upgrade
// - adds VIP/Legal/Gov/Bulk lists + learned weights from SQL
// - adds POST /api/imap/feedback
// - passes lists to classifier
//
// Works with Supabase (SUPABASE_URL, SUPABASE_SERVICE_KEY) OR Postgres (POSTGRES_URL or DATABASE_URL)
// If no DB is configured, routes still work (feedback becomes a no-op).

import express from 'express';
import { fetchEmails, testLogin } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

// ---------- Optional DB clients (configure one) ----------
import { createClient as createSupabase } from '@supabase/supabase-js';
import pgPkg from 'pg';
const { Pool } = pgPkg;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const pg = (!supa && POSTGRES_URL)
  ? new Pool({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ---------- Helpers ----------
const router = express.Router();

function rowsToSet(rows, key) {
  return new Set((rows || [])
    .map(r => String(r[key] || '').toLowerCase())
    .filter(Boolean));
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Load personalization lists + learned weights from SQL.
 * Returns:
 *   { vip:Set, legal:Set, government:Set, bulk:Set,
 *     weights:{ email:Map<string,number>, domain:Map<string,number> } }
 */
async function fetchListsFromSql(userId = 'default') {
  try {
    let vipSenders = [], vipDomains = [], legalDomains = [], govDomains = [], bulkDomains = [], weights = [];

    if (supa) {
      const qs = await Promise.allSettled([
        supa.from('vip_senders').select('email'),
        supa.from('vip_domains').select('domain'),
        supa.from('legal_domains').select('domain'),
        supa.from('government_domains').select('domain'),
        supa.from('bulk_domains').select('domain'),
        supa.from('mail_importance_feedback').select('kind,identity,pos,neg').eq('user_id', userId)
      ]);
      vipSenders  = qs[0].value?.data || [];
      vipDomains  = qs[1].value?.data || [];
      legalDomains= qs[2].value?.data || [];
      govDomains  = qs[3].value?.data || [];
      bulkDomains = qs[4].value?.data || [];
      weights     = qs[5].value?.data || [];
    } else if (pg) {
      const c = await pg.connect();
      const q = async (sql) => (await c.query(sql)).rows;
      try {
        vipSenders   = await q('select email from vip_senders');
        vipDomains   = await q('select domain from vip_domains');
        legalDomains = await q('select domain from legal_domains');
        govDomains   = await q('select domain from government_domains');
        bulkDomains  = await q('select domain from bulk_domains');
        weights      = await q(`select kind, identity, pos, neg from mail_importance_feedback where user_id = '${userId.replace(/'/g,"''")}'`);
      } finally { c.release(); }
    }

    const vip = new Set([...rowsToSet(vipSenders, 'email'), ...rowsToSet(vipDomains, 'domain')]);
    const legal = rowsToSet(legalDomains, 'domain');
    const government = rowsToSet(govDomains, 'domain');
    const bulk = rowsToSet(bulkDomains, 'domain');

    // Convert feedback counts → logit weights (Bayesian prior α=2, β=3)
    const wEmail = new Map(), wDomain = new Map();
    (weights || []).forEach(r => {
      const pos = Number(r.pos) || 0, neg = Number(r.neg) || 0;
      const prob = (pos + 2) / (pos + neg + 5);                   // 0..1
      const logit = Math.log(Math.max(1e-6, prob / (1 - prob)));  // -∞..+∞
      const v = clamp(logit, -4, 4);                               // clamp
      if (String(r.kind) === 'email')  wEmail.set(String(r.identity).toLowerCase(), v);
      if (String(r.kind) === 'domain') wDomain.set(String(r.identity).toLowerCase(), v);
    });

    return { vip, legal, government, bulk, weights: { email: wEmail, domain: wDomain } };
  } catch (e) {
    console.warn('fetchListsFromSql failed:', e?.message || e);
    return { vip: new Set(), legal: new Set(), government: new Set(), bulk: new Set(),
             weights: { email: new Map(), domain: new Map() } };
  }
}

/** Normalize items to what the classifier expects */
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

// ---------- Routes ----------

/**
 * POST /api/imap/fetch
 * Body: { email, password|accessToken, host, port, tls, authType, rangeDays, limit, userId }
 * Resp: { items: [{ ...raw, classification:{} }], nextCursor?, hasMore? }
 */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password',
      rangeDays = 7, limit = 20, userId = 'default'
    } = req.body || {};

    const search = Number(rangeDays) > 0
      ? ['SINCE', new Date(Date.now() - Number(rangeDays) * 864e5)]
      : ['ALL'];

    const { items, nextCursor, hasMore } = await fetchEmails({
      email, password, accessToken, host, port, tls, authType, search, limit
    });

    // Personalization lists + learned weights
    const lists = await fetchListsFromSql(userId);

    // Classify on server so client gets ready-to-use items
    const norm = normalizeForClassifier(items);
    const cls = await classifyEmails(norm, { userId, lists });

    const merged = (items || []).map((it, i) => ({ ...it, classification: cls[i] || {} }));
    res.json({ items: merged, nextCursor: nextCursor || null, hasMore: !!hasMore });
  } catch (e) {
    console.error('IMAP /fetch error:', e?.message || e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

/**
 * POST /api/imap/test
 * Body: { email, password|accessToken, host, port, tls, authType }
 * Resp: { ok: true|false }
 */
router.post('/test', async (req, res) => {
  try {
    const { email = '', password = '', accessToken = '', host = '', port = 993, tls = true, authType = 'password' } = req.body || {};
    const ok = await testLogin({ email, password, accessToken, host, port, tls, authType });
    res.json({ ok: !!ok });
  } catch (e) {
    console.error('IMAP /test error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'IMAP login failed' });
  }
});

/**
 * POST /api/imap/classify
 * Body: { items, userId }
 * Resp: aligned array of classification objects
 */
router.post('/classify', async (req, res) => {
  try {
    const { items = [], userId = 'default' } = req.body || {};
    const lists = await fetchListsFromSql(userId);
    const norm = normalizeForClassifier(items);
    const results = await classifyEmails(norm, { userId, lists });
    res.json(results);
  } catch (e) {
    console.error('IMAP /classify error:', e?.message || e);
    res.status(500).json({ error: 'Classification failed' });
  }
});

/**
 * ⭐ POST /api/imap/feedback
 * Body: { label:'important'|'unimportant', fromEmail?, fromDomain?, userId? }
 * Learns user preference; SQL optional. No-op if DB not configured.
 */
router.post('/feedback', async (req, res) => {
  try {
    const { label, fromEmail = '', fromDomain = '', userId = 'default' } = req.body || {};
    if (!label || (!fromEmail && !fromDomain)) {
      return res.status(400).json({ ok: false, error: 'label and fromEmail/fromDomain required' });
    }
    const important = label === 'important';
    const pos = important ? 1 : 0;
    const neg = important ? 0 : 1;

    if (supa) {
      // Upsert then increment counts (Supabase doesn't support arithmetic in upsert values)
      if (fromEmail) {
        await supa.from('mail_importance_feedback')
          .upsert({ user_id: userId, kind: 'email', identity: fromEmail.toLowerCase(), pos: 0, neg: 0 }, { onConflict: 'user_id,kind,identity' });
        await supa.rpc('increment_feedback', { p_user_id: userId, p_kind: 'email', p_identity: fromEmail.toLowerCase(), p_pos: pos, p_neg: neg })
          .catch(async () => {
            // Fallback: fetch then update (best-effort)
            const { data } = await supa.from('mail_importance_feedback')
              .select('pos,neg').eq('user_id', userId).eq('kind', 'email').eq('identity', fromEmail.toLowerCase()).single();
            const curPos = Number(data?.pos) || 0, curNeg = Number(data?.neg) || 0;
            await supa.from('mail_importance_feedback')
              .update({ pos: curPos + pos, neg: curNeg + neg, updated_at: new Date().toISOString() })
              .eq('user_id', userId).eq('kind', 'email').eq('identity', fromEmail.toLowerCase());
          });
      }
      if (fromDomain) {
        await supa.from('mail_importance_feedback')
          .upsert({ user_id: userId, kind: 'domain', identity: fromDomain.toLowerCase(), pos: 0, neg: 0 }, { onConflict: 'user_id,kind,identity' });
        await supa.rpc('increment_feedback', { p_user_id: userId, p_kind: 'domain', p_identity: fromDomain.toLowerCase(), p_pos: pos, p_neg: neg })
          .catch(async () => {
            const { data } = await supa.from('mail_importance_feedback')
              .select('pos,neg').eq('user_id', userId).eq('kind', 'domain').eq('identity', fromDomain.toLowerCase()).single();
            const curPos = Number(data?.pos) || 0, curNeg = Number(data?.neg) || 0;
            await supa.from('mail_importance_feedback')
              .update({ pos: curPos + pos, neg: curNeg + neg, updated_at: new Date().toISOString() })
              .eq('user_id', userId).eq('kind', 'domain').eq('identity', fromDomain.toLowerCase());
          });
      }
    } else if (pg) {
      const c = await pg.connect();
      try {
        if (fromEmail) {
          await c.query(
            `insert into mail_importance_feedback(user_id, kind, identity, pos, neg)
             values ($1,'email',$2,$3,$4)
             on conflict (user_id, kind, identity)
             do update set pos = mail_importance_feedback.pos + EXCLUDED.pos,
                           neg = mail_importance_feedback.neg + EXCLUDED.neg,
                           updated_at = now()`,
            [userId, fromEmail.toLowerCase(), pos, neg]
          );
        }
        if (fromDomain) {
          await c.query(
            `insert into mail_importance_feedback(user_id, kind, identity, pos, neg)
             values ($1,'domain',$2,$3,$4)
             on conflict (user_id, kind, identity)
             do update set pos = mail_importance_feedback.pos + EXCLUDED.pos,
                           neg = mail_importance_feedback.neg + EXCLUDED.neg,
                           updated_at = now()`,
            [userId, fromDomain.toLowerCase(), pos, neg]
          );
        }
      } finally { c.release(); }
    } else {
      // No DB configured → accept to keep UI snappy
      console.log('[feedback] (no DB) %s email=%s domain=%s', label, fromEmail, fromDomain);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('IMAP /feedback error:', e?.message || e);
    res.status(500).json({ ok: false, error: 'failed to save feedback' });
  }
});

export default router;
