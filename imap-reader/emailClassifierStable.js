// emailClassifier.js — upgraded, backward-compatible classifier
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Input:  [{ subject, from, fromEmail, fromDomain, to, cc, date, snippet }]
 * Output: [{
 *   importance: "important" | "unimportant",
 *   intent?: "billing"|"meeting"|"sales"|"support"|"hr"|"legal"|"security"|"newsletter"|"social"|"other",
 *   urgency?: 0|1|2|3,
 *   action_required?: boolean,
 *   entities?: { amount?: string, dateTime?: string, company?: string, thread?: boolean },
 *   confidence?: number,   // 0..1
 *   reasons?: string[]     // short why-explanations
 * }]
 *
 * If the model returns bad JSON, we gracefully fall back to { importance } only.
 */
export async function classifyEmails(items) {
  const input = items.map(e => ({
    subject: e.subject,
    from: e.from,
    fromEmail: e.fromEmail,
    fromDomain: e.fromDomain,
    to: e.to,
    cc: e.cc,
    date: e.date,
    snippet: e.snippet
  }));

  const sys = `
You are an email triager. For each input email, return a single JSON array of objects (one per input) with:

- importance: "important" | "unimportant"
- intent: one of ["billing","meeting","sales","support","hr","legal","security","newsletter","social","other"]
- urgency: integer 0..3  (0 none, 1 low, 2 medium, 3 urgent)
- action_required: true|false
- entities: { amount?: string, dateTime?: string, company?: string, thread?: boolean }
- confidence: number 0..1
- reasons: string[] (1–3 short bullets that explain the decision)

Heuristics (apply in this order):
1) OTP/verification codes, password resets, calendar invites within 24h, invoices/refunds/contracts ⇒ important (urgency ≥2).
2) Direct replies/threads ("Re:", "Fwd:") from known/ongoing correspondents ⇒ important (entities.thread=true).
3) Bulk promos/digests/unsubscribe-heavy ⇒ unimportant unless a thread exists in last 7 days.

Prefer IMPORTANT when unsure. Return ONLY the JSON array.`.trim();

  const user = `Emails:\n${JSON.stringify(input)}`;

  const resp = await client.chat.completions.create({
    model: process.env.SMARTEMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 512,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });

  // Parse with safe fallback to your previous single-field shape
  let parsed = [];
  try {
    const text = resp.choices?.[0]?.message?.content?.trim() || '[]';
    parsed = JSON.parse(text);
  } catch {
    parsed = [];
  }

  if (!Array.isArray(parsed) || parsed.length !== items.length) {
    // Back-compat: if anything goes wrong, only return importance (default unclassified)
    return items.map(() => ({ importance: 'unimportant' }));
  }

  return parsed.map(x => ({
    importance: /important/i.test(x?.importance) ? 'important' : 'unimportant',
    intent: x?.intent || 'other',
    urgency: Number.isInteger(x?.urgency) ? x.urgency : 0,
    action_required: !!x?.action_required,
    entities: x?.entities && typeof x.entities === 'object' ? x.entities : {},
    confidence: typeof x?.confidence === 'number' ? x.confidence : 0.6,
    reasons: Array.isArray(x?.reasons) ? x.reasons.slice(0, 3) : []
  }));
}
