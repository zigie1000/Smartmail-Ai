// server/imapService.js
// ESM module

import Imap from 'imap';
import imaps from 'imap-simple';

/**
 * Build IMAP connection config from UI payload.
 * Supports "password" or "xoauth2" (accessToken) auth.
 */
function buildImapConfig(payload) {
  const {
    email,
    password,
    host,
    port = 993,
    tls = 'on',
    authType = 'password',
    accessToken,
  } = payload;

  const user = String(email || '').trim();

  const imap = {
    user,
    host: host || 'imap.gmail.com',
    port: Number(port) || 993,
    tls: tls !== 'off',
    authTimeout: 8000,
    keepalive: {
      interval: 10000,
      idleInterval: 30000,
      forceNoop: true,
    },
    // Do NOT relax TLS here unless you intentionally need to.
    // tlsOptions: { rejectUnauthorized: false },
  };

  if (authType === 'xoauth2' && accessToken) {
    imap.xoauth2 = accessToken;
  } else {
    imap.password = password || '';
  }

  return { imap };
}

/**
 * Build search criteria.
 * IMPORTANT: IMAP expects Date objects, NOT strings.
 */
function buildSearchCriteria({ rangeDays }) {
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Correct shape: [['SINCE', Date]]
    return [['SINCE', since]];
  }
  // Fallback to ALL when range is "All"/0/undefined
  return ['ALL'];
}

/**
 * Normalize a message summary for the UI.
 */
function mapMessage(msg) {
  const header = msg.parts?.find(p => p.which === 'HEADER')?.body || {};
  const subject = (header.subject && header.subject[0]) || '(no subject)';
  const from = (header.from && header.from[0]) || '';
  const date = (header.date && header.date[0]) || null;

  return {
    id: msg.attributes?.uid,
    subject,
    from,
    date,
    flags: msg.attributes?.flags || [],
    // keep body light to avoid OOM on free instance
    snippet: '',
  };
}

/**
 * Fetch emails with lightweight headers only.
 * payload: { email, password, host, port, tls, authType, accessToken, rangeDays, limit }
 */
export async function fetchEmails(payload) {
  const config = buildImapConfig(payload);
  const searchCriteria = buildSearchCriteria(payload);

  const fetchOptions = {
    bodies: ['HEADER'],      // headers only; avoids large downloads
    markSeen: false,
    struct: false,
  };

  // Guard: imap-simple needs a real Date in criteria when using SINCE.
  // (Do NOT pass toISOString() here.)
  const hasSince =
    Array.isArray(searchCriteria) &&
    searchCriteria.length &&
    Array.isArray(searchCriteria[0]) &&
    searchCriteria[0][0] === 'SINCE' &&
    searchCriteria[0][1] instanceof Date;

  // Connect
  const connection = await imaps.connect(config);

  try {
    // Open INBOX
    await connection.openBox('INBOX');

    // Run search
    const messages = await connection.search(searchCriteria, fetchOptions);

    // Optional limiting (client-side) to stay within UI limit
    const limit = Math.max(0, Number(payload.limit || 50));
    const trimmed = limit ? messages.slice(0, limit) : messages;

    const rows = trimmed.map(mapMessage);
    return { ok: true, rows, count: rows.length, sinceApplied: hasSince };
  } finally {
    // Always clean up
    try { await connection.end(); } catch {}
  }
}

/**
 * Lightweight auth check for the “Test Login” button.
 */
export async function testLogin(payload) {
  const config = buildImapConfig(payload);
  const connection = await imaps.connect(config);
  try {
    await connection.openBox('INBOX');
    return { ok: true };
  } finally {
    try { await connection.end(); } catch {}
  }
}
