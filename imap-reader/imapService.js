// imapService.js (ESM) — Month-scoped IMAP fetcher with server-side filters (Gmail X-GM-RAW) + UID pagination
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/** ---------------- helpers ---------------- **/

const asBool = (v) => v === true || String(v).toLowerCase() === 'true';

function makeAuth({ authType = 'password', email, password, accessToken }) {
  const kind = String(authType || 'password').toLowerCase();
  if (kind === 'xoauth2') return { user: email, accessToken: accessToken || '' };
  return { user: email, pass: password || '' };
}

async function connectAndOpen({ host, port = 993, tls = true, authType, email, password, accessToken }) {
  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: asBool(tls),
    auth: makeAuth({ authType, email, password, accessToken }),
    logger: false
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
}

/** Parse a variety of month inputs into [start, endExclusive] */
function parseMonthRange(monthStart, monthEnd) {
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const ms = clean(monthStart), me = clean(monthEnd);

  // Both provided
  if (ms && me && !Number.isNaN(Date.parse(ms)) && !Number.isNaN(Date.parse(me))) {
    const start = new Date(ms);
    const d = new Date(me);
    const endExclusive = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return { start, endExclusive };
  }

  // Single month label like "July 2025" or "2025-07"
  if (ms && !me && !Number.isNaN(Date.parse(ms))) {
    const d = new Date(ms);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const endExclusive = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return { start, endExclusive };
  }

  return { start: null, endExclusive: null };
}

/** Build Gmail X-GM-RAW from filters (best-effort) */
function buildGmailRaw({ intent, quick, vipSenders = [], legalDomains = [], governmentDomains = [], bulkDomains = [] }) {
  const parts = [];

  // ---- Intent mapping ----
  const intentMap = {
    meeting: '(subject:(invite OR meeting OR calendar OR zoom OR "google meet" OR teams) OR filename:ics)',
    billing: '(subject:(invoice OR receipt OR "payment due" OR billing OR subscription OR refund))',
    security: '(subject:("security alert" OR breach OR phishing OR "unusual sign-in" OR password))',
    newsletter: '(unsubscribe OR newsletter OR "weekly digest" OR roundup)',
    sales: '(subject:(sale OR discount OR coupon OR deal OR promo))',
    social: '(subject:(follow OR mention OR comment OR like OR "friend request" OR follower))',
    legal: '(subject:(legal OR contract OR terms OR compliance OR policy OR subpoena OR nda))',
    system: '(subject:(deploy OR "build failed" OR pipeline OR outage OR incident OR alert OR cron OR backup OR "status page" OR "service degraded" OR "error rate"))'
  };
  if (intent && intentMap[intent]) parts.push(intentMap[intent]);

  // ---- Quick filters (booleans) ----
  // important, vip, urgent, needsAction, meetings, finance
  if (quick?.important) parts.push('is:important');
  if (quick?.urgent) parts.push('(subject:(urgent OR asap OR "action required" OR deadline))');
  if (quick?.needsAction) parts.push('(subject:(reply OR confirm OR approve OR review) OR "action required")');
  if (quick?.meetings) parts.push('(filename:ics OR subject:(invite OR meeting OR calendar OR zoom OR "google meet" OR teams))');
  if (quick?.finance) parts.push('(subject:(invoice OR receipt OR "payment" OR refund OR billing OR subscription))');

  // VIP senders -> OR of from:
  const vipFrom = (vipSenders || []).filter(Boolean).map(v => `from:${quoteRaw(v)}`);
  if (quick?.vip && vipFrom.length) parts.push(`(${vipFrom.join(' OR ')})`);

  // Domains by category (can strengthen "legal" etc.)
  const legalFrom = (legalDomains || []).map(d => `from:${quoteRaw(d)}`);
  const govFrom   = (governmentDomains || []).map(d => `from:${quoteRaw(d)}`);
  const bulkFrom  = (bulkDomains || []).map(d => `from:${quoteRaw(d)}`);
  if (intent === 'legal' && legalFrom.length) parts.push(`(${legalFrom.join(' OR ')})`);
  if (intent === 'system' && govFrom.length) parts.push(`(${govFrom.join(' OR ')})`);
  if (intent === 'newsletter' && bulkFrom.length) parts.push(`(${bulkFrom.join(' OR ')})`);

  // Join defensively
  const raw = parts.filter(Boolean).join(' ');
  return raw.trim();
}

