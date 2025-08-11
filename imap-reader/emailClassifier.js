import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Input: [{ subject, from, fromEmail, fromDomain, to, cc, date, snippet }]
 * Output: [{ importance: "important" | "unimportant" }]
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
You label emails as "important" or "unimportant".
Heuristics:
- IMPORTANT if: time-sensitive (deadlines, interviews, meetings, offers), money/billing (invoice, payment, refund, receipt), legal/security (contracts, verification codes, password reset), direct replies/threads (Re:, Fwd:), from work or known senders (non-bulk).
- UNIMPORTANT if: bulk promos/newsletters/marketing, automated notifications with no action, social media digests.

Prefer IMPORTANT when unsure. Return ONLY a JSON array with objects of shape: { "importance": "important" | "unimportant" } — one per input item, same order.
`.trim();

  const user = `Emails:\n${JSON.stringify(input)}`;

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
