// imapRoutes.js — IMAP fetch/classify with tier check (email or licenseKey),
// free-tier caps, paid-only personalization, and feedback learning.
// Works with Supabase (service key) OR Postgres (DATABASE_URL). If neither set,
// IMAP still runs, but personalization/feedback are no-ops.

import express from 'express';
import crypto from 'crypto';
import { fetchEmails, testLogin } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

// ---------- Optional DB clients ----------
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

// ---------- Utils ----------
const router = express.Router();
const APP_ID = 'imap'; // for logs/future use

const sha256 = (s) => crypto.createHash('sha256').update(String(s||'')).digest('hex');
const mailboxHash = (email) => sha256(String(email).trim().toLowerCase());
const userIdFromEmail = (email) => mailboxHash(email); // user scope for learning

function rowsToSet(rows, key) {
  return new Set((rows || [])
    .map(r => String(r[key] || '').toLowerCase())
    .filter(Boolean));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// --- Tier helpers ---
// Prefer license key; fall back to (a) previously-linked mailbox, then (b) legacy "email row in licenses".
async function getTier({ licenseKey = '', email = '' }) {
  const em = String(email || '').toLowerCase();
  const mh = em ? mailboxHash(em) : null;

  // 1) License key direct lookup
  try {
    if (licenseKey) {
      if (supa) {
        const { data, error } = await supa
          .from('licenses')
          .select('smartemail_tier, license_key')
          .eq('license_key', licenseKey)
          .maybeSingle();
        if (!error && data) return String(data.smartemail_tier || 'free').toLowerCase();
      } else if (pg) {
        const c = await pg.connect(); try {
          const r = await c.query(
            'select smartemail_tier from public.licenses where license_key=$1 limit 1',
            [licenseKey]
          );
          if (r.rows[0]) return String(r.rows[0].smartemail_tier || 'free').toLowerCase();
        } finally { c.release(); }
      }
    }
  } catch (e) { console.warn('tier by key failed:', e?.message || e); }

  // 2) Linked mailbox → license
  try {
    if (mh) {
      if (supa) {
        const { data: link } = await supa
          .from('license_mailboxes')
          .select('license_key')
          .eq('mailbox_hash', mh)
          .limit(1).maybeSingle();
        if (link?.license_key) {
          const { data: lic } = await supa
            .from('licenses')
            .select('smartemail_tier')
            .eq('license_key', link.license_key)
            .maybeSingle();
          if (lic) return String(lic.smartemail_tier || 'free').toLowerCase();
        }
      } else if (pg) {
        const c = await pg.connect(); try {
          const r = await c.query(
            `select l.smartemail_tier
               from license_mailboxes lm
               join public.licenses l on l.license_key = lm.license_key
              where lm.mailbox_hash = $1
              limit 1`,
            [mh]
          );
          if (r.rows[0]) return String(r.rows[0].smartemail_tier || 'free').toLowerCase();
        } finally { c.release(); }
      }
    }
  } catch (e) { console.warn('tier by mailbox failed:', e?.message || e); }

  // 3) Legacy: tier by email row
  try {
    if (em) {
      if (supa) {
        const { data } = await supa
          .from('licenses')
          .select('smartemail_tier')
          .eq('email', em)
          .maybeSingle();
        if (data) return String(data.smartemail_tier || 'free').toLowerCase();
      } else if (pg) {
        const c = await pg.connect(); try {
          const r = await c.query(
            `select smartemail_tier
               from public.licenses
              where lower(email)=lower($1)
              order by created_at desc
              limit 1`, [em]
          );
          if (r.rows[0]) return String(r.rows[0].smartemail_tier || 'free').toLowerCase();
        } finally { c.release(); }
      }
    }
  } catch (e) { console.warn('tier by email failed:', e?.message || e); }

  return 'free';
}

async function isPaid(tier) {
  if (process.env.PAID_FEATURES_FOR_ALL === '1') return true;
  return tier && tier !== 'free';
}

// Personalization lists + learned weights (paid users only)
async function fetchListsFromSql(userId = 'default') {
  const empty = { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
                  weights:{ email:new Map(), domain:new Map() } };
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
      vipSenders   = qs[0].value?.data || [];
      vipDomains   = qs[1].value?.data || [];
      legalDomains = qs[2].value?.data || [];
      govDomains   = qs[3].value?.data || [];
      bulkDomains  = qs[4].value?.data || [];
      weights      = qs[5].value?.data || [];
    } else if (pg) {
      const c = await pg.connect(); try {
        const q = (sql) => c.query(sql).then(r => r.rows);
        vipSenders   = await q('select email from vip_senders');
        vipDomains   = await q('select domain from vip_domains');
        legalDomains = await q('select domain from legal_domains');
        govDomains   = await q('select domain from government_domains');
        bulkDomains  = await q('select domain from bulk_domains');
        weights      = await c.query(
          'select kind, identity, pos, neg from mail_importance_feedback where user_id=$1',
          [userId]
        ).then(r => r.rows);
      } finally { c.release(); }
    } else {
      return empty;
    }

    const vip = new Set([...rowsToSet(vipSenders, 'email'), ...rowsToSet(vipDomains, 'domain')]);
    const legal = rowsToSet(legalDomains, 'domain');
    const government = rowsToSet(govDomains, 'domain');
    const bulk = rowsToSet(bulkDomains, 'domain');

    const wEmail = new Map(), wDomain = new Map();
    (weights || []).forEach(r => {
      const pos = Number(r.pos) || 0, neg = Number(r.neg) || 0;
      const prob = (pos + 2) / (pos + neg + 5);                   // Beta(2,3)
      const logit = Math.log(Math.max(1e-6, prob / (1 - prob)));  // -∞..+∞
      const v = clamp(logit, -4, 4);
      if (String(r.kind) === 'email')  wEmail.set(String(r.identity).toLowerCase(), v);  // hashed or plain
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

// Quick tier lookup (by email and/or licenseKey)
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

// Fetch + classify (paid: personalization; free: caps)
router.post('/fetch', async (req, res) => {
  try {
    const {
      email = '', password = '', accessToken = '',
      host = '', port = 993, tls = true, authType = 'password',
      licenseKey = '' // NEW: optional
    } = req.body || {};

    // Determine tier
    const tier = await getTier({ licenseKey, email });
    const paid = await isPaid(tier);

    // If paid with a licenseKey, link this mailbox for future keyless logins
    try {
      if (paid && licenseKey && email) {
        if (supa) {
          await supa.from('license_mailboxes')
            .upsert({ license_key: licenseKey, mailbox_hash: mailboxHash(email) },
                    { onConflict: 'license_key,mailbox_hash' });
        } else if (pg) {
          const c = await pg.connect(); try {
            await c.query(
              `insert into license_mailboxes(license_key, mailbox_hash)
               values ($1,$2) on conflict do nothing`,
              [licenseKey, mailboxHash(email)]
            );
          } finally { c.release(); }
        }
      }
    } catch (e) { console.warn('link mailbox failed:', e?.message || e); }

    // Apply free caps (range/limit/throttle)
    const userId = userIdFromEmail(email);
    const caps = applyFreeCapsIfNeeded(tier, req.body);
    if (caps.isFree && caps.minFetchMs > 0) {
      const now = Date.now();
      const last = lastFetchAt.get(userId) || 0;
      if (now - last < caps.minFetchMs) {
        const wait = Math.ceil((caps.minFetchMs - (now - last))/1000);
        return res.status(429).json({ error: `Please wait ${wait}s (free plan limit).` });
      }
      lastFetchAt.set(userId, now);
    }

    const search = Number(req.body.rangeDays) > 0
      ? ['SINCE', new Date(Date.now() - Number(req.body.rangeDays) * 864e5)]
      : ['ALL'];

    const { items, nextCursor, hasMore } = await fetchEmails({
      email, password, accessToken, host, port, tls, authType,
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

// Test IMAP creds
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

// Classify client-provided items (paid users get personalization)
router.post('/classify', async (req, res) => {
  try {
    const { items = [], email: mailboxEmail = '', licenseKey = '' } = req.body || {};
    const tier = await getTier({ licenseKey, email: mailboxEmail });
    const paid = await isPaid(tier);
    const userId = userIdFromEmail(mailboxEmail);
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

// ⭐ Feedback (paid only)
router.post('/feedback', async (req, res) => {
  try {
    const { label, fromEmail = '', fromDomain = '', email: ownerEmail = '', licenseKey = '' } = req.body || {};
    const tier = await getTier({ licenseKey, email: ownerEmail });
    const paid = await isPaid(tier);
    if (!paid) {
      return res.status(402).json({ ok:false, error: 'Upgrade to enable learning (Important ⭐).' });
    }
    if (!label || (!fromEmail && !fromDomain)) {
      return res.status(400).json({ ok:false, error: 'label and fromEmail/fromDomain required' });
    }

    const userId = userIdFromEmail(ownerEmail);
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
        // Fallback: best-effort manual upsert (plain identities if you didn’t add hashing)
        const payload = { user_id:userId, kind:(fromEmail?'email':'domain'), identity:(fromEmail||fromDomain).toLowerCase(), pos:0, neg:0 };
        await supa.from('mail_importance_feedback').upsert(payload, { onConflict: 'user_id,kind,identity' });
        await supa.from('mail_importance_feedback')
          .update({ pos: pos, neg: neg, updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('kind', payload.kind).eq('identity', payload.identity);
      }
    } else if (pg) {
      const c = await pg.connect(); try {
        await c.query(
          `insert into mail_importance_feedback(user_id, kind, identity, pos, neg)
           values ($1,$2, lower($3), $4, $5)
           on conflict (user_id, kind, identity)
           do update set
             pos = mail_importance_feedback.pos + EXCLUDED.pos,
             neg = mail_importance_feedback.neg + EXCLUDED.neg,
             updated_at = now()`,
          [userId, (fromEmail?'email':'domain'), (fromEmail||fromDomain), pos, neg]
        );
      } finally { c.release(); }
    } else {
      console.log('[feedback] no DB, ignored');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('IMAP /feedback error:', e?.message || e);
    res.status(500).json({ ok:false, error: 'failed to save feedback' });
  }
});

export default router;
