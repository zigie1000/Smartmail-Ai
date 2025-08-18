// imap-reader/imapService.js
import { ImapFlow } from 'imapflow';

/**
 * Create a connected ImapFlow client
 */
async function connectClient({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const auth =
    authType === 'oauth2'
      ? { user: email, accessToken }                // XOAUTH2
      : { user: email, pass: password };            // App password / password

  const client = new ImapFlow({
    host,
    port,
    secure: tls !== false,                          // 993 -> true
    auth,
    logger: false,                                  // keep logs quiet in prod
    // We already start node with --use-system-ca, so no need to relax TLS here.
  });

  await client.connect();
  return client;
}

/**
 * Normalize “search” from routes into an ImapFlow query
 * - Accepts: true | ['ALL'] | ['SINCE', Date] | object with {since}
 */
function toImapFlowQuery(search) {
  // If route passed the old shape like ['SINCE', Date]
  if (Array.isArray(search) && search.length === 2 && String(search[0]).toUpperCase() === 'SINCE') {
    const dt = search[1] instanceof Date ? search[1] : new Date(search[1]);
    return Number.isFinite(dt?.getTime()) ? { since: dt } : true;
  }
  // If route passed ['ALL']
  if (Array.isArray(search) && search.length === 1 && String(search[0]).toUpperCase() === 'ALL') {
    return true;
  }
  // If already an object query (e.g. { since: Date })
  if (search && typeof search === 'object' && !(search instanceof Date)) {
    return search;
  }
  // Fallback: ALL
  return true;
}

/**
 * Fetch emails (metadata only; fast + low memory)
 */
export async function fetchEmails({
  email, password, accessToken,
  host, port = 993, tls = true, authType = 'password',
  search = true,
  limit = 20,
  mailbox = 'INBOX'
}) {
  const client = await connectClient({ email, password, accessToken, host, port, tls, authType });

  try {
    await client.mailboxOpen(mailbox);

    const query = toImapFlowQuery(search);

    // Search newest first
    const uids = await client.search(query, { uid: true });
    uids.sort((a, b) => b - a); // descending (newest first)
    const wanted = uids.slice(0, Math.max(1, Number(limit) || 20));

    const items = [];
    // Fetch envelope/meta only (no bodies) for speed & memory
    for await (const msg of client.fetch(wanted, {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
      bodyStructure: true
    })) {
      const fromAddr = (msg.envelope?.from?.[0] || {});
      const toAddr = (msg.envelope?.to?.[0] || {});
      const fromEmail = (fromAddr.address || '').toLowerCase();
      const fromDomain = fromEmail.split('@')[1] || '';

      items.push({
        id: String(msg.uid),
        uid: msg.uid,
        from: [fromAddr.name, fromEmail].filter(Boolean).join(' '),
        fromEmail,
        fromDomain,
        to: (toAddr.address || ''),
        subject: msg.envelope?.subject || '',
        date: msg.internalDate ? new Date(msg.internalDate).toISOString() : null,
        headers: {},                // not fetched here (can be added if you need)
        hasIcs: false,              // body not fetched in this light mode
        attachTypes: (msg.bodyStructure?.childNodes || [])
          .filter(p => p.disposition === 'attachment' && p.type && p.subtype)
          .map(p => `${p.type}/${p.subtype}`.toLowerCase()),
        unread: !msg.flags?.has('\\Seen'),
        flagged: !!msg.flags?.has('\\Flagged'),
        contentType: ''             // not fetched here
      });
    }

    return { items, nextCursor: null, hasMore: uids.length > items.length };
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

/**
 * Lightweight connection test (no search, no fetch)
 */
export async function testLogin({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  let client;
  try {
    client = await connectClient({ email, password, accessToken, host, port, tls, authType });
    await client.logout();
    return true;
  } catch {
    try { if (client) await client.logout(); } catch {}
    return false;
  }
}
