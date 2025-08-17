// imapService.js — safe wrapper around imap-simple

import imaps from 'imap-simple';
import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

/** Format Date for IMAP 'SINCE' — must be DD-MMM-YYYY (RFC 3501) */
function formatImapDate(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function buildConfig({
  email, password, accessToken,
  host, port = 993, tls = true, authType = 'password'
}) {
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

      // timeouts (ms)
      connTimeout: 20000,   // TCP connect
      authTimeout: 20000,   // login
      socketTimeout: 60000, // idle socket
    },

    // keepalive: prevent idle disconnects (imap-simple / node-imap)
    keepalive: {
      interval: 3000,       // send NOOP every 3s
      idleInterval: 300000, // max 5 min idle
      forceNoop: true,
    },
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
    try { if (connection) await connection.end(); } catch {}
    console.error('testLogin error:', e?.message || e);
    return false;
  }
}

/**
 * Fetch emails with optional SINCE window and limit
 * @param {object} params
 * @param {string} params.email
 * @param {string} [params.password]
 * @param {string} [params.accessToken]
 * @param {string} params.host
 * @param {number} [params.port=993]
 * @param {boolean} [params.tls=true]
 * @param {'password'|'xoauth2'} [params.authType='password']
 * @param {number} [params.rangeDays=7]  // 0 or falsy => ALL
 * @param {number} [params.limit=20]
 * @returns {Promise<{ items: Array, nextCursor: null, hasMore: boolean }>}
 */
export async function fetchEmails({
  email, password, accessToken,
  host, port = 993, tls = true, authType = 'password',
  rangeDays = 7,
  limit = 20,
}) {
  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // ---- Build criteria (IMPORTANT: each operand is an item; ['SINCE', date] must be one item) ----
    let criteria = [];
    if (Number(rangeDays) > 0) {
      const sinceDate = new Date(Date.now() - Number(rangeDays) * 864e5);
      const imapSince = formatImapDate(sinceDate);
      criteria = [[ 'SINCE', imapSince ]];         // ✅ Correct shape + format
    } else {
      criteria = ['ALL'];
    }

    // Debug log (helps confirm shape on Render)
    console.log('IMAP criteria (server-side):', JSON.stringify(criteria));

    // Fetch headers + text (you can tailor this to your existing mapping)
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: false,
      struct: true,
    };

    const results = await connection.search(criteria, fetchOptions);

    // Map results to a simple shape your frontend expects
    const items = results.slice(0, Math.max(1, Number(limit) || 20)).map(r => {
      const header = imaps.getParts(r.parts).find(p => p.which === 'HEADER')?.body || {};
      const textPart = imaps.getParts(r.parts).find(p => p.which === 'TEXT')?.body;

      const subject = header.subject?.[0] || '(no subject)';
      const from = header.from?.[0] || '';
      const to = header.to?.[0] || '';
      const date = header.date?.[0] ? new Date(header.date[0]).toISOString() : null;

      return {
        uid: r.attributes?.uid,
        id: r.attributes?.uid,
        subject,
        from,
        to,
        date,
        snippet: typeof textPart === 'string' ? textPart.slice(0, 500) : '',
        importance: 'unimportant',
        intent: 'other',
        urgency: 0,
        action_required: false,
      };
    });

    await connection.end();

    return { items, nextCursor: null, hasMore: false };
  } catch (e) {
    try { if (connection) await connection.end(); } catch {}
    console.error('imap fetch error:', e?.message || e);
    throw e;
  }
}
