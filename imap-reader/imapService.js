// imapService.js (ESM) — plain functions consumed by imapRoutes.js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** ---------- helpers ---------- **/

function normBool(v) { return v === true || String(v).toLowerCase() === 'true'; }

function makeAuth({ authType = 'password', email, password, accessToken }) {
  const kind = String(authType || 'password').toLowerCase();
  if (kind === 'xoauth2') {
    return { user: email, accessToken: accessToken || '' };
  }
  return { user: email, pass: password || '' };
}

async function connectAndOpen({ host, port = 993, tls = true, authType, email, password, accessToken }) {
  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: normBool(tls),
    auth: makeAuth({ authType, email, password, accessToken }),
    logger: false
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
}

function buildDateCriteria({ rangeDays, monthStart, monthEnd }) {
  const crit = ['ALL'];
  if (monthStart) crit.push(['SINCE', new Date(monthStart)]);
  else if (Number(rangeDays) > 0) {
    const since = new Date(Date.now() - Number(rangeDays) * 24 * 3600 * 1000);
    crit.push(['SINCE', since]);
  }
  if (monthEnd) {
    // IMAP BEFORE is exclusive; bump by 1 day so UI's monthEnd is inclusive
    const before = new Date(new Date(monthEnd).getTime() + 24 * 3600 * 1000);
    crit.push(['BEFORE', before]);
  }
  return crit;
}

function toModelSkeleton(msg) {
  const from0 = msg.envelope?.from?.[0] ?? {};
  const to0   = msg.envelope?.to?.[0] ?? {};
  const subject = (msg.envelope?.subject ?? '').toString();

  return {
    id: String(msg.uid ?? msg.seq ?? ''),
    uid: msg.uid,
    subject,
    from: (from0.name || from0.address || '').toString(),
    fromEmail: (from0.address || '').toString(),
    to: (to0.address || '').toString(),
    date: msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString(),
    snippet: (msg.snippet || '').toString().trim(),
    // classification fields (filled later)
    importance: 'unclassified',
    intent: '',
    urgency: 0,
    action_required: false,
    isVip: false
  };
}

async function hydrateSnippet(client, uid, model) {
  try {
    // fetch full source and parse for a better snippet
    const full = await client.fetchOne(uid, { source: true });
    if (full?.source) {
      const parsed = await simpleParser(full.source);
      const textish = (parsed.text || parsed.html || '')
        .toString()
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (textish) model.snippet = textish.slice(0, 600);
    }
  } catch { /* ignore */ }
  return model;
}

/** Tiny heuristic classifier (no OpenAI) */
function classify(model, { vipSenders = [] } = {}) {
  const s = `${model.subject} ${model.snippet}`.toLowerCase();

  // intent
  const intent =
    /\b(invoice|billing|payment|receipt|subscription|refund)\b/.test(s) ? 'billing' :
    /\b(meeting|meet|zoom|calendar|invite|join)\b/.test(s)              ? 'meeting' :
    /\b(ticket|support|issue|bug|help)\b/.test(s)                        ? 'support' :
    /\boffer|promo|newsletter|digest|update\b/.test(s)                   ? 'newsletter' :
    '';

  // urgency 0–3
  let urgency = 0;
  if (/\burgent|asap|immediately|right away|today\b/.test(s)) urgency = 3;
  else if (/\bsoon|priority|important\b/.test(s))             urgency = 2;
  else if (/\breminder|follow up|ping\b/.test(s))             urgency = 1;

  // importance
  let importance = 'unimportant';
  if (urgency >= 2 || /\bdeadline|overdue|action required\b/.test(s)) importance = 'important';

  // action_required
  const action_required = /\bplease (review|approve|reply|confirm)|action required\b/.test(s) || urgency >= 2;

  // VIP
  const isVip = !!vipSenders.find(v => v && model.fromEmail?.toLowerCase() === String(v).toLowerCase());

  return { ...model, intent, urgency, importance, action_required, isVip };
}

/** Normalize UID array and sort (desc) */
function normalizeUids(uids) {
  if (!Array.isArray(uids)) return [];
  const arr = uids.map(Number).filter(n => Number.isFinite(n));
  arr.sort((a, b) => b - a); // newest first
  return arr;
}

/** ---------- public API (used by imapRoutes.js) ---------- **/

/**
 * Fetch emails with optional cursor pagination.
 * Returns { emails, nextCursor, hasMore }
 */
export async function fetchEmails(opts) {
  const {
    email, password, accessToken,
    host, port = 993, tls = true, authType = 'password',
    rangeDays = 7, monthStart, monthEnd,
    limit = 20, cursor = null,
    vipSenders = []
  } = opts || {};

  if (!email || !host) throw new Error('email and host are required');

  let client;
  try {
    client = await connectAndOpen({ host, port, tls, authType, email, password, accessToken });

    const criteria = buildDateCriteria({ rangeDays, monthStart, monthEnd });
    const uidListRaw = await client.search(criteria, { uid: true });
    const uidList = normalizeUids(uidListRaw);

    // cursor = last UID we returned previously (desc order)
    let start = 0;
    if (cursor != null) {
      const idx = uidList.indexOf(Number(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }

    const pageSize = Math.max(1, Number(limit) || 20);
    const slice = uidList.slice(start, start + pageSize);

    // Fetch metadata
    const raw = [];
    for await (const msg of client.fetch(slice, { uid: true, envelope: true, internalDate: true, source: false })) {
      raw.push(msg);
    }

    // Map → model → add snippet → classify (heuristics)
    const emails = [];
    for (const msg of raw) {
      let model = toModelSkeleton(msg);
      model = await hydrateSnippet(client, msg.uid, model);
      model = classify(model, { vipSenders });
      emails.push(model);
    }

    const hasMore = start + slice.length < uidList.length;
    const nextCursor = hasMore ? String(slice[slice.length - 1]) : null;

    await client.logout();
    return { emails, nextCursor, hasMore };
  } catch (err) {
    try { if (client) await client.logout(); } catch {}
    const msg = err?.message || String(err);
    const e = new Error(msg);
    e.code = err?.code;
    throw e;
  }
}

/** Simple connectivity probe */
export async function testLogin({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  if (!email || !host) throw new Error('email and host are required');
  let client;
  try {
    client = await connectAndOpen({ host, port, tls, authType, email, password, accessToken });
    await client.logout();
    return true;
  } catch {
    try { if (client) await client.logout(); } catch {}
    return false;
  }
}

export default { fetchEmails, testLogin };
