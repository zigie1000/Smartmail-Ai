// imapService.js
// Robust IMAP fetch + optional login test using ImapFlow.

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

// Accept only search.rangeDays (number of days back)
// Everything else (time/range strings) is normalized in the route.
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

  const rangeDays = Math.max(0, Number(search.rangeDays || 0));
  const sinceDate = rangeDays > 0 ? new Date(Date.now() - rangeDays * 864e5) : null;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let uids;
      if (sinceDate) {
        uids = await client.search({ since: sinceDate }); // Date object (correct for IMAP)
      } else {
        uids = await client.search({});
      }

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
    try { await client.logout(); } catch {}
  }
}

export async function testLogin({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password'
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
