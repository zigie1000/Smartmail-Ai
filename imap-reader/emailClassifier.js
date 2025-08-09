import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function classifyEmails(emails) {
  const prompt = `
You are an email assistant. Classify each email as "important" or "unimportant".
Criteria:
- Important: urgent, from known contacts, contains deadlines, money, legal, or customer issues.
- Unimportant: spam, newsletters, promotions.

Return JSON array with: subject, from, importance.
Emails:
${JSON.stringify(emails)}
`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return emails.map(e => ({ ...e, importance: 'unclassified' }));
  }
}
