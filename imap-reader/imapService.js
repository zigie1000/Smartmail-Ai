// server/services/imapService.js
// ESM module
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';

/**
 * Build imap-simple config from request options
 */
function buildImapConfig(opts = {}) {
  const {
    email = '',
    password = '',
    host = 'imap.gmail.com',
    port = 993,
    tls = true,
    authType = 'password', // 'password' | 'xoauth2'
    accessToken = '',
    allowSelfSigned = false, // safety valve for non-public IMAP hosts
    connectionTimeoutMs = 10000, // 10s default on free tier
    idleTimeoutMs = 8000,
  } = opts;

  const auth = authType === 'xoauth2'
    ? { user: email, xoauth2: accessToken }
    : { user: email, pass: password };

  // TLS options
  const tlsOptions = {};
  if (allowSelfSigned) {
    // Only enable if explicitly requested
    tlsOptions.rejectUnauthorized = false;
  }

  return {
    imap: {
      user: auth.user,
      password: auth.pass,
      xoauth2: auth.xoauth2,
      host,
      port,
      tls: !!tls,
      tlsOptions,
      authTimeout: connectionTimeoutMs,
      connTimeout: connectionTimeoutMs,
      keepalive: {
        interval: idleTimeoutMs,
        idleInterval: idleTimeoutMs,
        forceNoop: true,
      },
    },
    onmail: () => {},
    // imap-simple option: how many messages to fetch per batch internally
    // (smaller batches help memory on free dynos)
    fetchOptions: { bodies: ['HEADER', 'TEXT'], markSeen: false },
  };
}

/**
 * Open an IMAP box safely and return {conn, boxName}
 */
async function openBox(conn, boxName = 'INBOX') {
  await conn.openBox(boxName);
  return boxName;
}

/**
 * Convert UI "rangeDays" into an IMAP SINCE Date.
 * imap-simple requires: ['SINCE', Date]
 */
function sinceDateFromRange(rangeDays = 2) {
  const days = Number.isFinite(+rangeDays) ? +rangeDays : 2;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(0, days));
  // IMPORTANT: return a Date, not a string
  return d;
}

/**
 * Parse a single message safely
 */
async function parseMessage(msg) {
  // imap-simple returns parts in msg.parts; we find the full raw source if present
  const all = msg.parts?.find(p => p.which === 'TEXT') || msg.parts?.[0];
  const buffer = Buffer.from(all?.body ?? '', 'utf8');
  let parsed;
  try {
    parsed = await simpleParser(buffer);
  } catch {
    parsed = { subject: '', date: msg.attributes?.date || new Date(), text: '' };
  }

  const header = msg.parts?.find(p => p.which === 'HEADER')?.body || {};
  const subject =
    parsed.subject?.trim() ||
    header.subject?.[0]?.trim() ||
    '(no subject)';

  const from =
    parsed.from?.text ||
    header.from?.[0] ||
    '';

  return {
    uid: msg.attributes?.uid,
    date: msg.attributes?.date || parsed.date || new Date(),
    subject,
    from,
    preview: (parsed.text || parsed.textAsHtml || '').toString().slice(0, 400),
    headers: parsed.headers ? Object.fromEntries(parsed.headers) : header,
  };
}

/**
 * Test credentials only (no heavy fetching)
 */
export async function testLogin(opts = {}) {
  const config = buildImapConfig(opts);
  let connection;
  try {
    connection = await imaps.connect(config);
    await openBox(connection, 'INBOX');
    return { ok: true };
  } catch (err) {
    // Surface common TLS / cert messages clearly
    const msg = (err && err.message) || String(err);
    return { ok: false, error: msg };
  } finally {
    try { await connection?.end(); } catch {}
  }
}

/**
 * Fetch mail with filters and sane defaults.
 * Expected opts:
 *  - rangeDays (number)
 *  - limit (number)
 *  - mailbox (string, default "INBOX")
 *  - authType/password/accessToken, host/port/tls, etc.
 */
export async function fetchMail(opts = {}) {
  const {
    rangeDays = 2,
    limit = 20,
    mailbox = 'INBOX',
    priority = 'all', // passthrough UI fields (not used server-side)
    intent = 'all',
    action = 'all',
    time = 'all',
  } = opts;

  // Guardrails for free dynos
  const hardCap = Math.min(Math.max(+limit || 20, 1), 100);

  const config = buildImapConfig(opts);

  let connection;
  try {
    connection = await imaps.connect(config);
    await openBox(connection, mailbox);

    // Build IMAP search criteria
    const sinceDate = sinceDateFromRange(rangeDays);
    const criteria = ['ALL']; // base
    // Add SINCE only if rangeDays > 0
    if (Number.isFinite(+rangeDays) && +rangeDays > 0) {
      criteria.push(['SINCE', sinceDate]); // NOTE: Date, not string
    }

    // Log (useful when you check Render)
    console.log('IMAP criteria (server-side):', JSON.stringify(criteria));

    // Fetch minimal headers first to keep memory low
    const fetchOpts = {
      bodies: ['HEADER', 'TEXT'],
      struct: false,
      markSeen: false,
    };

    const results = await connection.search(criteria, fetchOpts);

    // Sort newest first and slice to limit
    const sorted = results
      .sort((a, b) => new Date(b.attributes?.date || 0) - new Date(a.attributes?.date || 0))
      .slice(0, hardCap);

    // Parse sequentially to avoid large parallel buffers on free tier
    const parsed = [];
    for (const msg of sorted) {
      // eslint-disable-next-line no-await-in-loop
      const item = await parseMessage(msg);
      parsed.push(item);
    }

    return {
      ok: true,
      items: parsed,
      meta: {
        count: parsed.length,
        appliedLimit: hardCap,
        criteriaLogged: true,
        ui: { priority, intent, action, time },
      },
    };
  } catch (err) {
    const msg = (err && err.message) || String(err);

    // Common helpful hint for self-signed hosts
    if (msg.includes('SELF_SIGNED_CERT') || msg.includes('self-signed certificate')) {
      return {
        ok: false,
        error:
          'TLS certificate is self-signed. If this IMAP host is internal, enable `allowSelfSigned` on the request (server will set tlsOptions.rejectUnauthorized=false).',
      };
    }

    // Timeouts are common on free instances that spin down
    if (msg.toLowerCase().includes('timeout')) {
      return {
        ok: false,
        error:
          'IMAP connection timed out. Free instances can sleep; try a shorter range or retry once the dyno is warm.',
      };
    }

    return { ok: false, error: msg };
  } finally {
    try { await connection?.end(); } catch {}
  }
}

/**
 * Back-compat export for existing routes:
 * routes can keep: import { fetchEmails, testLogin } from './imapService.js'
 */
export { fetchMail as fetchEmails };
