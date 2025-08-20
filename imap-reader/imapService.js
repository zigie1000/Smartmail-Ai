// src/imap-reader/imapService.js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * Build an ImapFlow client with either password or XOAUTH2.
 */
function buildClient({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const auth =
    String(authType).toLowerCase() === 'xoauth2'
      ? { user: email, accessToken }                        // XOAUTH2
      : { user: email, pass: password };                    // Password / App Password

  return new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: !!tls,
    auth,
    logger: false,
    // be a bit forgiving with slow providers
    clientInfo: { name: 'SmartEmail/imap', version: '1.0' }
  });
}

/**
 * Convert an ImapFlow message to our lean item used by the UI/classifier.
 */
async function toItem(client, msgMeta) {
  const uid = msgMeta.uid;
  const envelope = msgMeta.envelope || {};
  const fromAddr = (envelope.from && envelope.from[0]) || {};
  const toAddr = (envelope.to && envelope.to[0]) || {};

  // Fetch body snippet safely (don’t download huge messages)
  let snippet = '';
  try {
    const { content } = await client.download('INBOX', uid, { uid: true });
    const parsed = await simpleParser(content, { skipImageLinks: true });
    snippet = (parsed.text || parsed.html || '').slice(0, 800);
  } catch {
    // ignore parsing errors for edge cases; leave snippet empty
  }

  const fromEmail = (fromAddr.address || '').trim();
  const fromDomain = fromEmail.split('@')[1] || '';

  return {
    id: String(uid),
    uid,
    from: [fromAddr.name, fromEmail].filter(Boolean).join(' '),
    fromEmail,
    fromDomain,
    to: toAddr.address || '',
    subject: envelope.subject || '',
    snippet,
    date: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
    unread: !msgMeta.seen,
    flagged: !!msgMeta.flagged,
    hasIcs: /text\/calendar/i.test(msgMeta['contentType'] || '') || false,
    attachTypes: Array.isArray(msgMeta.attachments) ? msgMeta.attachments.map(a => a.contentType) : [],
    headers: {},               // (kept minimal; add if you need)
    contentType: msgMeta['contentType'] || ''
  };
}

/**
 * Fetch emails with optional month or recent-day window + cursor pagination.
 * Returns { items, nextCursor, hasMore }
 *
 * Cursor semantics: we return messages sorted DESC by UID. The `cursor`
 * you pass back to us should be the **last UID** from previous page; we’ll
 * continue with smaller UIDs.
 */
export async function fetchEmails({
  email = '',
  password = '',
  accessToken = '',
  host = '',
  port = 993,
  tls = true,
  authType = 'password',
  monthStart,
  monthEnd,
  rangeDays = 7,
  limit = 20,
  cursor = null // last UID from previous page (string|number)
} = {}) {
  const client = buildClient({ email, password, accessToken, host, port, tls, authType });

  await client.connect();
  try {
    // Always select INBOX
    await client.mailboxOpen('INBOX');

    // ---- Build search query ----
    // ImapFlow search is an array of criteria. We’ll use SINCE/BEFORE + UID cut.
    const search = [];

    // Month window
    if (monthStart && monthEnd) {
      const since = new Date(monthStart);
      const before = new Date(new Date(monthEnd).getTime() + 24 * 3600 * 1000); // inclusive end
      search.push(['SINCE', since], ['BEFORE', before]);
    } else if (Number(rangeDays) > 0) {
      const since = new Date(Date.now() - Number(rangeDays) * 24 * 3600 * 1000);
      search.push(['SINCE', since]);
    }

    // Cursor: work backwards from last UID
    if (cursor) {
      const last = Number(cursor);
      if (!Number.isNaN(last)) {
        // Only fetch messages with UID < last (older)
        search.push(['UID', `1:${last - 1}`]);
      }
    }

    // Get matching UIDs (ascending), then take newest first
    const uidsAsc = await client.search(search.length ? search : ['ALL'], { uid: true });
    const uidsDesc = uidsAsc.sort((a, b) => b - a);

    // Slice page
    const pageUids = uidsDesc.slice(0, Number(limit) || 20);

    // Fetch metadata for each UID efficiently
    const items = [];
    for (const uid of pageUids) {
      const meta = await client.fetchOne(uid, {
        uid: true,
        envelope: true,
        flags: true,
        struct: true
      }, { uid: true });

      // Compose a minimal meta object for toItem()
      const msgMeta = {
        uid,
        envelope: meta?.envelope || {},
        seen: meta?.flags?.has('\\Seen'),
        flagged: meta?.flags?.has('\\Flagged'),
        attachments: Array.isArray(meta?.attachments) ? meta.attachments : [],
        contentType: meta?.contentType || ''
      };

      items.push(await toItem(client, msgMeta));
    }

    // Determine next cursor (older page) if there are more UIDs left
    const hasMore = uidsDesc.length > pageUids.length;
    const nextCursor = hasMore ? String(pageUids[pageUids.length - 1]) : null;

    return { items, nextCursor, hasMore };
  } finally {
    // Close mailbox and connection safely
    try { await client.mailboxClose(); } catch {}
    await client.logout().catch(() => {});
  }
}

/**
 * Lightweight connection test — tries to open INBOX and returns true/false.
 */
export async function testLogin({ email = '', password = '', accessToken = '', host = '', port = 993, tls = true, authType = 'password' } = {}) {
  const client = buildClient({ email, password, accessToken, host, port, tls, authType });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    return true;
  } catch {
    return false;
  } finally {
    try { await client.mailboxClose(); } catch {}
    await client.logout().catch(() => {});
  }
}

// Optional default export (lets you import either way if you ever need it)
export default { fetchEmails, testLogin };
