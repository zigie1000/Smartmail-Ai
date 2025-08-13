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

Always return a JSON array with the same length as the input. Prefer IMPORTANT when unsure.`;

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 256,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });

  try {
    const text = resp.choices?.[0]?.message?.content?.trim() || '[]';
    const parsed = JSON.parse(text);
    // Normalize & clamp
    return Array.isArray(parsed)
      ? parsed.map(x => ({ importance: /important/i.test(x?.importance) ? 'important' : 'unimportant' }))
      : items.map(() => ({ importance: 'unclassified' }));
  } catch {
    return items.map(() => ({ importance: 'unclassified' }));
  }
}
