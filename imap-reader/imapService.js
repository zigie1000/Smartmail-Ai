// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.
// Keeps stable behavior. Adds month range support as TOP-LEVEL args,
// while remaining backward-compatible with the old `search` param.
//
// deps:
//   npm i imapflow mailparser

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Create client
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

// Normalize one message
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
 *   // NEW preferred top-level filters:
 *   monthStart?: ISO string (YYYY-MM-DD or full ISO)
 *   monthEnd?:   ISO string (inclusive; we add +1 day internally)
 *   rangeDays?:  number  (used when month* not provided; 0 => ALL)
 *
* Back-compat: ignored if monthStart/monthEnd or rangeDays are provided top-level
 *   search?: ['ALL'] | ['SINCE', Date] | { rangeDays?: number, monthStart?: string, monthEnd?: string }
 *
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

  // ⬇️ NEW top-level filters
  monthStart = null,
  monthEnd = null,
  rangeDays = null,

  // legacy input kept for compatibility
  search = undefined,

  limit = 20
}) {
  const client = makeClient({ host, port, tls, authType, email, password, accessToken });

  // --- Build final search window (prefer new top-level args) ---
  let sinceDate = null;
  let beforeDate = null; // exclusive

  // 1) Top-level month range
  const ms = monthStart && !Number.isNaN(Date.parse(monthStart)) ? new Date(monthStart) : null;
  const me = monthEnd   && !Number.isNaN(Date.parse(monthEnd))   ? new Date(monthEnd)   : null;

  if (ms && me) {
    // make end inclusive by querying before = (end + 1 day)
    sinceDate  = ms;
    beforeDate = new Date(me.getTime() + 24 * 3600 * 1000);
  } else if (Number.isFinite(+rangeDays) && rangeDays > 0) {
    // 2) Top-level relative range
    sinceDate = new Date(Date.now() - Number(rangeDays) * 864e5);
  } else if (search !== undefined) {
    // 3) Legacy `search` handling (array or object)
    if (Array.isArray(search)) {
      // ['ALL'] or ['SINCE', Date]
      if (search.length === 2 && String(search[0]).toUpperCase() === 'SINCE' && search[1] instanceof Date) {
        sinceDate = search[1];
      }
      // else: ALL => no filters
    } else if (search && typeof search === 'object') {
      const { rangeDays: rd, monthStart: oms, monthEnd: ome } = search || {};
      const omsD = oms && !Number.isNaN(Date.parse(oms)) ? new Date(oms) : null;
      const omeD = ome && !Number.isNaN(Date.parse(ome)) ? new Date(ome) : null;
      if (omsD && omeD) {
        sinceDate  = omsD;
        beforeDate = new Date(omeD.getTime() + 24 * 3600 * 1000);
      } else if (Number.isFinite(+rd) && rd > 0) {
        sinceDate = new Date(Date.now() - Number(rd) * 864e5);
      }
    }
  }
  // else: no time filter => ALL

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

      // newest N
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

// Simple connectivity test
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
