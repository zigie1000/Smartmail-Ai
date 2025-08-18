// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.
// Fixes: ensures SINCE uses a real Date object and correct search structure.

/**
 * Install dependency if you haven't:
 *   npm i imapflow
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser'; // npm i mailparser

// Small helper: create a client safely
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
    // If you *must* use system CA on some providers, you can run Node with --use-system-ca.
    // We keep verification ON (good practice). Avoid rejectUnauthorized:false.
    ...auth
  });
}

/**
 * Normalize a MessageEnvelope+structure to the shape your classifier expects.
 */
function toItem({ meta, body, flags }) {
  const fromAddr = (meta.envelope.from && meta.envelope.from[0]) || {};
  const fromEmail = (fromAddr.address || '').toLowerCase();
  const fromDomain = fromEmail.split('@')[1] || '';

  // Very short snippet (from text parts), safe fallback:
  const snippet =
    (body.text && body.text.slice(0, 240)) ||
    (body.html && body.html.replace(/<[^>]+>/g, ' ').slice(0, 240)) ||
    '';

  const contentType =
    (body.headers && body.headers.get && body.headers.get('content-type')) ||
    '';

  // quick ICS/attachment hints
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
 *   search: { rangeDays?: number }  // build SINCE internally
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

  // Build search safely here so SINCE uses a real Date object.
  const rangeDays = Math.max(0, Number(search.rangeDays || 0));
  const sinceDate = rangeDays > 0 ? new Date(Date.now() - rangeDays * 864e5) : null;

  try {
    await client.connect();
    // lock mailbox
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search newest first; ImapFlow returns UIDs asc by default so we’ll slice from end.
      let uids;
      if (sinceDate) {
        // ImapFlow will format the internal IMAP query correctly when passed a Date object.
        uids = await client.search({ since: sinceDate });
      } else {
        uids = await client.search({}); // all messages
      }

      // Take last N (newest)
      if (uids.length > limit) {
        uids = uids.slice(-limit);
      }

      const items = [];
      for await (const msg of client.fetch(uids, {
        envelope: true,
        flags: true,
        internalDate: true,
        source: true, // stream raw source for parsing
      })) {
        // Parse to get text/html/attachments and headers
        const parsed = await simpleParser(msg.source);
        items.push(
          toItem({
            meta: { uid: msg.uid, envelope: msg.envelope, internalDate: msg.internalDate },
            body: parsed,
            flags: msg.flags
          })
        );
      }

      return {
        items,
        nextCursor: null,
        hasMore: false
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    // surface clear message for your logs/UI
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
  } catch (err) {
    return false;
  } finally {
    try { await client.logout(); } catch { /* noop */ }
  }
}
