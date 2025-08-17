// imapService.js — wraps imap-simple with safer defaults

import imaps from 'imap-simple';
import dns from 'dns';

// Prefer IPv4 first in some hosting environments
dns.setDefaultResultOrder?.('ipv4first');

/**
 * SECURITY NOTE
 * -------------
 * We default to `rejectUnauthorized: false` because some hosts (e.g. Render Free)
 * lack system CAs and will throw DEPTH_ZERO_SELF_SIGNED_CERT. If you later install
 * system CAs, set IMAP_REJECT_UNAUTHORIZED=1 in the environment to harden TLS.
 */
const REJECT_UNAUTHORIZED =
  process.env.IMAP_REJECT_UNAUTHORIZED === '1' ? true : false;

/** Format a JS Date to RFC-822 (dd-MMM-yyyy), e.g. 17-Aug-2025 */
function toRfc822Date(d) {
  const months = [
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ];
  const day = String(d.getDate());
  const mon = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${mon}-${year}`;
}

/** Build node-imap / imap-simple connection config */
function buildConfig({
  email,
  password,
  accessToken,
  host,
  port = 993,
  tls = true,
  authType = 'password',
}) {
  const xoauth2 = authType === 'xoauth2' && accessToken ? accessToken : undefined;

  const tlsOptions = {
    // If your host has proper CAs installed, set IMAP_REJECT_UNAUTHORIZED=1
    // to enable strict verification in production.
    rejectUnauthorized: REJECT_UNAUTHORIZED ? true : false,
  };

  // SNI: ensures TLS handshake uses the intended hostname
  if (host) tlsOptions.servername = host;

  return {
    imap: {
      user: email,
      password: authType === 'password' ? password : undefined,
      xoauth2,              // used only when provided
      host,
      port,
      tls,
      tlsOptions,

      // ---- Timeouts (ms) ----
      // node-imap options that imap-simple passes through
      connTimeout: 20000,   // TCP connect
      authTimeout: 20000,   // login
      socketTimeout: 60000, // inactivity

      // ---- Keepalive to avoid idle disconnects ----
      keepalive: {
        interval: 3000,     // send NOOP every 3s
        idleInterval: 300000, // max idle 5 min
        forceNoop: true,
      },
    },
  };
}

/** Quick connectivity check */
export async function testLogin(opts) {
  const config = buildConfig(opts);
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.getBoxes();      // simple call to verify auth
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
 * Fetch emails from INBOX
 * opts:
 *  - email, password | accessToken, host, port, tls, authType ('password'|'xoauth2')
 *  - rangeDays (number) — how many days back; if falsy, fetches ALL
 *  - limit (number) — cap returned results
 */
export async function fetchEmails({
  email,
  password,
  accessToken,
  host = 'imap.gmail.com',
  port = 993,
  tls = true,
  authType = 'password',
  rangeDays,        // undefined|'All' => ALL
  limit = 20,
}) {
  const config = buildConfig({
    email,
    password,
    accessToken,
    host,
    port,
    tls,
    authType,
  });

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // --- Build criteria ---
    // Always start with ALL; append SINCE in RFC-822 if a range is requested.
    const criteria = ['ALL'];
    if (rangeDays && Number(rangeDays) > 0) {
      const since = new Date();
      since.setDate(since.getDate() - Number(rangeDays));
      criteria.push(['SINCE', toRfc822Date(since)]);
    }

    // Minimal fetch — headers only; bodies can be fetched later if needed
    const fetchOptions = {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)'],
      struct: true,
      markSeen: false,
    };

    const results = await connection.search(criteria, fetchOptions);

    // Parse results safely
    const emails = results
      .slice(0, Math.max(0, Number(limit) || 0))
      .map((res) => {
        const headerPart = res.parts?.find(
          (p) => p.which && p.which.startsWith('HEADER.FIELDS')
        );
        const h = headerPart?.body || {};
        const subject =
          (Array.isArray(h.subject) && h.subject[0]) || '(no subject)';
        const from = (Array.isArray(h.from) && h.from[0]) || '';
        const to = (Array.isArray(h.to) && h.to[0]) || '';
        const date = (Array.isArray(h.date) && h.date[0]) || null;
        const messageId =
          (Array.isArray(h['message-id']) && h['message-id'][0]) || null;

        return {
          uid: res.attributes?.uid,
          subject,
          from,
          to,
          date,
          messageId,
        };
      });

    await connection.end();
    return { ok: true, emails, criteriaUsed: criteria };
  } catch (e) {
    if (connection) {
      try { await connection.end(); } catch {}
    }
    console.error('IMAP /fetch error:', e?.stack || e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

export default {
  buildConfig,
  testLogin,
  fetchEmails,
};
