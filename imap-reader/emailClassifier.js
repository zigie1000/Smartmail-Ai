// imap-reader/emailClassifier.js
// Hybrid classifier: cheap heuristics + learned lists/weights,
// with an OpenAI fallback for undecided cases.
// - No 'signal' inside JSON body (fixes 400 signal error)
// - alignOutput() is defined here
// - Robust defaults so UI never breaks

import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini';

const HASH = (s) => crypto.createHash('sha256').update(String(s||'').toLowerCase()).digest('hex');

function alignOutput(raw) {
  const def = {
    importance: 'unclassified',   // 'important'|'unimportant'|'unclassified'
    intent: 'other',              // billing|meeting|sales|support|hr|legal|security|newsletter|social|other
    urgency: 0,                   // 0..3
    action_required: false,
    confidence: 0.5,
    reasons: []
  };
  if (!raw || typeof raw !== 'object') return def;
  const out = { ...def };

  const imp = String(raw.importance || '').toLowerCase();
  if (imp === 'important' || imp === 'unimportant') out.importance = imp;

  const intents = new Set(['billing','meeting','sales','support','hr','legal','security','newsletter','social','other']);
  const intent = String(raw.intent || '').toLowerCase();
  out.intent = intents.has(intent) ? intent : 'other';

  const urg = Number(raw.urgency);
  out.urgency = Number.isFinite(urg) ? Math.max(0, Math.min(3, Math.round(urg))) : 0;

  out.action_required = !!raw.action_required;

  const conf = Number(raw.confidence);
  out.confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5;

  if (Array.isArray(raw.reasons)) out.reasons = raw.reasons.map(x => String(x)).slice(0, 6);
  else if (raw.reasons) out.reasons = [String(raw.reasons)];
  return out;
}

