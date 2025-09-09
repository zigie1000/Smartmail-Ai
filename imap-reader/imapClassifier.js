// imapClassifier.js — heuristic-first classifier with expanded filters
// Exports: classifyEmails(items, { lists })
//
// Output per item merges cleanly into your IMAP objects via Object.assign:
// {
//   importance: 'important'|'unimportant'|'unclassified',
//   category:   'meeting'|'billing'|'security'|'newsletter'|'sales'|'social'|'legal'|'system'|'other',
//   intent:     <same as category>,
//   urgency:    0..3,
//   action_required: boolean,
//   confidence: 0..1,
//   reasons:    string[],
//   labels:     string[]     // ← added for UI chips: VIP, Finance, Legal, Important, etc.
// }

const CATEGORY_SET = new Set([
  'meeting', 'billing', 'security', 'newsletter', 'sales', 'social', 'legal', 'system', 'other'
]);

const BATCH_MAX = 20; // cap undecided LLM batch size

// ---------------- helpers ----------------
function oneOf(v, arr, d){ return arr.includes(v) ? v : d; }
function clampInt(n,a,b){ n = parseInt(n,10); if (Number.isNaN(n)) return a; return Math.max(a, Math.min(b, n)); }
function clamp01(x){ x = Number(x)||0; return Math.max(0, Math.min(1, x)); }

function endsWithOne(host, suffixes){
  const h = String(host||'').toLowerCase();
  return suffixes.some(s => h.endsWith(s));
}
function hasGovTld(dom){
  return /\.gov(\.|$)|\.gouv|\.govt|\.gob\.|\.mil(\.|$)|\.gov\.uk|\.gov\.au/i.test(dom||'');
}
function hasAny(str, regexes){
  const s = String(str || '');
  return regexes.some(r => r.test(s));
}

// Vendor/domain lists (kept short; we match by suffix)
const SOCIAL_DOMAINS = [
  'facebookmail.com','facebook.com','messenger.com','instagram.com','threads.net',
  'tiktok.com','youtube.com','linkedin.com','link.linkedin.com','x.com','twitter.com',
  'pinterest.com','reddit.com','nextdoor.com','discord.com','slack.com'
];
const SYSTEM_DOMAINS = [
  'render.com','vercel.com','netlify.com','heroku.com','railway.app',
  'amazonaws.com','aws.amazon.com','google.com','cloudflare.com',
  'pagerduty.com','datadoghq.com','sentry.io','github.com','gitlab.com',
  'circleci.com','jenkins.io','statuspage.io','statuspage.com','postmarkapp.com'
];
const BILLING_DOMAINS = [
  'stripe.com','paypal.com','squareup.com','paddle.com','chargebee.com',
  'quickbooks.com','xero.com','sage.com','gocardless.com','wise.com','revolut.com'
];

