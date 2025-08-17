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

      // Generous but reasonable for cold starts / slow providers
      connTimeout: 20000,     // time to establish TCP
      authTimeout: 20000,     // time to authenticate
      socketTimeout: 60000,   // idle socket cutoff

      // keepalive to prevent idle disconnects mid-fetch
      keepalive: {
        interval: 3000,       // ping every 3s
        idleInterval: 300000, // max 5 min idle
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

    // Normalize criteria to what node-imap expects
    let criteria = Array.isArray(search) ? search : ['ALL'];

    // Accept forms: ['ALL'] or ['SINCE', Date] or nested arrays
    // If it's ['SINCE', '2025-08-10T...'] fix it:
    if (Array.isArray(criteria) && criteria[0] === 'SINCE') {
      const v = criteria[1];
      if (!(v instanceof Date)) {
        const d = new Date(v || Date.now());
        criteria = ['SINCE', d];
      }
    }
    // Flatten one level if someone passed [['SINCE', Date]]
    if (Array.isArray(criteria) && criteria.length === 1 && Array.isArray(criteria[0])) {
      criteria = criteria[0];
    }

    console.log('imap-simple criteria used:', criteria);

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
    throw e;
  }
}
