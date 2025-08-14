// imap-reader/emailClassifier.js
// Accuracy-focused classifier: rules first, LLM second, strict JSON, per-item calls.

import fetch from 'node-fetch';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini';

// ---------- Types & alignment ----------
function alignOutput(raw) {
  const def = {
    importance: 'unclassified',   // 'important' | 'unimportant' | 'unclassified'
    intent: 'other',              // 'billing'|'meeting'|'sales'|'support'|'hr'|'legal'|'security'|'newsletter'|'social'|'other'
    urgency: 0,                   // 0..3
    action_required: false,
    confidence: 0.5,
    reasons: []
  };
  if (!raw || typeof raw !== 'object') return def;

  const out = { ...def };

  const imp = String(raw.importance || '').toLowerCase();
  if (['important','unimportant','unclassified'].includes(imp)) out.importance = imp;

  const allowedIntents = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  const intent = String(raw.intent || '').toLowerCase();
  out.intent = allowedIntents.has(intent) ? intent : 'other';

  const urg = Number(raw.urgency);
  out.urgency = Number.isFinite(urg) ? Math.max(0, Math.min(3, Math.round(urg))) : 0;

  out.action_required = !!raw.action_required;

  const conf = Number(raw.confidence);
  out.confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;

  if (Array.isArray(raw.reasons)) {
    out.reasons = raw.reasons.map(x => String(x)).slice(0, 6);
  } else if (raw.reasons) {
    out.reasons = [String(raw.reasons)];
  }
  return out;
}

// ---------- Heuristics (fast path) ----------
const KNOWN_SENDERS = [
  // newsletters / notifications
  /@news\./i, /@updates\./i, /no-reply@/i, /noreply@/i, /info@/i,
  /@promotions\./i, /@marketing\./i, /@mailer\./i, /@mail\./i
];

const NEWSLETTER_DOMAINS = [
  'members.netflix.com', 'netflix.com', 'property24.com', 'news.google.com',
  'medium.com', 'substack.com', 'mailchimp.com', 'sendgrid.net'
];

const BILLING_KEYWORDS = /(invoice|payment|paid|unpaid|overdue|refund|charge|billing|receipt|statement)/i;
const MEETING_KEYWORDS = /(meeting|call|zoom|teams|google meet|schedule|reschedule|calendar|invite)/i;
const SALES_KEYWORDS   = /(quote|pricing|proposal|order|purchase|rfq|rfi|tender|lead)/i;
const SUPPORT_KEYWORDS = /(issue|bug|error|help|support|urgent|down|outage)/i;
const LEGAL_KEYWORDS   = /(contract|nda|legal|policy|compliance|gdpr|popia|terms|arbitration|litigation)/i;
const SECURITY_KEYWORDS= /(security|breach|phishing|compromised|password|2fa|mfa|login attempt)/i;
const HR_KEYWORDS      = /(cv|resume|recruit|interview|offer|onboarding|leave|payroll)/i;
const SOCIAL_KEYWORDS  = /(facebook|twitter|x\.com|instagram|linkedin|tiktok|youtube)/i;

const URGENCY_UP = /(due today|due tomorrow|overdue|suspended|final notice|failed payment|action required|respond within|24 hours|immediately)/i;

