// imap-reader/emailClassifier.js
// Advanced, robust email classifier used by /api/imap/classify
// - Strict JSON shaping with fallbacks
// - Batching + truncation + retries
// - Deterministic labels for UI chips/filters
// ESM compatible

import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ---------- Tunables (env overrides) ----------
const MODEL = process.env.SMARTEMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini';
// Keep small to avoid timeouts and token bloat on Render free tier
const MAX_BATCH = clampInt(process.env.SMARTEMAIL_MAX_BATCH, 20, 1, 50);
const MAX_SUBJECT = clampInt(process.env.SMARTEMAIL_MAX_SUBJECT, 200, 40, 400);
const MAX_SNIPPET = clampInt(process.env.SMARTEMAIL_MAX_SNIPPET, 1200, 200, 6000);
const TIMEOUT_MS = clampInt(process.env.SMARTEMAIL_CLASSIFIER_TIMEOUT_MS, 25000, 5000, 60000);
const MAX_RETRIES = clampInt(process.env.SMARTEMAIL_MAX_RETRIES, 2, 0, 5);

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}

// ---------- Public API ----------
/**
 * classifyEmails(items: Array<{
 *   subject?: string, from?: string, fromEmail?: string, fromDomain?: string,
 *   to?: string, cc?: string, date?: string, snippet?: string, text?: string, html?: string
 * }>) => Promise<Array<Classification>>
 *
 * Classification:
 * {
 *   importance: "important" | "unimportant",
 *   intent?: "billing"|"meeting"|"sales"|"support"|"hr"|"legal"|"security"|"newsletter"|"social"|"other",
 *   urgency?: 0|1|2|3,
 *   action_required?: boolean,
 *   entities?: { amount?: string, dateTime?: string, company?: string, thread?: boolean },
 *   confidence?: number,         // 0..1
 *   reasons?: string[]           // 1-3 concise bullets
 * }
 */
export async function classifyEmails(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Prepare & batch
  const cleaned = items.map(sanitizeEmailForModel);
  const batches = chunk(cleaned, MAX_BATCH);

  const out = [];
  for (const batch of batches) {
    const batchResult = await classifyBatchWithRetries(batch);
    out.push(...alignOutput(batch, batchResult));
  }

  // Ensure exact 1:1 length
  if (out.length < items.length) {
    const delta = items.length - out.length;
    // pad with neutral defaults
    out.push(...Array.from({ length: delta }, () => neutralDefault()));
  } else if (out.length > items.length) {
    out.length = items.length;
  }

  return out;
}

// ---------- Core batch classify with retries ----------
async function classifyBatchWithRetries(batch) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const sys = systemPrompt();
      const user = userPrompt(batch);

      const resp = await client.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 700,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        // AbortController works for fetch, OpenAI SDK also forwards signal
        signal: controller.signal
      });

      clearTimeout(to);

      const raw = (resp.choices?.[0]?.message?.content || '').trim();
      const parsed = safeJsonArray(raw);

      // Validate count
      if (Array.isArray(parsed) && parsed.length === batch.length) {
        return parsed.map(normalizeOne);
      }

      // If lengths mismatch, try to rescue best-effort by expanding/fixing
      const rescued = coerceLength(parsed, batch.length);
      if (rescued) return rescued.map(normalizeOne);

      // As a last resort, produce neutral defaults for the whole batch
      return Array.from({ length: batch.length }, () => neutralDefault());
    } catch (err) {
      lastErr = err;
      // brief backoff
      await sleep(250 * (attempt + 1));
    }
  }

  // Fully failed: return defaults
  console.error('Classifier error:', lastErr?.message || lastErr);
  return Array.from({ length: batch.length }, () => neutralDefault());
}

// ---------- Prompts ----------
function systemPrompt() {
  return `
You are an email triage assistant. For each email, output a JSON array of objects with fields:

- "importance": "important" | "unimportant"
- "intent": one of ["billing","meeting","sales","support","hr","legal","security","newsletter","social","other"]
- "urgency": integer 0..3  (0 none, 1 low, 2 soon, 3 urgent)
- "action_required": boolean
- "entities": object with optional keys: amount (string), dateTime (string), company (string), thread (boolean)
- "confidence": number 0..1
- "reasons": array of 1-3 short bullet strings

Heuristics (be precise, conservative on confidence):
IMPORTANT if:
  - time-sensitive (deadlines, interviews, meetings, RSVP/invites <48h),
  - legal/security (contracts, password reset, verification codes, policy),
  - finance (invoice, refund, payment, billing),
  - direct reply/mention in an ongoing thread,
  - customer/partner escalations.

UNIMPORTANT if:
  - bulk promotions, newsletters, social notifications, digests (unless part of active thread or contains critical action).

Intent guide:
  - billing: invoices, payments, receipts, quotes
  - meeting: scheduling, invites, agenda, calendar
  - sales: leads, demos, pricing, proposals (outbound/inbound)
  - support: tickets, bugs, incidents, “help”, “issue”
  - hr: recruiting, offers, interviews, references, benefits
  - legal: contracts, terms, compliance, NDAs
  - security: auth, 2FA, alerts, breach, reset
  - newsletter: campaign, digest, promotional send
  - social: social network notifications
  - other: anything else

Return ONLY a JSON array with the same length and order as the input. No prose. No markdown. No code fences.
If unsure between important/unimportant, prefer "important" but lower "confidence".
`.trim();
}

