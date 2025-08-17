// imapService.js — wraps imap-simple with safer defaults
import imaps from 'imap-simple';
import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

/** Build node-imap config with robust timeouts & keepalive. */
function buildConfig({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password'
}) {
  const xoauth2 = (authType === 'xoauth2' && accessToken) ? accessToken : undefined;

  const tlsOptions = {};
  if (ALLOW_SELF_SIGNED) tlsOptions.rejectUnauthorized = false;
  if (host) tlsOptions.servername = host;

  return {
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,             // for XOAUTH2, pass the raw access token string
      host,
      port,
      tls,
      tlsOptions,

      // ---- timeouts / keepalive (helps with free hosts that idle/sleep) ----
      connTimeout: 20_000,     // TCP connect
      authTimeout: 20_000,     // login
      socketTimeout: 60_000,   // inactivity
      keepalive: {
        interval: 3_000,       // send NOOP every 3s while idle
        idleInterval: 300_000, // if idle, NOOP at most every 5m
        forceNoop: true,
      },
    }
  };
}

/** Coerce any incoming “search” into node-imap friendly criteria. */
function coerceCriteria(input) {
  // Allow: 'ALL' | ['ALL', ['SINCE', Date]] | [['SINCE', <dateish>]] | ['SINCE', <dateish>]
  const asArray = Array.isArray(input) ? input : ['ALL'];

  // If it's a single tuple like ['SINCE', something], wrap into outer list.
  const list = (Array.isArray(asArray[0]) || typeof asArray[0] !== 'string')
    ? asArray
    : (asArray[0].toUpperCase() === 'SINCE' ? [asArray] : asArray);

  const fixDate = (v) => {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string') return new Date(v);        // ISO or “Mon, 17 Aug …” both OK
    return new Date(); // fallback: now
  };

  return list.map(c => {
    if (Array.isArray(c) && String(c[0]).toUpperCase() === 'SINCE') {
      return ['SINCE', fixDate(c[1])];
    }
    return c;
  });
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

/**
 * Fetch emails.
 * @param {Object} opts
 * @param {Array}  opts.search - criteria. Can be ['ALL'] or [['SINCE', <dateish>]] or ['SINCE', <dateish>]
 */
export async function fetchEmails({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password',
  search = ['ALL'], limit = 20
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // 💡 Convert any serialized Date coming from JSON back to an actual Date
    const criteria = coerceCriteria(search);
    // Optional debug:
    console.log('IMAP criteria (server-side):', criteria.map(c => Array.isArray(c) && c[1] instanceof Date
      ? [c[0], c[1].toISOString()] : c));

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
          hasIcs: /text\/calendar/i.test(
            res.parts?.map(p => p.attributes?.contentType).join(' ') || ''
          ),
          attachTypes: []
        };
      });

    await connection.end();
    return { items: emails, hasMore: false, nextCursor: null };
  } catch (e) {
    if (connection) try { await connection.end(); } catch {}
    // Surface clearer messages to the caller
    throw new Error(e?.message || 'IMAP search/fetch failed');
  }
}
