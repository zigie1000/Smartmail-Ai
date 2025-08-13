// imap-reader/emailClassifier.js
import fetch from 'node-fetch';

export async function classifyEmails(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return items.map(heuristicClassify); // graceful fallback

  const system = `
You classify emails for triage. For EACH item:
- importance: "important" | "unimportant"
- intent: billing | meeting | sales | support | hr | legal | security | newsletter | social | other
- urgency: 0..3
- action_required: true/false
- confidence: 0..1
- reasons: string[]
Return ONLY a pure JSON array with one object per input, no extra text.`;

  const user = { task: "Classify emails", fields: ["subject","from","fromEmail","fromDomain","to","cc","date","snippet"], items };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system.trim() },
          { role: 'user', content: JSON.stringify(user) }
        ],
        max_tokens: 1000
      })
    });

    if (!resp.ok) {
      console.error('Classifier error:', resp.status, await resp.text());
      return items.map(heuristicClassify);
    }

    const data = await resp.json();
    const raw = (data?.choices?.[0]?.message?.content || '[]').trim();

    let parsed = [];
    try { parsed = JSON.parse(raw); } catch {}
    if (!Array.isArray(parsed)) parsed = [];

    // keep lengths aligned
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(normalize(parsed[i]) || heuristicClassify(items[i]));
    return out;
  } catch (e) {
    console.error('Classifier exception:', e?.message || e);
    return items.map(heuristicClassify);
  }
}

function normalize(o = {}) {
  const intents = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  const importance = String(o.importance || '').toLowerCase() === 'important' ? 'important' : 'unimportant';
  const intent = intents.has(String(o.intent || '').toLowerCase()) ? String(o.intent).toLowerCase() : 'other';
  const urgency = clampInt(o.urgency, 0, 3);
  const action_required = !!o.action_required;
  const confidence = clampNum(o.confidence, 0, 1);
  const reasons = Array.isArray(o.reasons) ? o.reasons.slice(0, 6).map(String) : [];
  return { importance, intent, urgency, action_required, confidence, reasons };
}
function clampInt(v, lo, hi){ const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function clampNum(v, lo, hi){ const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
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
  return {
    importance: urgent || intent === 'security' || intent === 'billing' ? 'important' : 'unimportant',
    intent,
    urgency: urgent ? 2 : 0,
    action_required: urgent || /(please reply|respond|rsvp|confirm)/.test(s),
    confidence: 0.4,
    reasons: []
  };
}
