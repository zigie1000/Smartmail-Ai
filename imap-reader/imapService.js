// imapService.js — wraps imap-simple with safer defaults
import imaps from 'imap-simple';
import dns from 'dns';
import util from 'node:util';
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

// ---- Helpers ----
function coerceImapSinceDate(v) {
  try {
    if (v instanceof Date && !isNaN(v)) return v;
    if (typeof v === 'number') {
      const d = new Date(v);
      if (!isNaN(d)) return d;
    }
    if (typeof v === 'string') {
      // ISO or other JS-date-parsable strings
      const d = new Date(v);
      if (!isNaN(d)) return d;

      // Try DD-MMM-YYYY (acceptable to node-imap if it were a string),
      // but we ALWAYS convert to a Date for safety:
      const m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
      if (m) {
        const d2 = new Date(`${m[2]} ${m[1]} ${m[3]} 00:00:00`);
        if (!isNaN(d2)) return d2;
      }
    }
  } catch {}
  return null;
}

function buildConfig({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const xoauth2 = (authType === 'xoauth2' && accessToken) ? accessToken : undefined;

  const tlsOptions = {};
  if (ALLOW_SELF_SIGNED) tlsOptions.rejectUnauthorized = false;
  if (host) tlsOptions.servername = host;

  return {
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,
      host,
      port,
      tls,
      tlsOptions,

      // connection robustness
      connTimeout: 20000,     // TCP connect
      authTimeout: 20000,     // login
      socketTimeout: 60000,   // idle I/O

      keepalive: {
        interval: 3000,       // NOOP every 3s
        idleInterval: 300000, // 5 min
        forceNoop: true
      }
    }
  };
}

// Normalize whatever came from the route into a safe IMAP criteria
function buildCriteria(search, rangeDaysFallback = 7) {
  // Allow caller to pass nothing; use fallback range
  if (!search) {
    const days = Math.max(0, Number(rangeDaysFallback) || 0);
    return days > 0 ? ['SINCE', new Date(Date.now() - days * 864e5)] : ['ALL'];
  }

  // Allow ['SINCE', <any>] or nested arrays like [ ['SINCE', <any>], ... ]
  if (Array.isArray(search)) {
    // Case: ['SINCE', v]
    if (search.length === 2 && String(search[0]).toUpperCase() === 'SINCE') {
      const d = coerceImapSinceDate(search[1]);
      return d ? ['SINCE', d] : ['ALL'];
    }

    // Case: array of criteria
    return search.map(c => {
      if (Array.isArray(c) && String(c[0]).toUpperCase() === 'SINCE') {
        const d = coerceImapSinceDate(c[1]);
        return d ? ['SINCE', d] : ['ALL'];
      }
      return c;
    });
  }

  // Anything else → safe default
  return ['ALL'];
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
    if (connection) try { await connection.end(); } catch {}
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

export async function fetchEmails({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password',
  search = ['ALL'], limit = 20, rangeDays // optional; used only if search is absent
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Build safe criteria (force SINCE second arg to a Date)
    const criteria = buildCriteria(search, rangeDays);

    // Log without mutating dates
    try {
      console.log('IMAP criteria (server-side):', util.inspect(criteria, { depth: 5 }));
    } catch {}

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
    if (connection) try { await connection.end(); } catch {}
    throw e;
  }
}
