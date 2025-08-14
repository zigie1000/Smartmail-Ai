// imap-reader/emailClassifier.js
// Heuristic-first + LLM fallback; VIP/Legal/Gov/Bulk lists; learned weights; safe JSON; no 'signal' in body.

import fetch from 'node-fetch';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL_DEFAULT = process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini';

// Optional hook so the host app can inject list loaders (SQL) at startup.
// Signature: async fetchLists(userId) => { vip:Set, bulk:Set, legal:Set, government:Set, weights:{email:Map,domain:Map} }
let fetchListsHook = null;
export function configureClassifier({ fetchLists } = {}) {
  if (typeof fetchLists === 'function') fetchListsHook = fetchLists;
}

// ---------- util ----------
function safeJson(s){ try{ return JSON.parse(s); } catch{ return null; } }

function alignOutput(raw){
  const def = { importance:'unclassified', intent:'other', urgency:0, action_required:false, confidence:0.5, reasons:[] };
  if (!raw || typeof raw!=='object') return def;
  const out = { ...def };
  const imp = String(raw.importance||'').toLowerCase();
  if (['important','unimportant','unclassified'].includes(imp)) out.importance = imp;
  const intents = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  const intent = String(raw.intent||'').toLowerCase();
  out.intent = intents.has(intent) ? intent : 'other';
  const urg = Number(raw.urgency); out.urgency = Number.isFinite(urg)? Math.max(0,Math.min(3,Math.round(urg))) : 0;
  out.action_required = !!raw.action_required;
  const conf = Number(raw.confidence); out.confidence = Number.isFinite(conf)? Math.max(0,Math.min(1,conf)) : 0.5;
  if (Array.isArray(raw.reasons)) out.reasons = raw.reasons.map(x=>String(x)).slice(0,8);
  else if (raw.reasons) out.reasons = [String(raw.reasons)];
  return out;
}

// ---------- regexes & helpers ----------
const MARKETING_INFRAS = /(sendgrid|mailchimp|amazonses|postmarkapp|sparkpost|mandrill|convertkit|klaviyo|substack|campaign-monitor|constantcontact)/i;
const NOREPLY = /(^|\b)no-?reply@/i;

const GOV_TAX_KW = /(tax( office| authority)?|revenue service|sars|hmrc|irs|customs|department of (state|home|labor|labour)|treasury|social security)/i;
const LAW_FIRM_KW = /(attorney|barrister|solicitor|advocate|law firm|llp|legal (notice|demand|action)|subpoena|court|arbitration|settlement|nda|contract)/i;
const BILLING_KW = /(invoice|payment|paid|unpaid|overdue|refund|charge|billing|receipt|statement|credit note|debit note)/i;
const SECURITY_KW = /(password reset|unusual sign[- ]in|mfa code|2fa code|verify login|account (locked|suspended)|phishing|breach|compromised)/i;
const MEETING_KW = /(meeting|call|zoom|teams|google meet|calendar|invite|ics|reschedule|schedule)/i;
const SALES_KW = /(quote|pricing|proposal|order|purchase|rfq|rfi|tender|lead)/i;
const SUPPORT_KW = /(ticket|support|issue|bug|down|outage|escalation|sev)/i;
const DEADLINE_KW = /(today|tomorrow|by eod|within 24 hours|final notice|overdue|due (date|today|tomorrow)|respond (within|by))/i;

function getHeader(obj, key){
  if (!obj) return '';
  if (typeof obj.get === 'function') return String(obj.get(key)||'');
  return String(obj[key]||'');
}
function extractSignals(e){
  const subj = (e.subject||'');
  const body = (e.snippet||'');
  const text = subj + '\n' + body;

  const fromEmail = (e.fromEmail||'').toLowerCase();
  const fromDomain = (e.fromDomain||'').toLowerCase();
  const headers = e.headers || {};

  const h = {
    listId: getHeader(headers,'list-id'),
    listUnsub: getHeader(headers,'list-unsubscribe'),
    precedence: getHeader(headers,'precedence'),
    autoSubmitted: getHeader(headers,'auto-submitted'),
    inReplyTo: getHeader(headers,'in-reply-to'),
    references: getHeader(headers,'references'),
    contentType: getHeader(headers,'content-type')
  };

  const hasListHeaders = !!(h.listId || h.listUnsub || /bulk|list|auto_reply/i.test(h.precedence) || /auto-submitted/i.test(h.autoSubmitted));
  const isNoReply = NOREPLY.test(fromEmail) || NOREPLY.test(e.from || '');

  return { subj, body, text, fromEmail, fromDomain, headers: h, hasListHeaders, isNoReply };
}
function guessIntentByRegex(text, headers){
  if (BILLING_KW.test(text)) return 'billing';
  if (MEETING_KW.test(text) || /text\/calendar/i.test(headers?.contentType||'') || /ics/i.test(text)) return 'meeting';
  if (SUPPORT_KW.test(text)) return 'support';
  if (SECURITY_KW.test(text)) return 'security';
  if (LAW_FIRM_KW.test(text)) return 'legal';
  if (GOV_TAX_KW.test(text)) return 'legal';
  if (/newsletter|unsubscribe/i.test(text) || headers?.listId) return 'newsletter';
  if (SALES_KW.test(text)) return 'sales';
  return 'other';
}
function guessUrgencyByRegex(text){
  if (/(final notice|suspended|overdue|today|within 24)/i.test(text)) return 3;
  if (/(tomorrow|by eod|respond within|due (soon|date))/i.test(text)) return 2;
  if (/(invoice|meeting|schedule|reply)/i.test(text)) return 1;
  return 0;
}

