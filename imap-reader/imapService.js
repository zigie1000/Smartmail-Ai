// server/services/imapService.js
// Full file — no omissions

import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';

/**
 * Build a robust imap-simple config from user payload
 */
function buildImapConfig(payload) {
  const {
    email,
    password,
    accessToken,
    host,
    port = 993,
    tls = true,
    allowSelfSigned = false,
  } = payload;

  // Prefer XOAUTH2 if provided
  const auth = accessToken
    ? { xoauth2: accessToken }
    : { user: email, password };

  return {
    imap: {
      user: auth.user,
      password: auth.password,
      xoauth2: auth.xoauth2,
      host: host || 'imap.gmail.com',
      port: Number(port) || 993,
      tls: tls !== false,
      tlsOptions: allowSelfSigned
        ? { rejectUnauthorized: false }
        : { servername: host || 'imap.gmail.com' },
      keepalive: {
        interval: 30000,
        idleInterval: 30000,
        forceNoop: true
      }
    }
  };
}

/**
 * Convert a range (days) into an IMAP Date (must be a Date object)
 * Node-imap accepts Date objects directly; avoid strings to prevent the
 * “Incorrect number of arguments for search option: SINCE” error.
 */
function makeSinceDate(rangeDays) {
  if (!rangeDays || Number(rangeDays) <= 0) return null;
  const days = Number(rangeDays);
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d; // Date object (✅)
}

/**
 * Fetch emails (headers only) with safe limits/chunking
 * @param {{
 *  email: string,
 *  password?: string,
 *  accessToken?: string,
 *  host?: string,
 *  port?: number,
 *  tls?: boolean,
 *  allowSelfSigned?: boolean,
 *  limit?: number,
 *  rangeDays?: number
 * }} payload
 */
export async function fetchEmails(payload) {
  const limit = Math.min(Math.max(Number(payload.limit) || 20, 1), 100);
  const sinceDate = makeSinceDate(payload.rangeDays);

  const searchCriteria = ['ALL'];
  if (sinceDate) searchCriteria.push(['SINCE', sinceDate]); // Date object (✅)

  const fetchOptions = {
    // fetch headers only to avoid OOM/timeouts
    bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
    struct: true,
    markSeen: false
  };

  let connection;
  try {
    const config = buildImapConfig(payload);
    connection = await imaps.connect(config);

    // Select INBOX (readonly to be safe)
    await connection.openBox('INBOX', true);

    const uids = await connection.search(searchCriteria, { bodies: [], markSeen: false })
      .then(results => results.map(r => r.attributes.uid));

    if (!uids || uids.length === 0) {
      return { emails: [], count: 0 };
    }

    // newest first
    uids.sort((a, b) => b - a);

    // Soft-chunk to keep memory low
    const chunkSize = 25;
    const wanted = uids.slice(0, limit);
    const chunks = [];
    for (let i = 0; i < wanted.length; i += chunkSize) {
      chunks.push(wanted.slice(i, i + chunkSize));
    }

    const emails = [];
    for (const chunk of chunks) {
      const results = await connection.fetch(chunk, fetchOptions);
      for (const res of results) {
        const header = res.parts?.find(p => p.which?.startsWith('HEADER'))?.body || {};
        // header fields come as arrays
        const subject = (header.subject && header.subject[0]) || '(no subject)';
        const from = (header.from && header.from[0]) || '';
        const to = (header.to && header.to[0]) || '';
        const date = (header.date && header.date[0]) || '';
        emails.push({
          uid: res.attributes?.uid,
          subject,
          from,
          to,
          date,
          priority: 'unclassified',
          intent: 'other',
          action: 'other',
          smartView: null
        });
      }
    }

    return { emails, count: emails.length };
  } catch (err) {
    // Map common TLS and search errors to clearer messages
    const code = err?.code || err?.source || '';
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
      throw Object.assign(new Error(
        'IMAP TLS failed: self-signed certificate. Enable "Allow self-signed TLS" for this host if you trust it.'
      ), { status: 502 });
    }
    if (/Incorrect number of arguments.*SINCE/i.test(err?.message || '')) {
      throw Object.assign(new Error(
        'IMAP search failed: server rejected SINCE. (We now send a Date object; if this persists, the server may not support SINCE.)'
      ), { status: 502 });
    }
    throw err;
  } finally {
    try { await connection?.end(); } catch { /* ignore */ }
  }
}

/**
 * Lightweight login test that only opens the mailbox.
 */
export async function testLogin(payload) {
  let connection;
  try {
    const config = buildImapConfig(payload);
    connection = await imaps.connect(config);
    await connection.openBox('INBOX', true);
    return { ok: true };
  } finally {
    try { await connection?.end(); } catch { /* ignore */ }
  }
}
