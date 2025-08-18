// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.
// Adds: OPTIONAL month-based search (YYYY-MM) alongside existing rangeDays.

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
    ...auth
  });
}

// --- NEW: parse YYYY-MM into [since, before]
function monthToRange(monthStr) {
  // monthStr must be like '2025-08'
  if (typeof monthStr !== 'string' || !/^\d{4}-\d{2}$/.test(monthStr)) return null;
  const [y, m] = monthStr.split('-').map(Number);
  const since = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));     // first day of month (UTC)
  const before = new Date(Date.UTC(y, m, 1, 0, 0, 0));        // first day of next month (UTC)
  return { since, before };
}

/**
 * Normalize a MessageEnvelope+structure to the shape your classifier expects.
 */
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
 *   search: { rangeDays?: number, month?: 'YYYY-MM' }  // month is NEW
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

  // Build search safely:
  // Priority: month → else rangeDays → else all
  let sinceDate = null;
  let beforeDate = null;

  if (search.month) {
    const rng = monthToRange(search.month);
    if (rng) {
      sinceDate = rng.since;
      beforeDate = rng.before;
    }
  }

  if (!sinceDate && typeof search.rangeDays !== 'undefined') {
    const rangeDays = Math.max(0, Number(search.rangeDays || 0));
    if (rangeDays > 0) {
      sinceDate = new Date(Date.now() - rangeDays * 864e5);
    }
  }

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // ImapFlow search supports { since, before }
      // If neither is set, pass {} to fetch all.
      const criteria = {};
      if (sinceDate) criteria.since = sinceDate;
      if (beforeDate) criteria.before = beforeDate;

      let uids = await client.search(criteria);

      // Take last N (newest)
      if (uids.length > limit) {
        uids = uids.slice(-limit);
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

      return {
        items,
        nextCursor: null,
        hasMore: false
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    const m = String(err && err.message) || 'IMAP fetch failed';
    throw new Error(`IMAP /fetch error: ${m}`);
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Lightweight connectivity test (safe to delete later).
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
    try { await client.logout(); } catch {}
  }
}
