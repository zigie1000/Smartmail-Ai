// imapService.js — wraps imap-simple with safer defaults
import imaps from 'imap-simple';
import dns from 'dns';

// Prefer IPv4 first to avoid weird IPv6 resolution issues on some hosts
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

// Build imap-simple config
function buildConfig({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const xoauth2 = (authType === 'xoauth2' && accessToken) ? accessToken : undefined;

  const tlsOptions = {};
  // allow self-signed (only if you *really* need this)
  if (ALLOW_SELF_SIGNED) tlsOptions.rejectUnauthorized = false;
  // SNI server name if provided
  if (host) tlsOptions.servername = host;

  // Slightly longer timeout for slower providers (iCloud etc.)
  const authTimeout = (/mail\.me\.com$/i.test(host) || /icloud/i.test(host)) ? 20000 : 12000;

  return {
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,
      host,
      port,
      tls,
      tlsOptions,
      authTimeout
    }
  };
}

// Optional convenience endpoint for the UI "Test Login" button.
// Safe to delete later along with the route that calls it.
export async function testLogin(opts = {}) {
  const config = buildConfig(opts);
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.getBoxes();   // light call that requires successful auth
    await connection.end();
    return true;
  } catch (e) {
    if (connection) { try { await connection.end(); } catch {} }
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

// Main fetcher used by /api/imap/fetch
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
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // IMPORTANT: For node-imap/imap-simple, criteria must be like:
    //   ['ALL']  OR  ['SINCE', DateObj]
    // If a string is passed to SINCE, node-imap throws "Incorrect number of arguments".
    const criteria = Array.isArray(search) ? search : ['ALL'];

    // Basic fetch options; don't mark seen
    const fetchOpts = { bodies: ['HEADER', 'TEXT'], markSeen: false };

    const results = await connection.search(criteria, fetchOpts);

    const emails = results
      .slice(-Math.max(1, Number(limit) || 20)) // take the last N (most recent) results
      .map((res, idx) => {
        const header = res.parts.find(p => p.which === 'HEADER')?.body || {};
        const text = res.parts.find(p => p.which === 'TEXT')?.body || '';

        const fromHdr  = (header.from && header.from[0]) || '';
        const subject  = (header.subject && header.subject[0]) || '';
        const date     = (header.date && header.date[0]) || '';

        const fromEmail = /<([^>]+)>/.exec(fromHdr)?.[1] || fromHdr;
        const fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();

        // Try to detect calendar content across returned parts
        const contentTypes = (res.parts || [])
          .map(p => p?.attributes?.contentType || '')
          .join(' ');
        const hasIcs = /text\/calendar/i.test(contentTypes);

        return {
          id: res.attributes?.uid || String(idx + 1),
          uid: res.attributes?.uid,
          from: fromHdr,
          fromEmail,
          fromDomain,
          to: ((header.to && header.to[0]) || ''),
          subject,
          snippet: String(text).slice(0, 500),
          text: String(text).slice(0, 2000),
          date,
          unread: !(res.attributes?.flags || []).includes('\\Seen'),
          flagged: (res.attributes?.flags || []).includes('\\Flagged') || false,
          headers: header,
          hasIcs,
          attachTypes: []
        };
      });

    await connection.end();
    return { items: emails, hasMore: false, nextCursor: null };
  } catch (e) {
    if (connection) { try { await connection.end(); } catch {} }
    // Bubble up to routes; routes will shape the error response
    throw e;
  }
}
