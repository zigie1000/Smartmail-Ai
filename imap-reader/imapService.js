// imapService.js — ImapFlow-based IMAP access with optional full-body hydration.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

function domainOf(email='') {
  const m = String(email).toLowerCase().match(/@([^> ]+)/);
  return m ? m[1] : '';
}

function toModelSkeleton(msg) {
  const env = msg.envelope || {};
  const fromAddr = (env.from && env.from[0]) ? env.from[0] : {};
  const toAddr = (env.to && env.to[0]) ? env.to[0] : {};
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
      // keep both ISO and numeric timestamps
  date: (msg.internalDate ? new Date(msg.internalDate).toISOString() : '') || '',
  internalDate: (() => {
    if (msg.internalDate) {
      const raw = Number(msg.internalDate);
      return raw < 1e12 ? raw * 1000 : raw; // normalize seconds → ms
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

function buildSearch({ monthStart, monthEnd, dateStartISO, dateEndISO, query }) {
  // Priority: month window -> absolute date window -> none
  if (monthStart && monthEnd) {
    return { since: new Date(monthStart), before: new Date(new Date(monthEnd).getTime() + 24*3600*1000), or: query };
  }
  if (dateStartISO && dateEndISO) {
    return { since: new Date(dateStartISO), before: new Date(new Date(dateEndISO).getTime() + 24*3600*1000), or: query };
  }
  return { or: query }; // fallback (be careful with unbounded)
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
    rangeDays, // unused here—already converted to absolute by routes
    limit = 20,
    cursor = null, // UID to start after (optional)
    query = '',
    vipSenders = [],
    fullBodies = false
  } = opts;

  const client = await openClient({ email, password, accessToken, host, port, tls, authType });
  try {
    const search = buildSearch({ monthStart, monthEnd, dateStartISO, dateEndISO, query });

    // Build a set of matching UIDs (descending, newest first)
    let uids = await client.search(search);
    uids = (uids || []).sort((a, b) => b - a); // newest first

    // Cursor paging (if provided, skip anything >= cursor)
    let filtered = cursor ? uids.filter(uid => uid < Number(cursor)) : uids;
    const page = filtered.slice(0, Math.max(1, Number(limit) || 20));

    // Prepare fetch options
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
          // preview text (short)
          const basis = model.text || model.html || '';
          model.snippet = String(basis).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
        } catch {}
      } else {
        // lightweight snippet: try quick download
        try {
          const { content } = await client.download(msg.uid);
          if (content) {
            const body = await parseFromSource(content);
            model.snippet = (body.text || body.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
          }
        } catch { /* ignore */ }
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