function quoteRaw(s) {
  // X-GM-RAW is space-delimited; quote anything with spaces/specials
  const needsQuote = /[\s"()]/.test(String(s));
  return needsQuote ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

/** Build IMAP criteria array; inject X-GM-RAW for Gmail */
function buildDateAndFilterCriteria({
  provider = 'Gmail',
  rangeDays,
  monthStart,
  monthEnd,
  intent,
  quick,
  vipSenders,
  legalDomains,
  governmentDomains,
  bulkDomains
}) {
  const crit = ['ALL'];
  const { start, endExclusive } = parseMonthRange(monthStart, monthEnd);

  if (start && endExclusive) {
    crit.push(['SINCE', start]);
    crit.push(['BEFORE', endExclusive]); // exclusive upper bound
  } else if (Number.isFinite(Number(rangeDays)) && Number(rangeDays) > 0) {
    const since = new Date(Date.now() - Number(rangeDays) * 24 * 3600 * 1000);
    crit.push(['SINCE', since]);
  }

  // Server-side filtering (Gmail best-effort)
  if (String(provider).toLowerCase() === 'gmail') {
    const raw = buildGmailRaw({ intent, quick, vipSenders, legalDomains, governmentDomains, bulkDomains });
    if (raw) crit.push(['X-GM-RAW', raw]);
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
  } catch { /* ignore */ }
  return model;
}

/** Tiny heuristic classifier (kept for non-Gmail or fallback) */
function classify(model, { vipSenders = [] } = {}) {
  const s = `${model.subject} ${model.snippet}`.toLowerCase();

  const intent =
    /\b(invoice|billing|payment|receipt|subscription|refund)\b/.test(s) ? 'billing' :
    /\b(meeting|meet|zoom|calendar|invite|join)\b/.test(s)              ? 'meeting' :
    /\b(ticket|support|issue|bug|help)\b/.test(s)                        ? 'support' :
    /\b(offer|promo|newsletter|digest|update)\b/.test(s)                 ? 'newsletter' :
    /\b(legal|contract|terms|compliance|policy|nda|subpoena)\b/.test(s)  ? 'legal' :
    /\b(deploy|build failed|pipeline|outage|incident|alert|cron|backup|status page|service degraded|error rate)\b/.test(s) ? 'system' :
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

/** Normalize UID array and sort desc */
function normalizeUids(uids) {
  if (!Array.isArray(uids) && !(uids instanceof Set)) return [];
  const arr = Array.isArray(uids) ? uids : Array.from(uids);
  const nums = arr.map(Number).filter(n => Number.isFinite(n));
  nums.sort((a, b) => b - a);
  return nums;
}

/** ---------------- public API ---------------- **/

/**
 * Fetch emails (month-scoped) with optional server-side filters and cursor pagination.
 * Returns { items, nextCursor, hasMore }
 */
export async function fetchEmails(opts) {
  const {
    email, password, accessToken,
    host, port = 993, tls = true, authType = 'password',
    provider = 'Gmail',                  // <-- pass 'Gmail' to enable X-GM-RAW filters
    rangeDays = 7, monthStart, monthEnd, // month preferred; rangeDays is fallback
    limit = 20, cursor = null,

    // personalization
    vipSenders = [],
    legalDomains = [], governmentDomains = [], bulkDomains = [],

    // filters from UI
    intent = '',                         // 'meeting'|'billing'|'security'|'newsletter'|'sales'|'social'|'legal'|'system'
    quick = {}                           // { important, vip, urgent, needsAction, meetings, finance }
  } = opts || {};

  if (!email || !host) throw new Error('email and host are required');

  let client;
  try {
    client = await connectAndOpen({ host, port, tls, authType, email, password, accessToken });

    // Build month window + server-side filters
    const criteria = buildDateAndFilterCriteria({
      provider, rangeDays, monthStart, monthEnd,
      intent, quick, vipSenders, legalDomains, governmentDomains, bulkDomains
    });

    const uidListRaw = await client.search(criteria, { uid: true });
    const uidList = normalizeUids(uidListRaw);

    // Cursor: position is after the last UID returned previously (desc order)
    let start = 0;
    if (cursor != null) {
      const idx = uidList.indexOf(Number(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }

    const pageSize = Math.max(1, Number(limit) || 20);
    const slice = uidList.slice(start, start + pageSize);

    // No results in this window
    if (!slice.length) {
      await client.logout();
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Fetch lightweight metadata for the slice (explicit by UID)
    const raw = [];
    for await (const msg of client.fetch({ uid: slice }, { envelope: true, internalDate: true, source: false })) {
      raw.push(msg);
    }

    // Map → model → hydrate snippet → heuristic classify
    const items = [];
    for (const msg of raw) {
      let model = toModelSkeleton(msg);
      model = await hydrateSnippet(client, msg.uid, model);
      model = classify(model, { vipSenders });
      items.push(model);
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
