// imapService.js (ESM) — robust IMAP fetcher with month parsing, fallbacks & UID pagination
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** ---------- helpers ---------- **/
function normBool(v) { return v === true || String(v).toLowerCase() === 'true'; }

function makeAuth({ authType = 'password', email, password, accessToken }) {
  const kind = String(authType || 'password').toLowerCase();
  if (kind === 'xoauth2') return { user: email, accessToken: accessToken || '' };
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
  await client.mailboxOpen('INBOX', { readOnly: true });
  return client;
}

/** Parse month inputs into [start, endExclusive] */
function parseMonthRange(monthStart, monthEnd) {
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const ms = clean(monthStart);
  const me = clean(monthEnd);

  // both provided (ISO/parsable)
  if (ms && me && !Number.isNaN(Date.parse(ms)) && !Number.isNaN(Date.parse(me))) {
    const start = new Date(ms);
    const meD = new Date(me);
    const endExclusive = new Date(meD.getFullYear(), meD.getMonth(), meD.getDate() + 1);
    return { start, endExclusive };
  }

  // single month label in ms (e.g., "July 2025" or "2025-07")
  if (ms && !me && !Number.isNaN(Date.parse(ms))) {
    const d = new Date(ms);
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const endExclusive = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
    return { start, endExclusive };
  }

  return { start: null, endExclusive: null };
}

function buildDateCriteria({ rangeDays, monthStart, monthEnd }) {
  const crit = ['ALL'];
  const { start, endExclusive } = parseMonthRange(monthStart, monthEnd);

  if (start && endExclusive) {
    crit.push(['SINCE', start]);
    crit.push(['BEFORE', endExclusive]); // exclusive upper bound
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
    fromDomain: ((from0.address || '').split('@')[1] || '').toLowerCase(),
    to: (to0.address || '').toString(),
    date: msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString(),
    internalDate: msg.internalDate || null,   // <── ADD THIS LINE
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

    const text = (parsed.text || '').toString().trim();
    const html = (parsed.html || '').toString().replace(/<[^>]+>/g, ' ').trim();

    let textish = text || html;
    textish = textish.replace(/\s+/g, ' ').trim();

    if (textish) model.snippet = textish.slice(0, 600);
    if (text) model.text = text;
    if (html) model.html = html;
  } catch { /* ignore */ }
  return model;
}

/** Tiny heuristic classifier (no LLM) */
function classify(model, { vipSenders = [] } = {}) {
  const s = `${model.subject} ${model.snippet}`.toLowerCase();
  const intent =
    /\b(invoice|billing|payment|receipt|subscription|refund)\b/.test(s) ? 'billing' :
    /\b(meeting|meet|zoom|calendar|invite|join)\b/.test(s)              ? 'meeting' :
    /\b(ticket|support|issue|bug|help)\b/.test(s)                        ? 'support' :
    /\b(offer|promo|newsletter|digest|update)\b/.test(s)                 ? 'newsletter' : '';
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
  const arr = Array.isArray(uids) ? uids : Array.from(uids || []);
  const nums = arr.map(Number).filter(Number.isFinite);
  nums.sort((a, b) => b - a);
  return nums;
}

/** ---------- public API ---------- */
export async function fetchEmails(opts) {
  const {
    email, password, accessToken,
    host, port = 993, tls = true, authType = 'password',
    rangeDays = 7, monthStart, monthEnd,
    // NEW: accept a single `month` label (e.g., "July 2025") as an alias
    month,
    limit = 20, cursor = null,
    fullBodies = false,   // <── ADD THIS LINE
    vipSenders = []
  } = opts || {};

  if (!email || !host) throw new Error('email and host are required');

  // ---- MINIMAL MONTH NORMALIZATION ----
  // If the caller sent only `month`, use it as monthStart; keep monthEnd as-is.
  const _monthStart = monthStart || month || '';
  const _monthEnd   = monthEnd || '';

  let client;
  try {
    client = await connectAndOpen({ host, port, tls, authType, email, password, accessToken });

    /* 1) primary IMAP search (UIDs) */
    const criteria = buildDateCriteria({ rangeDays, monthStart: _monthStart, monthEnd: _monthEnd });
    let uidList = normalizeUids(await client.search(criteria, { uid: true }));

    /* 2) Gmail RAW fallback */
    if ((!uidList || uidList.length === 0) && /(?:^|\.)gmail\.com$/i.test(host)) {
      const { start, endExclusive } = parseMonthRange(_monthStart, _monthEnd);
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (d) => `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())}`;
      const a = start ? fmt(start) : fmt(new Date(Date.now() - (Number(rangeDays) || 30) * 864e5));
      const b = endExclusive ? fmt(endExclusive) : fmt(new Date());
      try {
        uidList = normalizeUids(await client.search({ gmailRaw: `in:inbox after:${a} before:${b}` }, { uid: true }));
      } catch {/* ignore */}
    }

    /* 3) Hard fallback: last N UIDs in INBOX */
    if (!uidList || uidList.length === 0) {
      try {
        const st = await client.status('INBOX', { uidnext: true });
        const lastUid = Math.max(1, (st.uidnext || 1) - 1);
        const want = Math.max(1, Number(limit) || 20);
        const startUid = Math.max(1, lastUid - (want * 5) + 1);
        const collected = [];
        for await (const m of client.fetch({ uid: `${startUid}:${lastUid}` }, { uid: true })) {
          collected.push(m.uid);
        }
        uidList = normalizeUids(collected);
      } catch { uidList = []; }
    }

    /* pagination */
    let startIdx = 0;
    if (cursor != null) {
      const idx = uidList.indexOf(Number(cursor));
      startIdx = idx >= 0 ? idx + 1 : 0;
    }
    const pageSize = Math.max(1, Number(limit) || 20);
    const slice = uidList.slice(startIdx, startIdx + pageSize);

    if (!slice.length) {
      await client.logout();
      return { items: [], nextCursor: null, hasMore: false };
    }

    /* fetch page metadata by UID list */
    const raw = [];
    for await (const msg of client.fetch({ uid: slice }, { envelope: true, internalDate: true, source: false })) {
      raw.push(msg);
    }

    /* map → hydrate (snippet or full) → classify */
const items = [];
for (const msg of raw) {
  let model = toModelSkeleton(msg);

  if (fullBodies) {
    // Month mode: fetch full message bodies once
    try {
      const dl = await client.download(msg.uid);
      if (dl?.content) {
        const parsed = await simpleParser(dl.content);
        const text = (parsed.text || '').toString();
        const html = (parsed.html || '').toString();
        const textish = (text || html)
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (textish) model.snippet = textish.slice(0, 600);
        if (text) model.text = text;
        if (html) model.html = html;
      }
    } catch { /* ignore */ }
  } else {
    // Range mode: lighter, snippet only
    model = await hydrateSnippet(client, msg.uid, model);
  }

  model = classify(model, { vipSenders });
  items.push(model);
}

    const hasMore = startIdx + slice.length < uidList.length;
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
