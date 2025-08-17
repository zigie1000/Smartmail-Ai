// imapService.js — wraps imap-simple with safer defaults (RFC-compliant SINCE + resilient timeouts)
import imaps from 'imap-simple';
import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

/**
 * Format a JS Date as RFC-3501 compatible (IMAP) date: "dd-MMM-yyyy"
 * Example: 17-Aug-2025
 */
function toImapSinceDate(d) {
  const dt = (d instanceof Date && !isNaN(d)) ? d : new Date(d);
  if (!(dt instanceof Date) || isNaN(dt)) return null;

  const day = String(dt.getDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()];
  const year = dt.getFullYear();
  return `${day}-${mon}-${year}`;
}

function buildConfig({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const xoauth2 = (authType === 'xoauth2' && accessToken) ? accessToken : undefined;

  const tlsOptions = {};
  if (ALLOW_SELF_SIGNED) tlsOptions.rejectUnauthorized = false;
  if (host) tlsOptions.servername = host;

  return {
    // These fields are passed through to node-imap via imap-simple
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,
      host,
      port,
      tls,
      tlsOptions,

      // More forgiving timeouts for cold starts / slow networks
      connTimeout: 60000,   // ms to establish TCP
      authTimeout: 30000,   // ms for login
      socketTimeout: 90000, // ms inactivity before closing

      // Keepalive to avoid idle disconnects during long searches
      keepalive: {
        interval: 3000,     // send NOOP every 3s
        idleInterval: 300000, // if idle, at most 5 min
        forceNoop: true
      }
    }
  };
}

export async function testLogin(opts) {
  const config = buildConfig(opts);
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.getBoxes();
    await connection.end();
    return true;
  } catch (e) {
    if (connection) { try { await connection.end(); } catch {} }
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

/**
 * fetchEmails
 * @param {Object} params
 * @param {string[]} [params.search=['ALL']] standard imap-simple criteria OR will be built from rangeDays
 * @param {number}   [params.limit=20]
 * @param {number}   [params.rangeDays] if provided, we add a SINCE <dd-MMM-yyyy> clause
 */
export async function fetchEmails({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password',
  search = ['ALL'], limit = 20, rangeDays
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // --- Build criteria safely ---
    let criteria;
    try {
      // Normalize provided search array (accept tuple forms)
      const base = Array.isArray(search) && search.length ? search : ['ALL'];

      // If a single SINCE tuple snuck in as ['SINCE', <date-like>], ensure 2nd element is a Date
      const normalized = base.map(c => {
        if (Array.isArray(c) && c[0] && String(c[0]).toUpperCase() === 'SINCE') {
          const v = c[1];
          const d = (v instanceof Date) ? v : new Date(v);
          return ['SINCE', d];
        }
        return c;
      });

      // If rangeDays is provided, append our RFC-compliant SINCE
      if (Number.isFinite(+rangeDays) && +rangeDays > 0) {
        const sinceJsDate = new Date(Date.now() - (+rangeDays) * 864e5);
        const sinceStr = toImapSinceDate(sinceJsDate);
        if (sinceStr) normalized.push(['SINCE', sinceStr]);
      }

      // Finally, coerce any SINCE Date to RFC string
      criteria = normalized.map(c => {
        if (Array.isArray(c) && c[0] && String(c[0]).toUpperCase() === 'SINCE') {
          const v = c[1];
          // Accept already-formatted strings; otherwise convert Date to "dd-MMM-yyyy"
          if (typeof v === 'string') return ['SINCE', v];
          const s = toImapSinceDate(v);
          return s ? ['SINCE', s] : null;
        }
        return c;
      }).filter(Boolean);

      if (!Array.isArray(criteria) || !criteria.length) criteria = ['ALL'];
    } catch {
      criteria = ['ALL'];
    }

    // Log criteria for diagnostics (you saw this in Render logs)
    try { console.log('IMAP criteria (server-side):', JSON.stringify(criteria)); } catch {}

    const fetchOpts = { bodies: ['HEADER', 'TEXT'], markSeen: false };
    const results = await connection.search(criteria, fetchOpts);

    const emails = results
      .slice(-Math.max(1, Number(limit) || 20))
      .map((res, idx) => {
        const header = res.parts.find(p => p.which === 'HEADER')?.body || {};
        const text = res.parts.find(p => p.which === 'TEXT')?.body || '';

        const fromHdr = (header.from && header.from[0]) || '';
        const subject = (header.subject && header.subject[0]) || '';
        const date = (header.date && header.date[0]) || '';

        const fromEmail = /<([^>]+)>/.exec(fromHdr)?.[1] || fromHdr;
        const fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();

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
    if (connection) { try { await connection.end(); } catch {} }
    throw e;
  }
}
