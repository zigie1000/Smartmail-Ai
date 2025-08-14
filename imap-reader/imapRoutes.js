// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails, testLogin } from './imapService.js';
import { classifyEmails, configureClassifier } from './emailClassifier.js';

// Optional DB clients (works if env is present). Uses Supabase if configured, else tries Postgres, else no-op.
import { createClient as createSupabase } from '@supabase/supabase-js';
import pkgPg from 'pg';
const { Pool } = pkgPg;

const router = express.Router();

// --- DB bootstrap (optional, safe if missing) ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createSupabase(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;
const pg = (!supa && POSTGRES_URL)
  ? new Pool({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized:false } })
  : null;

// Translate rows -> sets/maps
function rowsToSet(rows, key){ return new Set((rows||[]).map(r => String(r[key]||'').toLowerCase()).filter(Boolean)); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

async function fetchListsFromSql(userId='default'){
  try{
    // Tables are optional; we guard each query.
    let vipSenders=[], vipDomains=[], legalDomains=[], govDomains=[], bulkDomains=[], weights=[];
    if (supa){
      const qs = await Promise.allSettled([
        supa.from('vip_senders').select('email'),
        supa.from('vip_domains').select('domain'),
        supa.from('legal_domains').select('domain'),
        supa.from('government_domains').select('domain'),
        supa.from('bulk_domains').select('domain'),
        supa.from('mail_importance_feedback').select('kind,identity,pos,neg').eq('user_id', userId)
      ]);
      vipSenders = qs[0].value?.data||[];
      vipDomains = qs[1].value?.data||[];
      legalDomains = qs[2].value?.data||[];
      govDomains  = qs[3].value?.data||[];
      bulkDomains = qs[4].value?.data||[];
      weights     = qs[5].value?.data||[];
    } else if (pg){
      const c = await pg.connect();
      const doq = async (sql)=> (await c.query(sql)).rows;
      try{
        vipSenders   = await doq(`select email from vip_senders`);
        vipDomains   = await doq(`select domain from vip_domains`);
        legalDomains = await doq(`select domain from legal_domains`);
        govDomains   = await doq(`select domain from government_domains`);
        bulkDomains  = await doq(`select domain from bulk_domains`);
        weights      = await doq(`select kind, identity, pos, neg from mail_importance_feedback where user_id = '${userId.replace(/'/g,"''")}'`);
      } finally { c.release(); }
    }

    const vip = new Set([...rowsToSet(vipSenders,'email'), ...rowsToSet(vipDomains,'domain')]);
    const legal = rowsToSet(legalDomains,'domain');
    const government = rowsToSet(govDomains,'domain');
    const bulk = rowsToSet(bulkDomains,'domain');

    // Convert feedback rows → logit weights
    const wEmail = new Map(), wDomain = new Map();
    (weights||[]).forEach(r => {
      const pos = Number(r.pos)||0, neg = Number(r.neg)||0;
      const prob = (pos + 2) / (pos + neg + 5); // Beta(2,3) prior
      const logit = Math.log(Math.max(1e-6, prob/(1-prob)));
      const v = clamp(logit, -4, 4);
      if (String(r.kind)==='email')  wEmail.set(String(r.identity).toLowerCase(), v);
      if (String(r.kind)==='domain') wDomain.set(String(r.identity).toLowerCase(), v);
    });

    return { vip, legal, government, bulk, weights: { email: wEmail, domain: wDomain } };
  }catch(e){
    console.warn('fetchListsFromSql failed', e?.message||e);
    return { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(), weights:{email:new Map(), domain:new Map()} };
  }
}

// If the host app wants to use the classifier’s hook globally:
configureClassifier({ fetchLists: fetchListsFromSql });

// ---------- Helpers ----------
function normalizeItemsForClassifier(items){
  // shape the minimal fields the classifier expects
  return items.map((e,i)=>({
    id: e.id ?? e.uid ?? String(i+1),
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

// POST /api/imap/fetch  -> returns { items:[{... classification }], hasMore?, nextCursor? }
router.post('/fetch', async (req,res) => {
  try{
    const { email='', password='', accessToken='', host='', port=993, tls=true, authType='password', rangeDays=7, limit=20, importantFirst=false, userId='default' } = req.body||{};
    const search = Number(rangeDays)>0 ? ['SINCE', new Date(Date.now()-Number(rangeDays)*864e5)] : ['ALL'];

    const { items, nextCursor, hasMore } = await fetchEmails({
      email, password, accessToken, host, port, tls, authType, search, limit, importantFirst
    });

    // Personalization lists + weights
    const lists = await fetchListsFromSql(userId);

    // Classify here so the client gets ready-to-use items
    const normalized = normalizeItemsForClassifier(items);
    const cls = await classifyEmails(normalized, { userId, lists });

    // Attach classification back
    const merged = items.map((it, i) => ({ ...it, classification: cls[i] || {} }));

    res.json({ items: merged, nextCursor: nextCursor || null, hasMore: !!hasMore });
  }catch(e){
    console.error('IMAP /fetch error:', e?.message||e);
    res.status(500).json({ error:'Fetch failed' });
  }
});

// POST /api/imap/test -> { ok:true }
router.post('/test', async (req,res) => {
  try{
    const { email='', password='', accessToken='', host='', port=993, tls=true, authType='password' } = req.body||{};
    const ok = await testLogin({ email, password, accessToken, host, port, tls, authType });
    res.json({ ok: !!ok });
  }catch(e){
    console.error('IMAP /test error:', e?.message||e);
    res.status(500).json({ ok:false, error:'IMAP login failed' });
  }
});

// POST /api/imap/classify -> returns array of aligned objects
router.post('/classify', async (req,res) => {
  try{
    const { items=[], userId='default' } = req.body||{};
    const lists = await fetchListsFromSql(userId);
    const normalized = normalizeItemsForClassifier(items);
    const results = await classifyEmails(normalized, { userId, lists });
    res.json(results);
  }catch(e){
    console.error('IMAP /classify error:', e?.message||e);
    res.status(500).json({ error:'Classification failed' });
  }
});

// ⭐ POST /api/imap/feedback -> saves user mark (important/unimportant) for email+domain
router.post('/feedback', async (req,res) => {
  try{
    const { label, fromEmail='', fromDomain='', userId='default' } = req.body||{};
    if (!label || (!fromEmail && !fromDomain)) return res.status(400).json({ ok:false, error:'label and fromEmail/fromDomain required' });

    const important = label === 'important';
    const pos = important ? 1 : 0;
    const neg = important ? 0 : 1;

    if (supa){
      if (fromEmail) {
        await supa.from('mail_importance_feedback').upsert({ user_id:userId, kind:'email', identity: fromEmail.toLowerCase(), pos, neg }, { onConflict:'user_id,kind,identity' });
        // increment counters (upsert replaces; so do a plus)
        await supa.rpc('increment_feedback', { p_user_id:userId, p_kind:'email', p_identity:fromEmail.toLowerCase(), p_pos:pos, p_neg:neg }).catch(()=>{});
      }
      if (fromDomain) {
        await supa.from('mail_importance_feedback').upsert({ user_id:userId, kind:'domain', identity: fromDomain.toLowerCase(), pos, neg }, { onConflict:'user_id,kind,identity' });
        await supa.rpc('increment_feedback', { p_user_id:userId, p_kind:'domain', p_identity:fromDomain.toLowerCase(), p_pos:pos, p_neg:neg }).catch(()=>{});
      }
    } else if (pg){
      const c = await pg.connect();
      try{
        if (fromEmail) {
          await c.query(`
            insert into mail_importance_feedback(user_id, kind, identity, pos, neg)
            values ($1,'email',$2,$3,$4)
            on conflict (user_id, kind, identity)
            do update set pos = mail_importance_feedback.pos + EXCLUDED.pos,
                          neg = mail_importance_feedback.neg + EXCLUDED.neg,
                          updated_at = now()
          `, [userId, fromEmail.toLowerCase(), pos, neg]);
        }
        if (fromDomain) {
          await c.query(`
            insert into mail_importance_feedback(user_id, kind, identity, pos, neg)
            values ($1,'domain',$2,$3,$4)
            on conflict (user_id, kind, identity)
            do update set pos = mail_importance_feedback.pos + EXCLUDED.pos,
                          neg = mail_importance_feedback.neg + EXCLUDED.neg,
                          updated_at = now()
          `, [userId, fromDomain.toLowerCase(), pos, neg]);
        }
      } finally { c.release(); }
    } else {
      // No DB configured — still succeed so UI stays snappy.
      console.log('[feedback] (no DB) label=%s email=%s domain=%s', label, fromEmail, fromDomain);
    }

    res.json({ ok:true });
  }catch(e){
    console.error('IMAP /feedback error:', e?.message||e);
    res.status(500).json({ ok:false, error:'failed to save feedback' });
  }
});

export default router;
