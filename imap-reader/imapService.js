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

// --- Helper to format Date into IMAP style (DD-MMM-YYYY) ---
function toIMAPDate(date) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun",
                  "Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = String(date.getDate()).padStart(2, '0'); // ensures 01, 02, ... 09
  return `${day}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

// Build IMAP SEARCH criteria
function buildSearch({ monthStart, monthEnd, dateStartISO, dateEndISO, rangeDays, query }) {
  const crit = ['ALL'];

  // 1) Month mode
  if (monthStart && monthEnd) {
    const start = new Date(monthStart);
    const endExclusive = new Date(new Date(monthEnd).getTime() + 86400000);
    crit.push(['SINCE',  toIMAPDate(start)]);
    crit.push(['BEFORE', toIMAPDate(endExclusive)]);
    return crit;
  }

  // 2) Absolute ISO mode
  if (dateStartISO && dateEndISO) {
    const start = new Date(dateStartISO);
    const endExclusive = new Date(new Date(dateEndISO).getTime() + 86400000);
    crit.push(['SINCE',  toIMAPDate(start)]);
    crit.push(['BEFORE', toIMAPDate(endExclusive)]);
    return crit;
  }

  // 3) Relative range (last N days; end exclusive = +1 day)
  if (rangeDays && Number(rangeDays) > 0) {
    const endExclusive = new Date(Date.now() + 86400000);
    const start = new Date(endExclusive.getTime() - (Math.max(1, Number(rangeDays)) * 86400000));
    crit.push(['SINCE',  toIMAPDate(start)]);
    crit.push(['BEFORE', toIMAPDate(endExclusive)]);
    return crit;
  }

  // 4) Fallback: query only
  if (query) return [{ gmailRaw: query }];

  return crit;
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
    console.log('IMAP SEARCH crit:', JSON.stringify(search));

    let uids = await client.search(search);
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
          model.snippet = String(basis).replace(/<[^>]+>/g, ' ')
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