// ---------------- core API ----------------
export async function classifyEmails(items = [], ctx = {}) {
  const lists = ctx.lists || {
    vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(),
    weights: { email:new Map(), domain:new Map() }
  };

  // 1) Heuristics
  const base = items.map((e) => heuristicLabel(e, lists));

  // 2) Optional LLM backstop (disabled unless ENABLE_CLASSIFIER_LLM=1)
  const undecidedIdx = [];
  base.forEach((r,i) => {
    const lowConf = (r.confidence || 0) < 0.55;
    const uncls = r.importance === 'unclassified' || r.category === 'other';
    if (lowConf || uncls) undecidedIdx.push(i);
  });

  let llmResults = {};
  for (let i = 0; i < undecidedIdx.length; i += BATCH_MAX) {
    const slice = undecidedIdx.slice(i, i + BATCH_MAX);
    const prompts = slice.map(ix => items[ix]);
    const modelOut = await backstopLLM(prompts).catch(() => ({}));
    Object.assign(llmResults, remapByIndex(slice, modelOut));
  }

  // 3) Blend + finalize (+ derive labels)
  const out = base.map((r,i) => {
    const llm = llmResults[i];
    let best = r;
    if (llm && (llm.confidence || 0) > (r.confidence || 0)) best = llm;

    // Ensure known category + intent
    if (!CATEGORY_SET.has(best.category)) best.category = r.category || 'other';
    best.intent = best.category;

    // VIP / legal / government bump if not marked unimportant
    const em = String(items[i]?.fromEmail || '').toLowerCase();
    const dom = String(items[i]?.fromDomain || '').toLowerCase();
    const isSpecial =
      lists.vip.has(em) || lists.vip.has(dom) ||
      lists.legal.has(dom) || lists.government.has(dom);

    if (isSpecial && best.importance !== 'unimportant') {
      best.importance = 'important';
      best.confidence = Math.max(best.confidence || 0.6, 0.7);
      best.reasons = (best.reasons || []).concat('sender priority list');
    }

    // ---- derive UI labels (so your current imapRoutes merge is enough) ----
    const labels = new Set(best.labels || []);
    // category → labels
    switch (best.category) {
      case 'billing':    labels.add('Finance'); break;
      case 'legal':      labels.add('Legal'); break;
      case 'meeting':    labels.add('Meetings'); break;
      case 'newsletter': labels.add('Newsletters'); break;
      case 'sales':      labels.add('Sales'); break;
      case 'security':   labels.add('Security'); break;
      case 'system':     labels.add('System'); break;
      case 'social':     labels.add('Social'); break;
      default: break;
    }
    // reasons → labels
    (best.reasons || []).forEach(rsn => {
      if (rsn === 'vip sender')        labels.add('VIP');
      if (rsn === 'government domain') labels.add('Government');
      if (rsn === 'legal domain')      labels.add('Legal');
      if (rsn === 'bulk sender')       labels.add('Newsletters');
    });
    // sender-based VIP convenience
    if (lists.vip.has(em) || lists.vip.has(dom)) labels.add('VIP');

    // importance → labels
    if (best.importance === 'important')   labels.add('Important');
    if (best.importance === 'unimportant') labels.add('Low Priority');

    best.labels = Array.from(labels);
    return best;
  });

  return out;
}