function userPrompt(batch) {
  // Give the model the trimmed batch as a JSON array of email objects
  return `Classify these emails. Keep output strictly as JSON array with same length:\n${JSON.stringify(batch)}`;
}

// ---------- Helpers ----------

// Sanitize & truncate each email item for the model
function sanitizeEmailForModel(e) {
  const subject = (e.subject || '').toString().slice(0, MAX_SUBJECT);
  const bodyRaw = firstNonEmpty([e.snippet, e.text, stripHtml(e.html)]);
  const body = (bodyRaw || '').toString().slice(0, MAX_SNIPPET);

  // Named fields help the model infer better intents
  return {
    subject,
    from: (e.from || '').toString(),
    fromEmail: (e.fromEmail || guessFromEmail(e.from)).toString(),
    fromDomain: (e.fromDomain || guessDomain(e.from, e.fromEmail)).toString(),
    to: (e.to || '').toString(),
    cc: (e.cc || '').toString(),
    date: (e.date || '').toString(),
    snippet: body
  };
}

function firstNonEmpty(arr) {
  for (const v of arr) {
    if (v && String(v).trim()) return String(v);
  }
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function guessFromEmail(from = '') {
  const m = String(from).match(/<([^>]+)>/);
  return (m && m[1]) || from;
}

function guessDomain(from = '', fromEmail = '') {
  const fe = fromEmail || guessFromEmail(from);
  const d = (String(fe).split('@')[1] || '').trim();
  return d;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Robust JSON extraction: try direct parse; if it fails, try to extract the first JSON array substring.
function safeJsonArray(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
  } catch {}
  // try to extract [ ... ] block
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const j = JSON.parse(slice);
      if (Array.isArray(j)) return j;
    } catch {}
  }
  return null;
}

// Ensure output length equals input batch length
function coerceLength(arr, needed) {
  if (!Array.isArray(arr)) return null;
  if (arr.length === needed) return arr;
  if (arr.length > needed) return arr.slice(0, needed);
  // pad with defaults
  const pad = Array.from({ length: needed - arr.length }, () => neutralDefault());
  return [...arr, ...pad];
}

function normalizeOne(x) {
  const imp = /important/i.test(x?.importance) ? 'important' : 'unimportant';
  let intent = String(x?.intent || '').toLowerCase();
  if (!INTENTS.has(intent)) intent = bestEffortIntent(x);

  let urgency = toInt(x?.urgency);
  if (urgency < 0 || urgency > 3 || Number.isNaN(urgency)) urgency = 0;

  const action_required = typeof x?.action_required === 'boolean'
    ? x.action_required
    : inferActionRequired(imp, urgency, x);

  let confidence = clamp01(toFloat(x?.confidence));
  if (Number.isNaN(confidence)) confidence = imp === 'important' ? 0.65 : 0.55;

  const reasons = Array.isArray(x?.reasons) ? x.reasons.slice(0, 3).map(s => String(s).slice(0, 160)) : undefined;

  const entities = typeof x?.entities === 'object' && x?.entities
    ? {
        amount: takeStr(x.entities.amount),
        dateTime: takeStr(x.entities.dateTime),
        company: takeStr(x.entities.company),
        thread: typeof x.entities.thread === 'boolean' ? x.entities.thread : undefined
      }
    : undefined;

  return { importance: imp, intent, urgency, action_required, entities, confidence, reasons };
}

function neutralDefault() {
  return {
    importance: 'unimportant',
    intent: 'other',
    urgency: 0,
    action_required: false,
    confidence: 0.5
  };
}

const INTENTS = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);

function bestEffortIntent(x) {
  const blob = [x?.reasons?.join(' '), x?.hint, JSON.stringify(x)].join(' ').toLowerCase();
  if (/invoice|receipt|payment|charge|quote|billing|refund|po\b/.test(blob)) return 'billing';
  if (/meet|calendar|invite|schedule|zoom|teams|agenda|rsvp/.test(blob)) return 'meeting';
  if (/lead|demo|pricing|proposal|opportunity|pipeline|sales/.test(blob)) return 'sales';
  if (/support|ticket|bug|issue|incident|outage|downtime|help/.test(blob)) return 'support';
  if (/\bhr\b|recruit|candidate|interview|offer|benefit|payroll/.test(blob)) return 'hr';
  if (/nda|contract|legal|compliance|policy|gdpr|dpa/.test(blob)) return 'legal';
  if (/2fa|otp|verification code|security alert|reset password|breach|suspicious/.test(blob)) return 'security';
  if (/unsubscribe|newsletter|digest|campaign/.test(blob)) return 'newsletter';
  if (/twitter|x\.com|facebook|linkedin|instagram|tiktok|follow you|mentioned you/.test(blob)) return 'social';
  return 'other';
}

function inferActionRequired(importance, urgency, x) {
  if (urgency >= 2) return true;
  const r = (Array.isArray(x?.reasons) ? x.reasons.join(' ') : '').toLowerCase();
  if (/\b(action required|please respond|reply needed|due|deadline|approve|review)\b/.test(r)) return true;
  return importance === 'important';
}

function toInt(v) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : NaN; }
function toFloat(v) { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : NaN; }
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function takeStr(v) { return typeof v === 'string' ? v.slice(0, 160) : undefined; }

export default { classifyEmails };
