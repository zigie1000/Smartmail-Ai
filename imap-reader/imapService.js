// imapService.js — ImapFlow-based IMAP access with optional full-body hydration.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

function domainOf(email = '') {
  const m = String(email).toLowerCase().match(/@([^> ]+)/);
  return m ? m[1] : '';
}

function toModelSkeleton(msg) {
  const env = msg.envelope || {};
  const fromAddr = (env.from && env.from[0]) ? env.from[0] : {};
  const toAddr   = (env.to && env.to[0]) ? env.to[0] : {};
  const fromEmail = (fromAddr.address || '').toLowerCase();
  const fromDomain = domainOf(fromEmail);

  return {
    id: String(msg.uid || msg.id || msg.seq || ''),
    uid: msg.uid,
    subject: env.subject || '',
    from: fromAddr.name ? `${fromAddr.name} <${fromEmail}>` : fromEmail,
    fromEmail,
    fromDomain,
    to: toAddr.address || '',

    date: (msg.internalDate ? new Date(msg.internalDate).toISOString() : '') || '',
    internalDate: (() => {
      if (msg.internalDate) {
        const raw = Number(msg.internalDate);
        return raw < 1e11 ? raw * 1000 : raw;
      }
      return null;
    })(),
    receivedAt: (() => {
      if (msg.internalDate) {
        const raw = Number(msg.internalDate);
        return raw < 1e11 ? raw * 1000 : raw;
      }
      return null;
    })(),

    snippet: '',
    text: '',
    html: '',
    headers: {},
    hasIcs: false,
    attachTypes: [],
    unread: !msg.flags?.has('\\Seen'),
    flagged: !!msg.flags?.has('\\Flagged'),
    contentType: ''
  };
}

async function openClient({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const client = new ImapFlow({
    host,
    port,
    secure: !!tls,
    auth: (String(authType).toLowerCase() === 'xoauth2')
      ? { user: email, accessToken, method: 'XOAUTH2' }
      : { user: email, pass: password }
  });
  await client.connect();
  await client.mailboxOpen('INBOX');
  return client;
}

// helper: human-readable IMAP date (debug only)
function toIMAPDate(d) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Normalize any incoming date-ish value to a real Date.
 *  For 'YYYY-MM-DD', pin to midnight UTC to avoid TZ drift. */
function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
    return new Date(dateOnly ? `${v}T00:00:00Z` : v);
  }
  return new Date(v);
}

/** Build IMAP SEARCH criteria as a FLAT array (some servers reject nested). */
function buildSearch({ monthStart, monthEnd, dateStartISO, dateEndISO, rangeDays, query }) {
  // 4) Raw Gmail query fallback (explicit)
  if (query) return [{ gmailRaw: query }];

  // 1) Month mode (inclusive start, exclusive end)
  if (monthStart && monthEnd) {
    const start = asDate(monthStart);
    const endExclusive = new Date(asDate(monthEnd).getTime() + 86400000);
    return ['ALL', 'SINCE', start, 'BEFORE', endExclusive];
  }

  // 2) Absolute ISO window (inclusive start, exclusive end)
  if (dateStartISO && dateEndISO) {
    const start = asDate(dateStartISO);
    const endExclusive = new Date(asDate(dateEndISO).getTime() + 86400000);
    return ['ALL', 'SINCE', start, 'BEFORE', endExclusive];
  }

  // 3) Relative range (last N days; end = now)
  if (rangeDays && Number(rangeDays) > 0) {
    const endExclusive = new Date();
    const start = new Date(endExclusive.getTime() - (Math.max(1, Number(rangeDays)) - 1) * 86400000);
    return ['ALL', 'SINCE', start, 'BEFORE', endExclusive];
  }

  // default
  return ['ALL'];
}