function pickIntent(e) {
  const s = `${e.subject || ''}\n${e.snippet || ''}`.toLowerCase();
  if (/\b(invoice|receipt|payment|bill|po#|quote|subscription)\b/.test(s)) return 'billing';
  if (/\bmeeting|invite|calendar|zoom|google meet|teams\b/.test(s)) return 'meeting';
  if (/\bcontract|nda|legal|attorney|counsel|copyright|gdpr|dpia\b/.test(s)) return 'legal';
  if (/\bsecurity|breach|vulnerability|2fa|otp|login alert\b/.test(s)) return 'security';
  if (/\bsupport|ticket|issue|bug|helpdesk|rma\b/.test(s)) return 'support';
  if (/\bsale|pricing|quote|lead|demo request\b/.test(s)) return 'sales';
  if (/\bnewsletter|unsubscribe|digest|roundup|update\b/.test(s)) return 'newsletter';
  if (/\bhr|payroll|benefit|leave|vacation|timesheet\b/.test(s)) return 'hr';
  if (/\bfacebook|twitter|x\.com|linkedin|instagram|social\b/.test(s)) return 'social';
  return 'other';
}

function baseHeuristics(e, lists) {
  const L = lists || { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(), weights:{email:new Map(), domain:new Map()} };
  const fromEmail = (e.fromEmail || '').toLowerCase();
  const fromDomain = (e.fromDomain || '').toLowerCase();
  const emailHash = HASH(fromEmail);

  // learned weights (hashed or plain)
  const wEmail = L.weights?.email?.get(emailHash) ?? L.weights?.email?.get(fromEmail) ?? 0;
  const wDomain = L.weights?.domain?.get(fromDomain) ?? 0;
  const learned = wEmail + 0.6 * wDomain;

  const isVIP = L.vip?.has(fromEmail) || L.vip?.has(fromDomain);
  const isGov = L.government?.has(fromDomain);
  const isLegal = L.legal?.has(fromDomain) || /\b(legal|attorney|counsel)\b/.test((e.subject||'').toLowerCase());
  const isBulk = L.bulk?.has(fromDomain) || /\bunsubscribe|no-reply|mailer-daemon|noreply\b/.test(fromEmail);

  const hasICS = !!e.hasIcs || (e.attachTypes||[]).some(t => /calendar|ics/i.test(String(t)));
  const soonMeeting = hasICS;

  const s = `${e.subject || ''} ${e.snippet || ''}`.toLowerCase();
  const urgentWords = /\burgent|asap|immediately|action required|past due|final notice\b/.test(s);

  let intent = pickIntent(e);
  let importance = 'unclassified';
  let urgency = 0;
  let action_required = false;
  const reasons = [];

  // Importance starting point
  if (isBulk) { importance = 'unimportant'; reasons.push('bulk/newsletter'); }
  if (isVIP || isGov || isLegal) { importance = 'important'; reasons.push(isVIP?'VIP':isGov?'government':'legal'); }

  // Urgency
  if (urgentWords) { urgency = 3; reasons.push('urgent language'); }
  else if (soonMeeting) { urgency = Math.max(urgency, 2); reasons.push('calendar/meeting'); }
  else if (intent === 'billing') { urgency = Math.max(urgency, 2); }

  // Action
  if (/\bplease (confirm|review|respond|reply|sign|pay|schedule)\b/.test(s)) {
    action_required = true; reasons.push('explicit request');
  }

  // Learned weights tilt
  if (learned > 0.7) { importance = 'important'; reasons.push('learned positive'); }
  if (learned < -0.7 && importance !== 'important') { importance = 'unimportant'; reasons.push('learned negative'); }

  // Confidence
  let confidence = 0.55 + Math.max(-0.2, Math.min(0.35, learned * 0.15));
  if (isVIP || isGov || isLegal) confidence += 0.15;
  if (isBulk) confidence += 0.10;
  confidence = Math.max(0.3, Math.min(0.95, confidence));

  return alignOutput({ importance, intent, urgency, action_required, confidence, reasons });
}

function needsLLM(o) {
  // Only ask LLM if we’re still unclassified or low confidence
  return o.importance === 'unclassified' || o.confidence < 0.55;
}

function buildSystemPrompt() {
  return [
    'You are an email triage assistant.',
    'Return only compact JSON with fields:',
    "{importance: 'important'|'unimportant'|'unclassified', intent: 'billing'|'meeting'|'sales'|'support'|'hr'|'legal'|'security'|'newsletter'|'social'|'other', urgency: 0..3, action_required: boolean, confidence: 0..1, reasons: string[]}.",
    'Be terse. Output JSON only.'
  ].join(' ');
}

export async function classifyEmails(items, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const lists = opts.lists || { vip:new Set(), legal:new Set(), government:new Set(), bulk:new Set(), weights:{ email:new Map(), domain:new Map() } };
  if (!Array.isArray(items) || items.length === 0) return [];

  // 1) Heuristics first
  const heur = items.map(e => baseHeuristics(e, lists));

  // If no API key or all good enough, return heuristics
  if (!apiKey || heur.every(h => !needsLLM(h))) return heur;

  // 2) Ask LLM only for the undecided ones, in original order
  const undecIdx = heur.map((h,i) => needsLLM(h) ? i : -1).filter(i => i >= 0);
  if (undecIdx.length === 0) return heur;

  const userContent = [
    'Classify these emails. Return a JSON array of length N with objects in the same order.',
    'Fields: importance, intent, urgency, action_required, confidence, reasons.',
    '',
    ...undecIdx.map((i, k) => {
      const e = items[i];
      const lines = [
        `#${k+1}`,
        `From: ${e.from || ''}`,
        e.fromEmail ? `From-Email: ${e.fromEmail}` : '',
        e.fromDomain ? `From-Domain: ${e.fromDomain}` : '',
        `Subject: ${e.subject || ''}`,
        `Snippet: ${(e.snippet || '').slice(0, 800)}`,
        e.date ? `Date: ${e.date}` : ''
      ].filter(Boolean);
      return lines.join('\n');
    })
  ].join('\n\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let data = null;
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
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 300
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await resp.text();
    data = safeJson(text);
    if (!resp.ok) {
      console.error('Classifier error:', resp.status, data?.error || text);
      return heur; // fallback to heuristics only
    }
  } catch (e) {
    clearTimeout(timeout);
    console.error('Classifier fetch error:', e?.message || e);
    return heur;
  }

  const content = data?.choices?.[0]?.message?.content || '[]';
  const parsed = safeJson(content);
  if (!Array.isArray(parsed)) return heur;

  // Merge LLM results back to those indices
  const out = heur.slice();
  undecIdx.forEach((i, k) => {
    const aligned = alignOutput(parsed[k]);
    // Simple blend: if LLM increased confidence or changed importance, adopt it.
    const base = out[i];
    const better =
      (aligned.importance !== 'unclassified' && base.importance === 'unclassified') ||
      (aligned.confidence > base.confidence + 0.05);
    out[i] = better ? aligned : base;
  });

  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
