// emailClassifier.js — heuristic-first classifier with 'system' category + LLM batch cap
// Exports: classifyEmails(items, { userId, lists })
//
// Output (per item):
// { importance: 'important'|'unimportant'|'unclassified',
//   category: 'meeting'|'billing'|'security'|'newsletter'|'sales'|'social'|'legal'|'system'|'other',
//   intent: <same as category for back-compat>,
//   urgency: 0..3,
//   action_required: boolean,
//   confidence: 0..1,
//   reasons: [] }

const CATEGORY_SET = new Set([
  'meeting','billing','security','newsletter','sales','social','legal','system','other'
]);

const BATCH_MAX = 20; // cap undecided LLM batch size

export async function classifyEmails(items = [], ctx = {}) {
  const lists = ctx.lists || { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(), weights:{ email:new Map(), domain:new Map() } };

  // 1) Heuristics pass
  const base = items.map((e) => heuristicLabel(e, lists));

  // 2) Decide which need LLM
  const undecidedIdx = [];
  base.forEach((r, i) => {
    const lowConf = (r.confidence || 0) < 0.55;
    const uncls = r.importance === 'unclassified' || r.category === 'other';
    if (lowConf || uncls) undecidedIdx.push(i);
  });

  // Split into small batches to control latency/cost
  let llmResults = {};
  for (let i = 0; i < undecidedIdx.length; i += BATCH_MAX) {
    const slice = undecidedIdx.slice(i, i + BATCH_MAX);
    const prompts = slice.map(ix => items[ix]);
    const modelOut = await backstopLLM(prompts).catch(() => ({}));
    Object.assign(llmResults, remapByIndex(slice, modelOut));
  }

  // 3) Blend: prefer higher confidence; ensure category valid; back-compat 'intent'
  const out = base.map((r, i) => {
    const llm = llmResults[i];
    let best = r;
    if (llm && (llm.confidence || 0) > (r.confidence || 0)) best = llm;

    // Ensure category is known
    if (!CATEGORY_SET.has(best.category)) best.category = r.category || 'other';
    // Back-compat for frontend using 'intent'
    best.intent = best.category;

    // Priority hints: VIP or legal/government → bump importance if not unimportant
    if ((best.importance === 'unclassified' || best.importance === 'unimportant') &&
        (lists.vip.has((items[i].fromEmail || '').toLowerCase()) ||
         lists.legal.has((items[i].fromDomain || '').toLowerCase()) ||
         lists.government.has((items[i].fromDomain || '').toLowerCase()))) {
      best.importance = 'important';
      best.confidence = Math.max(best.confidence || 0.6, 0.7);
      best.reasons = (best.reasons || []).concat('sender priority list');
    }

    return best;
  });

  return out;
}