/* ---------- Gmail fallback helpers ---------- */
function toYMD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`; // Gmail expects slashes
}

// Convert search array → Gmail RAW (supports SINCE/BEFORE Dates)
function buildGmailRawFromSearch(search) {
  if (!Array.isArray(search)) return null;
  const iSince = search.indexOf('SINCE');
  const iBefore = search.indexOf('BEFORE');
  const since = (iSince !== -1 && search[iSince+1] instanceof Date) ? search[iSince+1] : null;
  const before = (iBefore !== -1 && search[iBefore+1] instanceof Date) ? search[iBefore+1] : null;

  if (since && before) return `newer:${toYMD(since)} older:${toYMD(before)}`;
  if (since) return `newer:${toYMD(since)}`;
  if (before) return `older:${toYMD(before)}`;
  return null;
}

async function parseFromSource(source) {
  const parsed = await simpleParser(source);
  const text = parsed.text || '';
  const html = parsed.html || '';
  const headers = {};
  for (const [k, v] of parsed.headers) headers[String(k).toLowerCase()] = v;

  const attachTypes = [];
  let hasIcs = false;
  for (const a of parsed.attachments || []) {
    const ct = (a.contentType || '').toLowerCase();
    attachTypes.push(ct);
    if (ct.includes('text/calendar') || (a.filename || '').toLowerCase().endsWith('.ics')) hasIcs = true;
  }
  const contentType = html ? 'text/html' : 'text/plain';

  return { text, html, headers, attachTypes, hasIcs, contentType };
}

export async function fetchEmails(opts = {}) {
  const {
    email, password, accessToken, host, port = 993, tls = true, authType = 'password',
    monthStart, monthEnd, dateStartISO, dateEndISO,
    rangeDays,
    limit = 20,
    cursor = null,
    query = '',
    vipSenders = [],
    fullBodies = false
  } = opts;

  const client = await openClient({ email, password, accessToken, host, port, tls, authType });
  try {
    const search = buildSearch({ monthStart, monthEnd, dateStartISO, dateEndISO, rangeDays, query });

    // Debug without JSON stringifying Dates:
    console.log(
      'IMAP SEARCH crit (debug):',
      Array.isArray(search)
        ? search.map(x => x instanceof Date ? `${x.toUTCString()} (${toIMAPDate(x)})` : x)
        : search
    );

    // ---------- Optional sanity guard ----------
    if (Array.isArray(search)) {
      const iSince = search.indexOf('SINCE');
      const iBefore = search.indexOf('BEFORE');
      if (iSince !== -1 && !(search[iSince+1] instanceof Date)) {
        throw new Error('SEARCH guard: SINCE must be a Date');
      }
      if (iBefore !== -1 && !(search[iBefore+1] instanceof Date)) {
        throw new Error('SEARCH guard: BEFORE must be a Date');
      }
    }
    // ------------------------------------------

    // Perform search with Gmail RAW fallback on BAD
    let uids;
    try {
      uids = await client.search(search);
    } catch (err) {
      const msg = String(err?.response || err?.responseText || err?.message || '');
      const isBAD = msg.toUpperCase().includes('BAD');
      const raw = buildGmailRawFromSearch(search);
      console.warn('IMAP SEARCH failed; attempting gmailRaw fallback.', { isBAD, raw, err: err?.message });
      if (isBAD && raw) {
        uids = await client.search([{ gmailRaw: raw }]);
      } else {
        throw err;
      }
    }

    uids = (uids || []).sort((a, b) => b - a);

    let filtered = cursor ? uids.filter(uid => uid < Number(cursor)) : uids;
    const page = filtered.slice(0, Math.max(1, Number(limit) || 20));

    const fetchOpts = fullBodies
      ? { envelope: true, internalDate: true, source: true, uid: true, flags: true }
      : { envelope: true, internalDate: true, uid: true, flags: true };

    const items = [];
    for await (const msg of client.fetch({ uid: page }, fetchOpts)) {
      const model = toModelSkeleton(msg);

      if (fullBodies && msg.source) {
        try {
          const body = await parseFromSource(msg.source);
          Object.assign(model, body);
          const basis = model.text || model.html || '';
          model.snippet = String(basis)
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 600);
        } catch {}
      } else {
        try {
          const { content } = await client.download(msg.uid);
          if (content) {
            const body = await parseFromSource(content);
            model.snippet = (body.text || body.html || '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 180);
          }
        } catch {}
      }

      // VIP tagging (if provided)
      const from = (model.fromEmail || '').toLowerCase();
      const dom  = (model.fromDomain || '').toLowerCase();
      model.isVip = vipSenders.some(v => {
        v = String(v || '').toLowerCase().trim();
        return v && (from === v || dom === v);
      });

      items.push(model);
    }

    const nextCursor = page.length ? String(page[page.length - 1]) : null;
    const hasMore = filtered.length > page.length;

    return { items, nextCursor, hasMore };
  } finally {
    try { await client.logout(); } catch {}
  }
}

export async function getMessageById({ email, password, accessToken, host, port = 993, tls = true, authType = 'password', id }) {
  const client = await openClient({ email, password, accessToken, host, port, tls, authType });
  try {
    const uid = Number(id);
    const fetchOpts = { envelope: true, internalDate: true, source: true, uid: true, flags: true };
    let out = null;
    for await (const msg of client.fetch({ uid }, fetchOpts)) {
      const model = toModelSkeleton(msg);
      if (msg.source) {
        try {
          const body = await parseFromSource(msg.source);
          Object.assign(model, body);
        } catch {}
      }
      out = model;
      break;
    }
    return out;
  } finally {
    try { await client.logout(); } catch {}
  }
}

export async function testLogin({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const client = new ImapFlow({
    host, port, secure: !!tls,
    auth: (String(authType).toLowerCase() === 'xoauth2')
      ? { user: email, accessToken, method: 'XOAUTH2' }
      : { user: email, pass: password }
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    return true;
  } catch {
    return false;
  } finally {
    try { await client.logout(); } catch {}
  }
}
