// imapService.js — wraps imap-simple with safer defaults
import imaps from 'imap-simple';
import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

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

      // timeouts and keepalive to reduce flakiness on cold free instances
      connTimeout: 20000,     // 20s to establish TCP
      authTimeout: 20000,     // 20s for login
      socketTimeout: 60000,   // 60s inactivity before giving up
      keepalive: {
        interval: 3000,       // every 3s send NOOP while idling
        idleInterval: 300000, // 5 min max idle before NOOPs
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
    if (connection) try { await connection.end(); } catch {}
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

export async function fetchEmails({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password',
  search = ['ALL'], limit = 20
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Expect: array of criteria, each a string or ['SINCE', Date]
    let criteria = Array.isArray(search) ? search : ['ALL'];

    // Coerce SINCE tuples: the second element must be a real Date
    criteria = criteria.map(c => {
      if (Array.isArray(c) && String(c[0]).toUpperCase() === 'SINCE') {
        const v = c[1];
        const d = (v instanceof Date) ? v : new Date(v);
        return ['SINCE', d];
      }
      return c;
    });

    console.log('imap-simple criteria used:', JSON.stringify(criteria));

    const fetchOpts = { bodies: ['HEADER', 'TEXT'], markSeen: false };
    const results = await connection.search(criteria, fetchOpts);

    const emails = results.slice(-Math.max(1, Number(limit) || 20)).map((res, idx) => {
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
    // Bubble the exact message so the route can show it
    throw e;
  }
}