// ---------------- Heuristics ----------------
function heuristicLabel(e, lists) {
  const text = `${e.subject || ''} ${e.snippet || ''}`.toLowerCase();
  const dom = (e.fromDomain || '').toLowerCase();
  const email = (e.fromEmail || '').toLowerCase();

  const reasons = [];

  // Categories by domain
  if (lists.legal.has(dom)) reasons.push('legal domain');
  if (lists.government.has(dom)) reasons.push('government domain');
  if (lists.bulk.has(dom)) reasons.push('bulk sender');
  if (lists.vip.has(email) || lists.vip.has(dom)) reasons.push('vip sender');

  // Keyword maps
  const isMeeting = /\b(invite|meeting|calendar|schedule|zoom|google meet|teams)\b/.test(text) || (e.hasIcs === true);
  const isBilling = /\b(invoice|payment due|receipt|refund|transaction|billing|subscription)\b/.test(text);
  const isSecurity = /\b(password|2fa|security alert|unusual sign-in|breach|phishing)\b/.test(text);
  const isNewsletter = /\b(unsubscribe|newsletter|weekly digest|roundup)\b/.test(text);
  const isSales = /\b(sale|discount|% off|coupon|deal|promo)\b/.test(text);
  const isSocial = /\b(follow|mention|comment|like|friend request|new follower)\b/.test(text);

  // --- Minimal change: allow LEGAL by keywords as well as domain ---
  const isLegalText = /\b(legal|contract|agreement|terms|privacy|policy|gdpr|ccpa|subpoena|court|lawsuit|attorney|solicitor|notary|compliance|notice of|data processing addendum|dpa|nda)\b/.test(text);
  if (isLegalText) reasons.push('legal keywords');
  const isLegal = reasons.includes('legal domain') || isLegalText;
  // ---------------------------------------------------------------

  // NEW: “system” (devops/ops alerts)
  const isSystemByDomain = /^(render|vercel|netlify|heroku|railway|aws|amazon|gcp|google|cloudflare|pagerduty|datadog|sentry|github|gitlab|circleci|jenkins|statuspage)/i.test(dom);
  const isSystemByText = /\b(deploy(ed|ment)?|build failed|pipeline|outage|incident|alert|cron|backup|db fail|status page|service degraded|error rate)\b/.test(text);
  const isSystem = isSystemByDomain || isSystemByText;

  let category = 'other';
  if (isSystem) category = 'system';
  else if (isMeeting) category = 'meeting';
  else if (isBilling) category = 'billing';
  else if (isSecurity) category = 'security';
  else if (isNewsletter) category = 'newsletter';
  else if (isSales) category = 'sales';
  else if (isSocial) category = 'social';
  else if (isLegal) category = 'legal';

  // Urgency:
  let urgency = 0;
  if (isSystem && /\b(failed|outage|incident|degrade|urgent|action required)\b/.test(text)) urgency = 3;
  else if (isMeeting || /\b(asap|today|within 24 hours|expires|deadline)\b/.test(text)) urgency = 2;
  else if (isBilling && /\b(due|overdue|payment failed)\b/.test(text)) urgency = 2;

  // Importance baseline
  let importance = 'unclassified';
  if (category === 'system' || isSecurity || isBilling || isMeeting || isLegal) importance = 'important';
  else if (category === 'newsletter' || category === 'sales' || lists.bulk.has(dom)) importance = 'unimportant';

  // Action required
  const action_required =
    urgency >= 2 ||
    /\b(action required|please respond|reply needed|review needed)\b/.test(text) ||
    category === 'meeting';

  // Confidence: start mid, nudge with signals
  let confidence = 0.6;
  if (urgency >= 2) confidence += 0.1;
  if (reasons.includes('vip sender')) confidence += 0.1;
  if (category === 'other') confidence -= 0.1;

  return { importance, category, urgency, action_required, confidence: clamp01(confidence), reasons };
}

// ---------------- LLM backstop (optional) ----------------
// Replace with your actual call; keep the output fields aligned.
async function backstopLLM(items) {
  // Pseudo-LLM: return empty map if disabled to keep costs at zero.
  if (process.env.ENABLE_CLASSIFIER_LLM !== '1') return {};
  // Your real LLM integration goes here.
  // Must return an object keyed by local index { 0: {...}, 1:{...} }
  return {};
}

function remapByIndex(indexes, resultsObj) {
  const out = {};
  indexes.forEach((ix, j) => {
    const r = resultsObj[j];
    if (!r) return;
    out[ix] = alignOutput(r);
  });
  return out;
}

function alignOutput(r) {
  const importance = oneOf(r.importance, ['important','unimportant','unclassified'], 'unclassified');
  const category = oneOf(r.category, Array.from(CATEGORY_SET), 'other');
  const urgency = clampInt(r.urgency, 0, 3);
  const action_required = !!r.action_required;
  const confidence = clamp01(r.confidence ?? 0.6);
  const reasons = Array.isArray(r.reasons) ? r.reasons.slice(0, 8) : [];
  return { importance, category, urgency, action_required, confidence, reasons, intent: category };
}

function oneOf(v, arr, d) { return arr.includes(v) ? v : d; }
function clampInt(n, a, b){ n = parseInt(n,10); if (Number.isNaN(n)) return a; return Math.max(a, Math.min(b, n)); }
function clamp01(x){ x = Number(x)||0; return Math.max(0, Math.min(1, x)); }
