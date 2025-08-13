// imap-reader/emailClassifier.js
import fetch from 'node-fetch';

/**
 * classifyEmails(items)
 * items: [{ subject, from, fromEmail, fromDomain, to, cc, date, snippet }]
 * returns an array (same length) of objects adding:
 *   { importance: "important"|"unimportant",
 *     intent: "billing"|"meeting"|"sales"|"support"|"hr"|"legal"|"security"|"newsletter"|"social"|"other",
 *     urgency: 0|1|2|3,
 *     action_required: boolean,
 *     confidence: number (0..1),
 *     reasons: string[] }
 */
export async function classifyEmails(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Simple guard: if no API key, fall back to heuristics (never throw)
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return items.map(heuristicClassify);
  }

  const system = `
You classify emails for triage. For EACH item:
- importance: "important" or "unimportant"
- intent: one of billing, meeting, sales, support, hr, legal, security, newsletter, social, other
- urgency: 0 (none), 1 (low), 2 (medium), 3 (high)
- action_required: true/false (does the user likely need to respond/do something?)
- confidence: 0..1
- reasons: array of short bullet reasons
RETURN ONLY pure JSON array with one object per input, no prose.`;

  const user = {
    task: "Classify these emails.",
    fields: ["subject","from","fromEmail","fromDomain","to","cc","date","snippet"],
    items
  };

  try {
    // Don’t pass AbortController.signal into the BODY (this caused your 400).
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      // Use a current, inexpensive model id. (The old gpt-4-1106-preview is deprecated.)
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system.trim() },
          { role: 'user', content: JSON.stringify(user) }
        ],
        // Make sure responses fit comfortably
        max_tokens: 1000
      })
    });

    if (!resp.ok) {
      const detail = await safeJson(resp);
      console.error('Classifier error:', resp.status, detail || await resp.text());
      // graceful fallback, never crash the UI
      return items.map(heuristicClassify);
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '[]';

    let parsed = [];
    try { parsed = JSON.parse(text); } catch { parsed = []; }

    // Normalize length and fields
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      // If the LLM returned something off-length, pad with heuristics
      const out = [];
      for (let i = 0; i < items.length; i++) {
        out.push(parsed[i] ? normalizeOne(parsed[i]) : heuristicClassify(items[i]));
      }
      return out;
    }

    return parsed.map(normalizeOne);
  } catch (err) {
    console.error('Classifier exception:', err?.message || err);
    return items.map(heuristicClassify);
  }
}

function normalizeOne(o = {}) {
  const imp = String(o.importance || '').toLowerCase() === 'important' ? 'important' : 'unimportant';
  const intents = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  const intent = intents.has(String(o.intent||'').toLowerCase()) ? String(o.intent).toLowerCase() : 'other';
  const urgency = clampInt(o.urgency, 0, 3);
  const action_required = !!o.action_required;
  const confidence = clampNum(o.confidence, 0, 1);
  const reasons = Array.isArray(o.reasons) ? o.reasons.slice(0, 6).map(x => String(x)) : [];
  return { importance: imp, intent, urgency, action_required, confidence, reasons };
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function clampNum(v, lo, hi) {
  const n = Number(v);
  if (isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function heuristicClassify(item = {}) {
  const s = `${item.subject||''} ${item.snippet||''}`.toLowerCase();
  let intent = 'other';
  if (/\b(invoice|receipt|payment|billing|subscription)\b/.test(s)) intent = 'billing';
  else if (/\bmeeting|calendar|invite|zoom|teams\b/.test(s)) intent = 'meeting';
  else if (/\bsecurity|password|verification|alert\b/.test(s)) intent = 'security';
  else if (/\blegal|contract|nda|agreement\b/.test(s)) intent = 'legal';
  else if (/\bnewsletter|unsubscribe|digest\b/.test(s)) intent = 'newsletter';
  else if (/\bsupport|ticket|issue|bug\b/.test(s)) intent = 'support';
  else if (/\bsale|offer|promo|deal\b/.test(s)) intent = 'sales';

  const urgent = /\b(asap|urgent|immediately|action required|past due)\b/.test(s);
  const importance = urgent || intent === 'security' || intent === 'billing' ? 'important' : 'unimportant';
  const urgency = urgent ? 2 : 0;
  const action_required = urgent || /(please reply|respond|rsvp|confirm)/.test(s);
  return { importance, intent, urgency, action_required, confidence: 0.4, reasons: [] };
}

async function safeJson(resp) {
  try { return await resp.json(); } catch { return null; }
}