// ---------------- Heuristics ----------------
function heuristicLabel(e, lists) {
  const text = `${e.subject || ''} ${e.snippet || ''}`.toLowerCase();
  const dom  = (e.fromDomain || '').toLowerCase();
  const email= (e.fromEmail  || '').toLowerCase();
  const reasons = [];

  // Domain cues (lists first)
  if (lists.legal.has(dom)) reasons.push('legal domain');
  if (lists.government.has(dom) || hasGovTld(dom)) reasons.push('government domain');
  if (lists.bulk.has(dom)) reasons.push('bulk sender');
  if (lists.vip.has(email) || lists.vip.has(dom)) reasons.push('vip sender');

  // Domain families
  const isSocialByDom  = endsWithOne(dom, SOCIAL_DOMAINS);
  const isSystemByDom  = endsWithOne(dom, SYSTEM_DOMAINS);
  const isBillingByDom = endsWithOne(dom, BILLING_DOMAINS);

  // Keyword families
  const meetRx = [
    /\b(invite|meeting|calendar|schedule|zoom|google\s?meet|gmeet|teams|webex)\b/i,
    /\b(ics|\.ics)\b/i
  ];
  const billingRx = [
    /\b(invoice|statement|payment\s?(due|failed|declined)|receipt|refund|transaction|billing)\b/i,
    /\b(subscription|renewal|direct\s?debit|transfer|wire|balance\s?due|overdue)\b/i
  ];
  const securityRx = [
    /\b(password|passcode|otp|one[-\s]?time\s?code|2fa|mfa)\b/i,
    /\b(security\s?alert|suspicious\s?(sign[-\s]?in|login)|unusual\s?sign[-\s]?in|new\s?device)\b/i,
    /\b(account\s?(locked|lockout)|verify\s?your\s?account)\b/i
  ];
  const newsletterRx = [
    /\b(unsubscribe|manage\s?preferences|newsletter|weekly\s?digest|roundup|bulletin|blog\s?update)\b/i
  ];
  const salesRx = [
    /\b(sale|discount|%+\s?off|percent\s?off|coupon|promo(\s?code)?|deal|clearance|free\s?shipping|flash\s?sale|today\s?only)\b/i
  ];
  const socialRx = [
    /\b(follow|mention|comment|like|friend\s?request|new\s?follower|connect|connection\s?request|dm|message\s?you)\b/i
  ];

  // Legal / Compliance / TAX (serious)
  const complianceRx = [
    /\b(gdpr|privacy\s?policy|terms\s?of\s?service|data\s?processing\s?addendum|dpa|dmca|copyright\s?notice|legal\s?notice)\b/i,
    /\b(subpoena|court\s?order|cease\s?and\s?desist|arbitration|settlement)\b/i
  ];
  const taxRx = [
    /\b(tax|vat|gst|paye|withholding|self[-\s]?assessment)\b/i,
    /\b(irs|hmrc|revenue|customs|companies\s?house)\b/i,
    /\b(w[-\s]?9|w[-\s]?8|1099|ein|itin|sa100|ct600)\b/i
  ];

  // DevOps/alerts
  const systemRx = [
    /\b(deploy(ed|ment)?|build\s?failed|pipeline|ci\/cd)\b/i,
    /\b(outage|incident|alert|on[-\s]?call|status\s?page|service\s?degraded)\b/i,
    /\b(cron|backup|db\s?fail|error\s?rate|latency|health\s?check)\b/i
  ];

  const isMeeting    = hasAny(text, meetRx) || (e.hasIcs === true);
  const isBilling    = isBillingByDom || hasAny(text, billingRx);
  const isSecurity   = hasAny(text, securityRx);
  const isNewsletter = hasAny(text, newsletterRx);
  const isSales      = hasAny(text, salesRx);
  const isSocial     = isSocialByDom || hasAny(text, socialRx);
  const isCompliance = hasAny(text, complianceRx);
  const isTax        = hasAny(text, taxRx);
  const isLegalDomain= reasons.includes('legal domain') || reasons.includes('government domain');
  const isSystem     = isSystemByDom || hasAny(text, systemRx);

  // Category priority (highest wins)
  let category = 'other';
  if (isSystem) category = 'system';
  else if (isMeeting) category = 'meeting';
  else if (isBilling) category = 'billing';
  else if (isSecurity) category = 'security';
  else if (isNewsletter) category = 'newsletter';
  else if (isSales) category = 'sales';
  else if (isSocial) category = 'social';
  else if (isCompliance || isTax || isLegalDomain) category = 'legal';

  // Urgency
  let urgency = 0;
  if (isSystem && /\b(failed|outage|incident|degrade|urgent|action\s?required)\b/i.test(text)) urgency = 3;
  else if (isMeeting || /\b(asap|today|within\s?24\s?hours|expires|deadline|due\s?by)\b/i.test(text)) urgency = 2;
  else if (isBilling && /\b(due|overdue|payment\s?failed)\b/i.test(text)) urgency = 2;
  else if (isTax && /\b(due|deadline|late|penalty|file|submit)\b/i.test(text)) urgency = 2;

  // Importance
  let importance = 'unclassified';
  if (category === 'system' || isSecurity || isBilling || isMeeting || isTax || isCompliance) {
    importance = 'important';
  } else if (category === 'newsletter' || category === 'sales' || lists.bulk.has(dom)) {
    importance = 'unimportant';
  }

  // Action required
  const action_required =
    urgency >= 2 ||
    /\b(action\s?required|please\s?(respond|reply|review|confirm)|reply\s?needed|review\s?needed)\b/i.test(text) ||
    category === 'meeting';

  // Confidence tweaks
  let confidence = 0.6;
  if (urgency >= 2) confidence += 0.1;
  if (reasons.includes('vip sender')) confidence += 0.1;
  if (category === 'other') confidence -= 0.1;

  return {
    importance,
    category,
    urgency,
    action_required,
    confidence: clamp01(confidence),
    reasons
  };
}

// ---------------- LLM backstop (optional) ----------------
async function backstopLLM(items){
  if (process.env.ENABLE_CLASSIFIER_LLM !== '1') return {};
  // plug your real model here; must return object keyed by local index: { 0:{...}, 1:{...} }
  return {};
}
function remapByIndex(indexes, resultsObj){
  const out = {};
  indexes.forEach((ix,j) => {
    const r = resultsObj[j];
    if (!r) return;
    out[ix] = alignOutput(r);
  });
  return out;
}
function alignOutput(r){
  const importance = oneOf(r.importance, ['important','unimportant','unclassified'], 'unclassified');
  const category   = oneOf(r.category, Array.from(CATEGORY_SET), 'other');
  const urgency    = clampInt(r.urgency, 0, 3);
  const action_required = !!r.action_required;
  const confidence = clamp01(r.confidence ?? 0.6);
  const reasons    = Array.isArray(r.reasons) ? r.reasons.slice(0, 8) : [];
  return { importance, category, urgency, action_required, confidence, reasons, intent: category };
}

export default { classifyEmails };