function scoreEmail(e, sets){
  const { text, fromEmail, fromDomain, headers, hasListHeaders, isNoReply } = extractSignals(e);
  const vip = sets.vip, bulk = sets.bulk, legal = sets.legal, government = sets.government;

  let w = 0, reasons = [];

  // Learned weights (Bayesian) from feedback
  const wEmail  = sets.weights?.email?.get(fromEmail)  ?? 0;
  const wDomain = sets.weights?.domain?.get(fromDomain) ?? 0;
  if (wEmail)  { w += wEmail * 1.5; reasons.push('learned(email)'); }
  if (wDomain) { w += wDomain * 1.0; reasons.push('learned(domain)'); }

  // VIP/legal/gov lists
  if (vip.has(fromEmail) || vip.has(fromDomain)) { w += 7; reasons.push('vip sender'); }
  if (legal.has(fromEmail) || legal.has(fromDomain)) { w += 6; reasons.push('legal sender'); }
  if (government.has(fromEmail) || government.has(fromDomain)) { w += 6; reasons.push('gov/tax sender'); }

  // Thread signals
  if (headers.inReplyTo || headers.references) { w += 3; reasons.push('thread / reply'); }

  // Calendar/attachments
  if (e.hasIcs || /text\/calendar/i.test(e.contentType||'')) { w += 5; reasons.push('calendar'); }
  if ((e.attachTypes||[]).some(t => /application\/pdf/i.test(t))) { w += 2; reasons.push('pdf'); }

  // Keywords
  if (BILLING_KW.test(text)) { w += 5; reasons.push('billing'); }
  if (SECURITY_KW.test(text)) { w += 6; reasons.push('security'); }
  if (LAW_FIRM_KW.test(text)) { w += 4; reasons.push('legal content'); }
  if (GOV_TAX_KW.test(text)) { w += 4; reasons.push('gov/tax'); }
  if (DEADLINE_KW.test(text)) { w += 3; reasons.push('deadline'); }
  if (SUPPORT_KW.test(text)) { w += 3; reasons.push('support'); }

  // Demotions
  if (bulk.has(fromDomain) || MARKETING_INFRAS.test(fromDomain)) { w -= 5; reasons.push('marketing infra'); }
  if (hasListHeaders) { w -= 6; reasons.push('list/bulk headers'); }
  if (isNoReply) { w -= 3; reasons.push('noreply'); }

  // Recency
  if (e.date) {
    const hours = Math.max(0, (Date.now() - new Date(e.date).getTime())/36e5);
    w += Math.max(0, 18 - Math.min(72, hours)) * 0.1;
  }

  const intent = guessIntentByRegex(text, headers);
  const urgency = guessUrgencyByRegex(text);
  return { w, reasons, intent, urgency };
}

function heuristicClassify(e, sets){
  const { w, reasons, intent, urgency } = scoreEmail(e, sets);
  if (w >= 8){
    return alignOutput({
      importance:'important',
      intent, urgency,
      action_required: urgency>=1 || ['billing','security','legal'].includes(intent),
      confidence:0.9, reasons
    });
  }
  if (w <= -5){
    return alignOutput({
      importance:'unimportant',
      intent: intent==='newsletter' ? 'newsletter' : intent,
      urgency:0, action_required:false, confidence:0.85, reasons
    });
  }
  return null;
}

// ---------- LLM fallback ----------
function buildSystemPrompt(){
  return [
    "You are an email triage assistant.",
    "Return ONLY JSON with:",
    "{importance:'important'|'unimportant'|'unclassified', intent:'billing'|'meeting'|'sales'|'support'|'hr'|'legal'|'security'|'newsletter'|'social'|'other', urgency:0|1|2|3, action_required:boolean, confidence:number, reasons:string[]}.",
    "Important: time-sensitive, money/security/legal, government/tax, VIP, calendar within 48h, requires action.",
    "Unimportant: newsletters/promotions/bulk (List-Id/List-Unsubscribe/Precedence: bulk), marketing infra, noreply.",
    "Prefer 'legal' for lawyers/law firms, court, NDA/contracts, or government/tax offices.",
    "Be strict and concise."
  ].join(' ');
}
const FEW_SHOTS = [
  {role:'user', content:"From: noreply@mailer.bigshop.com\nSubject: 40% OFF SALE\nHeaders: List-Id: bigshop\nSnippet: Save big…"},
  {role:'assistant', content: JSON.stringify({importance:'unimportant', intent:'newsletter', urgency:0, action_required:false, confidence:0.96, reasons:['promo','List-Id']})},
  {role:'user', content:"From: travel@airline.com\nSubject: Boarding pass for tomorrow 07:40\nSnippet: Your flight departs…"},
  {role:'assistant', content: JSON.stringify({importance:'important', intent:'other', urgency:2, action_required:true, confidence:0.93, reasons:['time-sensitive travel']})},
  {role:'user', content:"From: accounts@lawfirm-llp.com\nSubject: Signed NDA attached\nSnippet: Please countersign by EOD…"},
  {role:'assistant', content: JSON.stringify({importance:'important', intent:'legal', urgency:2, action_required:true, confidence:0.92, reasons:['legal document','deadline']})},
  {role:'user', content:"From: notices@govtax.gov\nSubject: Tax assessment 2024\nSnippet: Payment due 30 Sept…"},
  {role:'assistant', content: JSON.stringify({importance:'important', intent:'legal', urgency:3, action_required:true, confidence:0.94, reasons:['government/tax','payment due']})}
];

