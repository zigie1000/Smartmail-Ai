// emailClassifier.js
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Input: [{ subject, from, fromEmail, fromDomain, to, cc, date, snippet }]
 * Output: [{ importance: "important" | "unimportant", intent?: string, urgency?: number, action_required?: boolean, entities?: object, confidence?: number, reasons?: string[] }]
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
You label emails as "important" or "unimportant". Also (optionally) provide:
- intent: one of ["billing","meeting","sales","support","hr","legal","security","newsletter","social","other"]
- urgency: 0..3 (0 none, 3 urgent)
- action_required: true/false
- entities: { amount?: string, dateTime?: string, company?: string, thread?: boolean }
- confidence: 0..1
- reasons: 1-3 short bullets

Heuristics:
- IMPORTANT if: time-sensitive (deadlines, interviews, meetings, calendar invites in <24h), legal/security (contracts, verification codes, password reset), finance (invoice, refund, payment), direct reply in an active thread.
- UNIMPORTANT if: bulk promotions/newsletters/digests unless part of an active thread.

Always return a JSON array with the same length as the input. Prefer IMPORTANT when unsure.`.trim();

  const userContent = `Classify the following emails:\n${JSON.stringify(input)}`;

  try {
    const resp = await client.chat.completions.create({
      model: process.env.SMARTEMAIL_CLASSIFIER_MODEL || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userContent }
      ]
    });

    const text = resp.choices?.[0]?.message?.content?.trim() || '[]';
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed) && parsed.length === items.length) {
      return parsed.map(x => ({
        importance: /important/i.test(x?.importance) ? 'important' : 'unimportant',
        intent: x?.intent || undefined,
        urgency: typeof x?.urgency === 'number' ? x.urgency : undefined,
        action_required: typeof x?.action_required === 'boolean' ? x.action_required : undefined,
        entities: x?.entities || undefined,
        confidence: typeof x?.confidence === 'number' ? x.confidence : undefined,
        reasons: Array.isArray(x?.reasons) ? x.reasons : undefined
      }));
    }

    // Fallback if parse failed or lengths mismatch
    return items.map(e => fallbackHeuristic(e));
  } catch (err) {
    console.error('Classifier error:', err?.message || err);
    // Fallback if API fails
    return items.map(e => fallbackHeuristic(e));
  }
}

function fallbackHeuristic(e){
  const s = `${e.subject||''} ${e.snippet||''}`.toLowerCase();
  const isImportant = /\b(invoice|payment|refund|meeting|calendar|interview|contract|2fa|verification|password|reset|security)\b/.test(s);
  const intent =
    /invoice|payment|refund/.test(s) ? 'billing' :
    /meeting|calendar|interview/.test(s) ? 'meeting' :
    /contract|nda|legal/.test(s) ? 'legal' :
    /password|2fa|verification|security/.test(s) ? 'security' :
    undefined;

  return {
    importance: isImportant ? 'important' : 'unimportant',
    intent,
    urgency: /\burgent|asap|today|tomorrow\b/.test(s) ? 2 : 0,
    action_required: !!isImportant
  };
}
