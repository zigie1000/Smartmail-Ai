// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.
// Fixes:
//  - Uses ImapFlow only (no imap-simple).
//  - Ensures SINCE is a real Date object.
//  - Treats `search.rangeDays` and `search.time` as the SAME control.
//  - Keeps testLogin as a safe-to-remove helper later.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser'; // npm i mailparser

function makeClient({ host, port = 993, tls = true, authType = 'password', email, password, accessToken }) {
  // Support password + XOAUTH2 explicitly
  const isXOAUTH2 = String(authType).toLowerCase() === 'xoauth2';

  return new ImapFlow({
    host,
    port,
    secure: !!tls,
    clientInfo: { name: 'SmartEmail', version: '1.0' },
    auth: isXOAUTH2
      ? { user: email, accessToken, method: 'XOAUTH2' }
      : { user: email, pass: password }
    // TLS verification left ON. Use `node --use-system-ca` at runtime (already in package.json).
  });
}

function toItem({ meta, body, flags }) {
  const fromAddr = (meta.envelope?.from && meta.envelope.from[0]) || {};
  const fromEmail = (fromAddr.address || '').toLowerCase();
  const fromDomain = fromEmail.split('@')[1] || '';

  const snippet =
    (body.text && body.text.slice(0, 240)) ||
    (body.html && body.html.replace(/<[^>]+>/g, ' ').slice(0, 240)) ||
    '';

  const contentType =
    (body.headers && body.headers.get && body.headers.get('content-type')) || '';

  const attachTypes = [];
  let hasIcs = false;
  if (body.attachments && body.attachments.length) {
    for (const a of body.attachments) {
      const ct = (a.contentType || '').toLowerCase();
      attachTypes.push(ct);
      if (ct.includes('text/calendar') || (a.filename || '').toLowerCase().endsWith('.ics')) {
        hasIcs = true;
      }
    }
  }

  return {
    id: String(meta.uid),
    uid: meta.uid,
    from: fromAddr.name || fromEmail || '',
    fromEmail,
    fromDomain,
    to: (meta.envelope?.to || []).map(t => t.address).filter(Boolean).join(', ') || '',
    subject: meta.envelope?.subject || '',
    snippet,
    date: meta.internalDate ? new Date(meta.internalDate).toISOString() : '',
    headers: (() => {
      const h = {};
      if (body.headers && body.headers.forEach) {
        body.headers.forEach((v, k) => (h[k] = v));
      }
      return h;
    })(),
    hasIcs,
    attachTypes,
    unread: !flags?.has('\\Seen'),
    flagged: !!flags?.has('\\Flagged'),
    contentType
  };
}

/**
 * Fetch emails from INBOX.
 * Inputs:
 *   email, password, accessToken, host, port, tls, authType
 *   search: { rangeDays?: number, time?: number } // time and rangeDays are treated the same
 *   limit: number
 */
export async function fetchEmails({
  email,
  password,
  accessToken,
  host,
  port = 993,
  tls = true,
  authType = 'password',
  search = {},
  limit = 20
}) {
  const client = makeClient({ host, port, tls, authType, email, password, accessToken });

  // Treat `time` and `rangeDays` as the same control:
  const rangeDays = Math.max(0, Number(search.rangeDays ?? search.time ?? 0));
  const sinceDate = rangeDays > 0 ? new Date(Date.now() - rangeDays * 864e5) : null;

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    // Build ImapFlow query
    const query = sinceDate ? { since: sinceDate } : {}; // {} => ALL
    let uids = await client.search(query, { uid: true });

    // newest first: take last N
    if (uids.length > limit) {
      uids = uids.slice(-Number(limit || 20));
    }

    const items = [];
    for await (const msg of client.fetch(uids, {
      envelope: true,
      flags: true,
      internalDate: true,
      source: true // parse once to get text/html/attachments/headers
    })) {
      const parsed = await simpleParser(msg.source);
      items.push(
        toItem({
          meta: { uid: msg.uid, envelope: msg.envelope, internalDate: msg.internalDate },
          body: parsed,
          flags: msg.flags
        })
      );
    }

    return { items, nextCursor: null, hasMore: false };
  } catch (err) {
    const m = String(err && err.message) || 'IMAP fetch failed';
    throw new Error(`IMAP /fetch error: ${m}`);
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}

/**
 * Lightweight connectivity test (safe to delete later).
 * Opens INBOX and logs out.
 */
export async function testLogin({
  email,
  password,
  accessToken,
  host,
  port = 993,
  tls = true,
  authType = 'password'
}) {
  const client = makeClient({ host, port, tls, authType, email, password, accessToken });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    return true;
  } catch {
    return false;
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}