async function classifyWithModel(items, modelName = MODEL_DEFAULT){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return items.map(()=>alignOutput({}));

  const userContent = [
    "Classify these emails. Return a JSON array of length N in the SAME ORDER.",
    "Fields: importance, intent, urgency, action_required, confidence, reasons.",
    "",
    ...items.map((e, idx) => {
      const parts = [
        `#${idx + 1}`,
        `From: ${e.from || ''}`,
        e.fromEmail ? `From-Email: ${e.fromEmail}` : '',
        e.fromDomain ? `From-Domain: ${e.fromDomain}` : '',
        `Subject: ${e.subject || ''}`,
        e.headers ? `Headers: ${JSON.stringify(e.headers).slice(0, 400)}` : '',
        `Snippet: ${(e.snippet || '').slice(0, 1000)}`
      ].filter(Boolean);
      return parts.join('\n');
    })
  ].join('\n\n');

  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(), 15000);
  try{
    const resp = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {role:'system', content: buildSystemPrompt()},
          ...FEW_SHOTS,
          {role:'user', content: userContent}
        ],
        temperature: 0,
        max_tokens: 350
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await resp.text();
    const data = safeJson(text);
    if(!resp.ok){
      console.error('Classifier error:', resp.status, data?.error || text);
      return items.map(()=>alignOutput({}));
    }
    const content = data?.choices?.[0]?.message?.content || '[]';
    const parsed = safeJson(content);
    if (!Array.isArray(parsed)) return items.map(()=>alignOutput({}));
    return items.map((_,i)=>alignOutput(parsed[i]));
  }catch(err){
    clearTimeout(timeout);
    console.error('Classifier fetch error:', err?.message || err);
    return items.map(()=>alignOutput({}));
  }
}

// ---------- public API ----------
export async function classifyEmails(items, options = {}){
  const { userId = 'default', model = MODEL_DEFAULT, topModelN = 60 } = options;

  // 0) load sets/weights (empty defaults)
  let lists = {
    vip: new Set(),
    bulk: new Set(['mailchimp.com','sendgrid.net','substack.com','medium.com']),
    legal: new Set(),
    government: new Set(),
    weights: { email:new Map(), domain:new Map() }
  };
  try{
    if (options.lists) {
      ['vip','bulk','legal','government'].forEach(k=>{ if(options.lists[k]) lists[k] = new Set([...options.lists[k]]); });
      if (options.lists.weights){
        lists.weights = {
          email: new Map(options.lists.weights.email || []),
          domain: new Map(options.lists.weights.domain || [])
        };
      }
    } else if (fetchListsHook) {
      const loaded = await fetchListsHook(userId);
      if (loaded && typeof loaded === 'object') {
        if (loaded.vip) lists.vip = new Set([...loaded.vip]);
        if (loaded.bulk) lists.bulk = new Set([...(loaded.bulk), ...lists.bulk]);
        if (loaded.legal) lists.legal = new Set([...loaded.legal]);
        if (loaded.government) lists.government = new Set([...loaded.government]);
        if (loaded.weights) lists.weights = {
          email: new Map(loaded.weights.email || []),
          domain: new Map(loaded.weights.domain || [])
        };
      }
    }
  }catch(e){ console.warn('fetchLists failed:', e?.message||e); }

  if (!Array.isArray(items) || !items.length) return [];

  // 1) heuristic for all
  const heur = items.map((e,i)=>({i, res: heuristicClassify(e, lists)}));

  // 2) uncertain → model
  const undecided = heur.filter(x=>!x.res).map(x=>x.i);
  const topN = undecided.slice(0, Math.min(topModelN, undecided.length));
  const toModel = topN.map(i=>items[i]);

  let modelOut = [];
  if (toModel.length) modelOut = await classifyWithModel(toModel, model);

  const byIdx = new Map();
  topN.forEach((i,k)=>byIdx.set(i, modelOut[k] || alignOutput({})));

  // 3) merge
  const results = items.map((_,i)=>alignOutput(heur[i]?.res || byIdx.get(i) || {}));
  return results;
}