function heuristicClassify(e) {
  // Normalize
  const subj = (e.subject || '').toLowerCase();
  const snip = (e.snippet || '').toLowerCase();
  const from = (e.from || '').toLowerCase();
  const domain = (e.fromDomain || '').toLowerCase();
  const email = (e.fromEmail || '').toLowerCase();

  const reasons = [];

  // Newsletter / alerts
  if (KNOWN_SENDERS.some(rx => rx.test(from) || rx.test(email)) || NEWSLETTER_DOMAINS.includes(domain)) {
    let urgency = 0;
    let importance = 'unimportant';
    let action_required = false;

    if (URGENCY_UP.test(subj) || URGENCY_UP.test(snip)) {
      urgency = 1;
      importance = 'unclassified';
      action_required = true;
      reasons.push('newsletter but contains action/urgency keywords');
    } else {
      reasons.push('recognized newsletter/notification sender');
    }
    return {
      importance,
      intent: 'newsletter',
      urgency,
      action_required,
      confidence: 0.8,
      reasons
    };
  }

  // Intent by keywords
  if (BILLING_KEYWORDS.test(subj) || BILLING_KEYWORDS.test(snip)) {
    const urgent = URGENCY_UP.test(subj) || URGENCY_UP.test(snip);
    reasons.push('billing keywords matched');
    return {
      importance: urgent ? 'important' : 'unclassified',
      intent: 'billing',
      urgency: urgent ? 2 : 1,
      action_required: urgent,
      confidence: 0.8,
      reasons
    };
  }
  if (MEETING_KEYWORDS.test(subj) || MEETING_KEYWORDS.test(snip)) {
    const urgent = /(starts in|starts at|today|tomorrow)/i.test(subj + ' ' + snip);
    reasons.push('meeting/scheduling keywords matched');
    return {
      importance: urgent ? 'important' : 'unclassified',
      intent: 'meeting',
      urgency: urgent ? 2 : 1,
      action_required: true,
      confidence: 0.75,
      reasons
    };
  }
  if (SALES_KEYWORDS.test(subj) || SALES_KEYWORDS.test(snip)) {
    reasons.push('sales keywords matched');
    return {
      importance: 'unclassified',
      intent: 'sales',
      urgency: 1,
      action_required: /reply|respond/i.test(subj + ' ' + snip),
      confidence: 0.7,
      reasons
    };
  }
  if (SUPPORT_KEYWORDS.test(subj) || SUPPORT_KEYWORDS.test(snip)) {
    const urgent = /(down|outage|critical|urgent|immediately)/i.test(subj + ' ' + snip);
    reasons.push('support keywords matched');
    return {
      importance: urgent ? 'important' : 'unclassified',
      intent: 'support',
      urgency: urgent ? 3 : 2,
      action_required: true,
      confidence: 0.8,
      reasons
    };
  }
  if (LEGAL_KEYWORDS.test(subj) || LEGAL_KEYWORDS.test(snip)) {
    reasons.push('legal keywords matched');
    return { importance: 'unclassified', intent: 'legal', urgency: 1, action_required: true, confidence: 0.7, reasons };
  }
  if (SECURITY_KEYWORDS.test(subj) || SECURITY_KEYWORDS.test(snip)) {
    reasons.push('security keywords matched');
    return { importance: 'important', intent: 'security', urgency: 2, action_required: true, confidence: 0.85, reasons };
  }
  if (HR_KEYWORDS.test(subj) || HR_KEYWORDS.test(snip)) {
    reasons.push('hr keywords matched');
    return { importance: 'unclassified', intent: 'hr', urgency: 1, action_required: true, confidence: 0.7, reasons };
  }
  if (SOCIAL_KEYWORDS.test(subj) || SOCIAL_KEYWORDS.test(snip)) {
    reasons.push('social keywords matched');
    return { importance: 'unimportant', intent: 'social', urgency: 0, action_required: false, confidence: 0.7, reasons };
  }

  // No confident heuristic → ask model
  return null;
}

// ---------- LLM prompt ----------
function systemPrompt() {
  return [
    "You are an expert email triage assistant.",
    "Return ONLY valid JSON for ONE email classification.",
    "Schema:",
    "{ id: string,",
    "  importance: 'important'|'unimportant'|'unclassified',",
    "  intent: 'billing'|'meeting'|'sales'|'support'|'hr'|'legal'|'security'|'newsletter'|'social'|'other',",
    "  urgency: 0|1|2|3,",
    "  action_required: boolean,",
    "  confidence: number (0..1),",
    "  reasons: string[] }",
    "Rules:",
    "- 'important' = time-sensitive/financial/security/commitment risk;",
    "- 'unimportant' = promotions/newsletters without clear actions;",
    "- 'unclassified' = neutral/general info.",
    "Be strict and consistent. No prose."
  ].join(' ');
}

function userPrompt(one) {
  // Tight, single-item prompt to prevent cross-item leakage
  return [
    `Classify this email. id="${one.id}"`,
    `From: ${one.from || ''}`,
    one.fromEmail ? `From-Email: ${one.fromEmail}` : '',
    one.fromDomain ? `From-Domain: ${one.fromDomain}` : '',
    `Subject: ${one.subject || ''}`,
    `Snippet: ${(one.snippet || '').slice(0, 900)}`,
    one.date ? `Date: ${one.date}` : '',
    "",
    "Return only the JSON object."
  ].filter(Boolean).join('\n');
}

// ---------- OpenAI call (strict JSON) ----------
async function classifyWithModel(one, apiKey) {
  try {
    const resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(one) }
        ],
        temperature: 0.0,
        top_p: 1,
        response_format: { type: 'json_object' },
        max_tokens: 220
      })
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error('Classifier error:', resp.status, text);
      return null;
    }
    const json = safeJson(text)?.choices?.[0]?.message?.content;
    const obj = safeJson(json);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.id !== one.id) obj.id = one.id;
    return obj;
  } catch (e) {
    console.error('Classifier fetch error:', e?.message || e);
    return null;
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------- Public API ----------
/**
 * Classify an array of emails.
 * @param {Array<{id?:string,subject:string, from:string, fromEmail:string, fromDomain:string, snippet:string, date?:string}>} items
 * @returns {Promise<Array<ReturnType<typeof alignOutput>>>}
 */
export async function classifyEmails(items) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!apiKey) {
    // No key: heuristic only
    return items.map(e => alignOutput(heuristicClassify(e) || {}));
  }

  // Per-item classification to avoid array bleed
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    const one = { ...e, id: e.id || String(i + 1) };

    // 1) Heuristic fast path
    const h = heuristicClassify(one);
    if (h) { results.push(alignOutput(h)); continue; }

    // 2) Model (strict JSON)
    const m = await classifyWithModel(one, apiKey);
    if (m) { results.push(alignOutput(m)); continue; }

    // 3) Fallback neutral
    results.push(alignOutput({}));
  }
  return results;
}
