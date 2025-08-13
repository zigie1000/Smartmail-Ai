// imap-reader/emailClassifier.js
// State-of-the-art(ish) zero-API-dep classifier using OpenAI Chat Completions.
// - No 'signal' inside JSON body (fixes 400 "Unrecognized request argument: signal")
// - Defines alignOutput() locally (fixes "alignOutput is not defined")
// - Robust prompts + safe fallbacks

import fetch from 'node-fetch';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini';

/**
 * Align and harden the model's output into a small, typed object.
 * We map unknown values to safe defaults so the UI never explodes.
 */
function alignOutput(raw) {
  const def = {
    importance: 'unclassified',   // 'important' | 'unimportant' | 'unclassified'
    intent: 'other',               // billing | meeting | sales | support | hr | legal | security | newsletter | social | other
    urgency: 0,                    // 0..3
    action_required: false,        // boolean
    confidence: 0.5,               // 0..1
    reasons: []                    // string[]
  };

  if (!raw || typeof raw !== 'object') return def;

  const out = { ...def };

  const imp = String(raw.importance || '').toLowerCase();
  if (imp === 'important' || imp === 'unimportant') out.importance = imp;
  else if (imp === 'unclassified') out.importance = 'unclassified';

  const intent = String(raw.intent || '').toLowerCase();
  const INTENTS = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  out.intent = INTENTS.has(intent) ? intent : 'other';

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

/**
 * Build a compact system prompt for classification.
 */
function buildSystemPrompt() {
  return [
    "You are an email triage assistant.",
    "Classify each email with this JSON shape:",
    "{importance: 'important'|'unimportant'|'unclassified',",
    " intent: 'billing'|'meeting'|'sales'|'support'|'hr'|'legal'|'security'|'newsletter'|'social'|'other',",
    " urgency: 0..3, action_required: boolean, confidence: 0..1, reasons: string[]}",
    "Be terse. Only output JSON — no prose."
  ].join(' ');
}

/**
 * Classify a batch of emails.
 * @param {Array<{subject:string, from:string, fromEmail:string, fromDomain:string, snippet:string, date?:string}>} items
 * @returns {Promise<Array<Aligned>>}
 */
export async function classifyEmails(items) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No key: return neutral defaults so UI still works
    return items.map(() => alignOutput({}));
  }

  if (!Array.isArray(items) || items.length === 0) return [];

  // Build one prompt message per email to let the model see each record clearly.
  // We’ll ask it to return a JSON array of results in the same order.
  const userContent = [
    "Classify these emails. Return a JSON array of length N with objects in the exact same order.",
    "Fields: importance, intent, urgency, action_required, confidence, reasons.",
    "",
    ...items.map((e, idx) => {
      const L = [
        `#${idx + 1}`,
        `From: ${e.from || ''}`,
        e.fromEmail ? `From-Email: ${e.fromEmail}` : '',
        e.fromDomain ? `From-Domain: ${e.fromDomain}` : '',
        `Subject: ${e.subject || ''}`,
        `Snippet: ${e.snippet || ''}`.slice(0, 800),
        e.date ? `Date: ${e.date}` : ''
      ].filter(Boolean);
      return L.join('\n');
    })
  ].join('\n\n');

  // AbortController for request timeout (but **do not** put 'signal' into JSON body!)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s is fine for free-tier

  let resp, data, text;
  try {
    resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      // IMPORTANT: only the model payload in the body — no 'signal' property here.
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 300
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    text = await resp.text();
    data = safeJson(text);

    if (!resp.ok) {
      // If OpenAI rejected, fall back safely
      console.error('Classifier error:', resp.status, data?.error || text);
      return items.map(() => alignOutput({}));
    }

    const content = data?.choices?.[0]?.message?.content || '[]';
    const parsed = safeJson(content);
    if (!Array.isArray(parsed)) {
      return items.map(() => alignOutput({}));
    }
    // Align each result safely
    const out = items.map((_, i) => alignOutput(parsed[i]));
    return out;
  } catch (err) {
    clearTimeout(timeout);
    // Abort / network — just return neutral defaults so UI remains usable
    console.error('Classifier fetch error:', err?.message || err);
    return items.map(() => alignOutput({}));
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
