// imapService.js
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';

const defaultPort = 993;

function asImapConfig({ email, password, accessToken, host, port, tls, authType }) {
  const xoauth2 = authType === 'oauth' && accessToken
    ? `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
    : null;

  return {
    imap: {
      user: xoauth2 ? undefined : email,
      password: xoauth2 ? undefined : password,
      xoauth2,
      host: host || 'imap.gmail.com',
      port: Number(port || defaultPort),
      tls: tls !== false,
      // keep this permissive to avoid “self-signed certificate” on some hosts
      tlsOptions: { rejectUnauthorized: false, servername: host || 'imap.gmail.com' },
      connTimeout: 15000,
      authTimeout: 15000
    }
  };
}

// --- make sure criteria contains a real Date if SINCE is used
function normalizeCriteria(search) {
  if (!Array.isArray(search) || search.length === 0) return ['ALL'];
  if (String(search[0]).toUpperCase() !== 'SINCE') return search;

  const v = search[1];
  if (v instanceof Date) return ['SINCE', v];
  // v might be a number or string; coerce to Date
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? ['ALL'] : ['SINCE', d];
}

async function withMailbox(cfg, fn) {
  const connection = await imaps.connect(cfg);
  try {
    await connection.openBox('INBOX');
    return await fn(connection);
  } finally {
    try { await connection.end(); } catch {}
  }
}

export async function testLogin(opts) {
  const cfg = asImapConfig(opts || {});
  await withMailbox(cfg, async () => true);
  return true;
}

export async function fetchEmails({
  email, password, accessToken, host, port, tls, authType,
  search = ['ALL'], limit = 20
}) {
  const cfg = asImapConfig({ email, password, accessToken, host, port, tls, authType });
  const criteria = normalizeCriteria(search);
  const fetchOptions = {
    bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'], // headers only for speed/memory
    struct: true,
    markSeen: false
  };

  return await withMailbox(cfg, async (connection) => {
    // NOTE: log a *copy* for debugging so we don’t mutate the real criteria
    const dbg = Array.isArray(criteria) && criteria[0] === 'SINCE'
      ? ['SINCE', criteria[1].toISOString()]
      : criteria;
    console.log('IMAP criteria (server-side):', dbg);

    const uids = await connection.search(criteria, { byUid: true });
    const take = uids.slice(-Math.max(1, Math.min(limit, 200))); // cap
    if (take.length === 0) return { items: [], nextCursor: null, hasMore: false };

    const messages = await connection.fetch(take, fetchOptions);

    const items = [];
    for (const m of messages) {
      const hdr = m.parts?.find(p => p.which && p.which.startsWith('HEADER'))?.body || {};
      const subject = (hdr.subject && hdr.subject[0]) || '(no subject)';
      const from = (hdr.from && hdr.from[0]) || '';
      const date = (hdr.date && hdr.date[0]) || '';

      // very small snippet from text/plain if available (avoid big bodies)
      let snippet = '';
      try {
        const textPart = m.parts?.find(p => p.which === 'TEXT');
        if (textPart?.body) {
          const parsed = await simpleParser(textPart.body);
          snippet = (parsed.text || '').slice(0, 160);
        }
      } catch {}

      items.push({
        id: m.attributes?.uid,
        uid: m.attributes?.uid,
        subject,
        from,
        date,
        snippet,
        unread: !m.attributes?.flags?.includes('\\Seen'),
        flagged: m.attributes?.flags?.includes('\\Flagged'),
        hasIcs: !!m.attributes?.struct?.some?.(s => s.subtype === 'CALENDAR')
      });
    }

    // no pagination cursor for now (simple last-N fetch)
    return { items, nextCursor: null, hasMore: false };
  });
}
