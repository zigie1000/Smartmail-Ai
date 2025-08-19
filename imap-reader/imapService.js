// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.
// Keeps your stable behavior. Adds optional month range support.
//
// Install deps:
//   npm i imapflow mailparser

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

function makeClient({ host, port = 993, tls = true, authType = 'password', email, password, accessToken }) {
  const auth =
    authType === 'xoauth2'
      ? { auth: { user: email, accessToken } }
      : { auth: { user: email, pass: password } };

  return new ImapFlow({
    host,
    port,
    secure: !!tls,
    clientInfo: { name: 'SmartEmail', version: '1.0' },
    ...auth
  });
}

function toItem({ meta, body, flags }) {
  const fromAddr = (meta.envelope.from && meta.envelope.from[0]) || {};
  const fromEmail = (fromAddr.address || '').toLowerCase();
  const fromDomain = fromEmail.split('@')[1] || '';

  const snippet =
    (body.text && body.text.slice(0, 240)) ||
    (body.html && body.html.replace(/<[^>]+>/g, ' ').slice(0, 240)) ||
    '';

  const contentType =
    (body.headers && body.headers.get && body.headers.get('content-type')) ||
    '';

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
    to:
      (meta.envelope.to || [])
        .map(t => t.address)
        .filter(Boolean)
        .join(', ') || '',
    subject: meta.envelope.subject || '',
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
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    contentType
  };
}

/**
 * Fetch emails from INBOX.
 * Options:
 *   email, password, accessToken, host, port, tls, authType
 *   search:
 *     - Array form (back-compat): ['ALL'] or ['SINCE', Date]
 *     - Object form: { rangeDays?: number } OR { monthStart: ISO, monthEnd: ISO }
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

  // Build final search params for ImapFlow
  // Support BOTH your old array input and the new month range.
  let sinceDate = null;
  let beforeDate = null;

  if (Array.isArray(search)) {
    // ['ALL'] or ['SINCE', Date]
    if (search.length === 1 && String(search[0]).toUpperCase() === 'ALL') {
      // no filters
    } else if (search.length === 2 && String(search[0]).toUpperCase() === 'SINCE' && search[1] instanceof Date) {
      sinceDate = search[1];
    }
  } else if (search && typeof search === 'object') {
    const { rangeDays, monthStart, monthEnd } = search;

    if (monthStart && monthEnd && !Number.isNaN(Date.parse(monthStart)) && !Number.isNaN(Date.parse(monthEnd))) {
      const start = new Date(monthStart);
      const end = new Date(monthEnd);
      if (!Number.isNaN(+start) && !Number.isNaN(+end)) {
        // ImapFlow supports { since: Date, before: Date }
        // Use end + 1 day to make the end inclusive
        sinceDate = start;
        beforeDate = new Date(end.getTime() + 24*3600*1000);
      }
    } else if (Number.isFinite(+rangeDays) && rangeDays > 0) {
      sinceDate = new Date(Date.now() - Number(rangeDays) * 864e5);
    }
  }

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids;
      if (sinceDate && beforeDate) {
        uids = await client.search({ since: sinceDate, before: beforeDate });
      } else if (sinceDate) {
        uids = await client.search({ since: sinceDate });
      } else {
        uids = await client.search({});
      }

      if (uids.length > limit) {
        uids = uids.slice(-limit); // newest
      }

      const items = [];
      for await (const msg of client.fetch(uids, {
        envelope: true,
        flags: true,
        internalDate: true,
        source: true
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
    } finally {
      lock.release();
    }
  } catch (err) {
    const m = String(err && err.message) || 'IMAP fetch failed';
    throw new Error(`IMAP /fetch error: ${m}`);
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}

/**
 * Lightweight connectivity test (safe to delete later).
 * Simply opens INBOX and logs out.
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
    await client.getMailboxLock('INBOX').then(l => l.release());
    return true;
  } catch {
    return false;
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}
