// imapService.js — wraps imap-simple with safer defaults and correct exports
import imaps from 'imap-simple';
import dns from 'dns';

// Prefer IPv4 first to avoid some provider DNS issues
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

/**
 * Build imap-simple config from options
 */
function buildConfig({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const xoauth2 = (authType === 'xoauth2' && accessToken) ? accessToken : undefined;

  const tlsOptions = {};
  if (ALLOW_SELF_SIGNED) tlsOptions.rejectUnauthorized = false;
  if (host) tlsOptions.servername = host;

  return {
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,            // for XOAUTH2 flows
      host,
      port,
      tls,
      tlsOptions,
      authTimeout: 10000, // 10s connect/auth timeout
    }
  };
}

/**
 * Normalize search criteria so node-imap accepts it.
 * node-imap expects:
 *   - ['ALL']  OR
 *   - ['SINCE', Date]   // Date object, not string
 * It does NOT accept nested arrays or ISO strings for the date.
 */
function normalizeCriteria(search) {
  if (!Array.isArray(search) || search.length === 0) return ['ALL'];

  // Flatten a single nested tuple like [['SINCE', <date>]]
  if (Array.isArray(search[0]) && search.length === 1) {
    search = search[0];
  }

  if (String(search[0]).toUpperCase() === 'SINCE') {
    const raw = search[1];
    const d = (raw instanceof Date) ? raw : new Date(raw);
    if (Number.isNaN(d?.getTime())) {
      return ['ALL'];
    }
    return ['SINCE', d];
  }

  // If caller passed something already acceptable (e.g. ['ALL'])
  return search;
}

/**
 * Test IMAP login by opening the mailbox list.
 * Returns true/false (never throws to the caller).
 */
export async function testLogin(opts) {
  const config = buildConfig(opts);
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.getBoxes();
    await connection.end();
    return true;
  } catch (e) {
    if (connection) {
      try { await connection.end(); } catch {}
    }
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

/**
 * Fetch emails using imap-simple.
 * Accepts:
 *   search: ['ALL']  or  ['SINCE', Date]  (strings/ISO will be converted)
 *   limit: number of messages to return from the end of the result set
 */
export async function fetchEmails({
  email,
  password,
  accessToken,
  host,
  port = 993,
  tls = true,
  authType = 'password',
  search = ['ALL'],
  limit = 20
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });

  // Ensure criteria are in the exact shape node-imap expects
  const criteria = normalizeCriteria(search);

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Bodies: HEADER and TEXT are usually enough for preview/classification
    const fetchOpts = { bodies: ['HEADER', 'TEXT'], markSeen: false };

    // Helpful debug (kept quiet in success paths)
    console.log('IMAP criteria (normalized):', Array.isArray(criteria) && criteria[1] instanceof Date
      ? ['SINCE', criteria[1].toISOString()]
      : criteria
    );

    const results = await connection.search(criteria, fetchOpts);

    // Keep the last N messages according to 'limit'
    const max = Math.max(1, Number(limit) || 20);
    const slice = results.slice(-max);

    const emails = slice.map((res, idx) => {
      const header = res.parts.find(p => p.which === 'HEADER')?.body || {};
      const text = res.parts.find(p => p.which === 'TEXT')?.body || '';

      const fromHdr = (header.from && header.from[0]) || '';
      const subject = (header.subject && header.subject[0]) || '';
      const date = (header.date && header.date[0]) || '';

      const fromEmail = /<([^>]+)>/.exec(fromHdr)?.[1] || fromHdr;
      const fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();

      // node-imap doesn’t parse attachments here; we expose basics for classifier
      return {
        id: res.attributes.uid || String(idx + 1),
        uid: res.attributes.uid,
        from: fromHdr,
        fromEmail,
        fromDomain,
        to: ((header.to && header.to[0]) || ''),
        subject,
        snippet: String(text).slice(0, 500),
        text: String(text).slice(0, 2000),
        date,
        unread: !res.attributes.flags?.includes('\\Seen'),
        flagged: res.attributes.flags?.includes('\\Flagged') || false,
        headers: header,
        hasIcs: /text\/calendar/i.test(res.parts?.map(p => p.attributes?.contentType).join(' ') || ''),
        attachTypes: []
      };
    });

    await connection.end();
    return { items: emails, hasMore: false, nextCursor: null };
  } catch (e) {
    if (connection) {
      try { await connection.end(); } catch {}
    }
    // Surface the exact error so your route logs remain useful
    console.error('fetchEmails error:', e?.message || e);
    throw e;
  }
}
