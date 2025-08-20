// imapService.js (ESM) — plain functions consumed by imapRoutes.js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/* ------------------------------ helpers ------------------------------ */

function normBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

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
  // Always open INBOX — we only ever search there from the UI
  await client.mailboxOpen('INBOX');
  return client;
}

function buildDateCriteria({ rangeDays, monthStart, monthEnd }) {
  // Default to ALL, then add SINCE/BEFORE
  const crit = ['ALL'];

  if (monthStart) {
    const since = new Date(monthStart);
    if (!Number.isNaN(since.valueOf())) crit.push(['SINCE', since]);
  } else if (Number(rangeDays) > 0) {
    const since = new Date(Date.now() - Number(rangeDays) * 24 * 3600 * 1000);
    crit.push(['SINCE', since]);
  }

  if (monthEnd) {
    const end = new Date(monthEnd);
    if (!Number.isNaN(end.valueOf())) {
      // BEFORE is exclusive; add one day to include monthEnd date
      const before = new Date(end.getTime() + 24 * 3600 * 1000);
      crit.push(['BEFORE', before]);
    }
  }

  return crit;
}

function toModelSkeleton(msg) {
  // Envelope fields are safest to use across providers
  const from0 = msg.envelope?.from?.[0] ?? {};
  const to0   = msg.envelope?.to?.[0] ?? {};
  const subject = (msg.envelope?.subject ?? '').toString();

  // flags: imapflow returns a Set of strings like \Seen, \Flagged etc.
  const f = msg.flags instanceof Set ? msg.flags : new Set([]);

  return {
    id: String(msg.uid ?? msg.seq ?? ''),
    uid: msg.uid,
    subject,
    from: (from0.name || from0.address || '').toString(),
    fromEmail: (from0.address || '').toString(),
    to: (to0.address || '').toString(),
    date: msg.internalDate
      ? new Date(msg.internalDate).toISOString()
      : new Date().toISOString(),
    snippet: (msg.snippet || '').toString().trim(),
    headers: {},

    // convenience
    unread: !f.has('\\Seen'),
    flagged: f.has('\\Flagged'),

    // classification fields (filled/overwritten later)
    importance: 'unclassified',
    intent: '',
    urgency: 0,
    action_required: false,
    isVip: false,
    hasIcs: false,
    attachTypes: []
  };
}

async function hydrateSnippet(client, uid, model) {
  // Best-effort; never throw from here
  try {
    const dl = await client.download(uid);
    if (!dl || !dl.content) return model;

    const parsed = await simpleParser(dl.content);

    // Text-ish body
    const textish = (parsed.text || parsed.html || '')
      .toString()
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (textish) model.snippet = textish.slice(0, 600);

    // Quick metadata
    model.headers = Object.fromEntries(parsed.headers ?? []);
    model.hasIcs = !!parsed.attachments?.some(a => /calendar|ics/i.test(a.contentType || '') || /\.ics$/i.test(a.filename || ''));
    model.attachTypes = (parsed.attachments || []).map(a => a.contentType || '').slice(0, 6);
  } catch {
    // ignore parse failures
  }
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
    /\b(offer|promo|newsletter|digest|update)\b/.test(s)                 ? 'newsletter' :
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
  const action_required =
    /\bplease (review|approve|reply|confirm)|action required\b/.test(s) || urgency >= 2;

  // VIP (case-insensitive match on full email)
  const isVip = !!vipSenders.find(
    v => v && model.fromEmail?.toLowerCase() === String(v).toLowerCase()
  );

  return { ...model, intent, urgency, importance, action_required, isVip };
}

/** Normalize UID collection (Array/Set/TypedArray) and sort desc */
function normalizeUids(uids) {
  if (!uids) return [];
  // Convert to array if it's a Set/TypedArray/etc.
  const arr = Array.isArray(uids) ? uids : Array.from(uids);
  const nums = arr.map(Number).filter(n => Number.isFinite(n));
  nums.sort((a, b) => b - a); // newest first
  return nums;
}

/* ------------------------------ public API ------------------------------ */

/**
 * Fetch emails with optional cursor pagination.
 * Returns { items, nextCursor, hasMore }
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

    // Build search
    const criteria = buildDateCriteria({ rangeDays, monthStart, monthEnd });

    // Ask for UIDs, not seqs
    const uidListRaw = await client.search(criteria, { uid: true });
    const uidList = normalizeUids(uidListRaw);

    // cursor = last UID we returned previously (desc order).
    // We return newer → older. If cursor is provided, start after it.
    let start = 0;
    if (cursor != null) {
      const idx = uidList.indexOf(Number(cursor));
      start = idx >= 0 ? idx + 1 : 0;
    }

    const pageSize = Math.max(1, Number(limit) || 20);
    const slice = uidList.slice(start, start + pageSize);

    if (slice.length === 0) {
      await client.logout();
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Fetch metadata for the exact UID slice
    const raw = [];
    // Note: when passing UIDs array, use { uid: slice } as first arg
    for await (const msg of client.fetch({ uid: slice }, { uid: true, envelope: true, internalDate: true, flags: true, source: false })) {
      raw.push(msg);
    }

    // Map → model → add snippet → classify (heuristics)
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
    // Re-throw a clean error (imapRoutes will map to HTTP)
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
