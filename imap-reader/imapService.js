// imapService.js (ESM) — IMAP fetcher with robust month parsing & UID pagination
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

/** Parse month into [start, endExclusive] dates */
function parseMonthRange(monthLabel) {
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const ms = clean(monthLabel);

  if (ms && !Number.isNaN(Date.parse(ms))) {
    const d = new Date(ms);
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const endExclusive = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
    return { start, endExclusive };
  }
  return { start: null, endExclusive: null };
}

function buildDateCriteria({ rangeDays, month }) {
  const crit = ['ALL'];
  const { start, endExclusive } = parseMonthRange(month);

  if (start && endExclusive) {
    crit.push(['SINCE', start]);
    crit.push(['BEFORE', endExclusive]);
    return crit;
  }

  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    crit.push(['SINCE', since]);
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
    importance: 'unclassified',
    intent: '',
    urgency: 0,
    action_required: false,
    isVip: false
  };
}

async function hydrateSnippet(client, uid, model) {
  try {
    const stream = await client.download(uid);
    if (!stream) return model;
    const parsed = await simpleParser(stream.content);
    const textish = (parsed.text || parsed.html || '')
      .toString()
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (textish) model.snippet = textish.slice(0, 600);
  } catch {}
  return model;
}

/** Heuristic classifier */
function classify(model, { vipSenders = [] } = {}) {
  const s = `${model.subject} ${model.snippet}`.toLowerCase();

  const intent =
    /\b(invoice|billing|payment|receipt|subscription|refund)\b/.test(s) ? 'billing' :
    /\b(meeting|meet|zoom|calendar|invite|join)\b/.test(s)              ? 'meeting' :
    /\b(ticket|support|issue|bug|help)\b/.test(s)                        ? 'support' :
    /\b(offer|promo|newsletter|digest|update)\b/.test(s)                 ? 'newsletter' :
    /\b(contract|law|legal|attorney|agreement)\b/.test(s)                ? 'legal' :
    '';

  let urgency = 0;
  if (/\burgent|asap|immediately|right away|today\b/.test(s)) urgency = 3;
  else if (/\bsoon|priority|important\b/.test(s))             urgency = 2;
  else if (/\breminder|follow up|ping\b/.test(s))             urgency = 1;

  let importance = 'unimportant';
  if (urgency >= 2 || /\bdeadline|overdue|action required\b/.test(s)) importance = 'important';

  const action_required = /\bplease (review|approve|reply|confirm)|action required\b/.test(s) || urgency >= 2;

  const isVip = !!vipSenders.find(v => v && model.fromEmail?.toLowerCase() === String(v).toLowerCase());

  return { ...model, intent, urgency, importance, action_required, isVip };
}

function normalizeUids(uids) {
  if (!Array.isArray(uids) && !(uids instanceof Set)) return [];
  const arr = Array.isArray(uids) ? uids : Array.from(uids);
  const nums = arr.map(Number).filter(n => Number.isFinite(n));
  nums.sort((a, b) => b - a);
  return nums;
}

/** ---------- public API ---------- **/

export async function fetchEmails(opts) {
  const {
    email, password, accessToken,
    host, port = 993, tls = true, authType = 'password',
    rangeDays = 7, month,
    limit = 20, cursor = null,
    vipSenders = [],
    intent = 'all'
  } = opts || {};

  if (!email || !host) throw new Error('email and host are required');

  let client;
  try {
    client = await connectAndOpen({ host, port, tls, authType, email, password, accessToken });

    const criteria = buildDateCriteria({ rangeDays, month });
    const uidListRaw = await client.search(criteria, { uid: true });
    const uidList = normalizeUids(uidListRaw);

    let start = 0;
    if (cursor != null) {
      const idx = uidList.indexOf(Number(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }

    const pageSize = Math.max(1, Number(limit) || 20);
    const slice = uidList.slice(start, start + pageSize);

    if (!slice.length) {
      await client.logout();
      return { items: [], nextCursor: null, hasMore: false };
    }

    const raw = [];
    for await (const msg of client.fetch({ uid: slice }, { envelope: true, internalDate: true, source: false })) {
      raw.push(msg);
    }

    let items = [];
    for (const msg of raw) {
      let model = toModelSkeleton(msg);
      model = await hydrateSnippet(client, msg.uid, model);
      model = classify(model, { vipSenders });
      items.push(model);
    }

    // filter by intent after classification
    if (intent && intent !== 'all') {
      items = items.filter(m => m.intent === intent);
    }

    const hasMore = start + slice.length < uidList.length;
    const nextCursor = hasMore ? String(slice[slice.length - 1]) : null;

    await client.logout();
    return { items, nextCursor, hasMore };
  } catch (err) {
    try { if (client) await client.logout(); } catch {}
    const e = new Error(err?.message || String(err));
    e.code = err?.code;
    throw e;
  }
}

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
