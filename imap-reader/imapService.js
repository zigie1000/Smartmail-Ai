// imapService.js
// Single "Range" control + backward paging via cursorBefore
// Works with imap-simple@^5, mailparser@^3

import Imap from 'imap-simple';
import { simpleParser } from 'mailparser';

// --------- Helpers ---------
function toDateOnly(d) {
  // IMAP 'SINCE'/'BEFORE' use *dates* (RFC3501) – time is ignored by servers
  // but imap-simple requires actual Date objects, not strings.
  const dt = new Date(d);
  // Normalize to local midnight to avoid off-by-one on some servers
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function buildImapConfig({ email, password, accessToken, host, port, tls, authType }) {
  const xoauth2 = (authType === 'xoauth2' || authType === 'oauth2') && accessToken
    ? accessToken
    : null;

  const auth = xoauth2
    ? { XOAuth2: xoauth2, user: email }
    : { user: email, pass: password };

  const base = {
    imap: {
      user: auth.user,
      password: auth.pass,
      xoauth2: auth.XOAuth2,
      host: host || 'imap.gmail.com',
      port: Number(port) || 993,
      tls: tls !== false,
      authTimeout: 15000,
      tlsOptions: {}
    }
  };

  // If your environment sometimes sees "self-signed certificate" (Render logs),
  // allow opting-in via env. By default we keep strict TLS.
  if (process.env.ALLOW_SELF_SIGNED === '1') {
    base.imap.tlsOptions.rejectUnauthorized = false;
  }

  return base;
}

async function withImapConnection(cfg, fn) {
  const connection = await Imap.connect(cfg);
  try {
    await connection.openBox('INBOX');
    return await fn(connection);
  } finally {
    try { await connection.end(); } catch {}
  }
}

function parseAddressHeader(h) {
  const v = Array.isArray(h) ? h[0] : h;
  return (typeof v === 'string') ? v : '';
}

async function hydrateMessage(raw) {
  // imap-simple gives you bodies we asked for.
  // We prefer headers+snippet from TEXT; if TEXT is large, just take first lines.
  let textSnippet = '';
  let headers = {};
  let date = null;
  let from = '';
  let subject = '';
  let to = '';

  try {
    const parsed = await simpleParser(raw);
    textSnippet = (parsed.text || parsed.html || '').toString().slice(0, 4000);
    headers = Object.fromEntries(parsed.headerLines?.map(h => [h.key, h.line]) || []);
    date = parsed.date ? new Date(parsed.date) : null;
    from = parsed.from?.text || '';
    to = parsed.to?.text || '';
    subject = parsed.subject || '';
  } catch {
    // Fallback best-effort
  }

  const fromEmail = (from.match(/<([^>]+)>/) || [])[1] || '';
  const fromDomain = fromEmail.split('@')[1]?.toLowerCase() || '';

  return {
    id: String(raw.attributes?.uid || raw.seqNo),
    uid: raw.attributes?.uid,
    from,
    fromEmail,
    fromDomain,
    to,
    subject,
    snippet: textSnippet,
    date: date ? date.toISOString() : null,
    headers,
    hasIcs: /text\/calendar/i.test(headers['content-type'] || ''),
    attachTypes: [], // mailparser could be used to enumerate; skipped for speed
    unread: raw.attributes?.flags ? !raw.attributes.flags.includes('\\Seen') : false,
    flagged: raw.attributes?.flags ? raw.attributes.flags.includes('\\Flagged') : false,
    contentType: headers['content-type'] || ''
  };
}

// --------- Public API ---------

/**
 * Fetch emails using one time control (rangeDays) and optional backward cursor.
 * @param {Object} opts
 *   - email, password, accessToken, host, port, tls, authType
 *   - rangeDays: number (e.g., 2, 7, 30, 365). If 0 or falsy, fetch ALL (no SINCE)
 *   - cursorBefore: ISO string; if present, adds BEFORE <cursorDate> (exclusive)
 *   - limit: number of messages to return (server-side capped to keep memory low)
 */
export async function fetchEmails(opts) {
  const {
    email, password, accessToken, host, port, tls, authType,
    rangeDays = 7,
    cursorBefore = null,
    limit = 20
  } = opts || {};

  const cfg = buildImapConfig({ email, password, accessToken, host, port, tls, authType });

  // ---- Build IMAP SEARCH criteria safely ----
  const criteria = [];

  // SINCE (optional)
  if (Number(rangeDays) > 0) {
    const since = toDateOnly(new Date(Date.now() - Number(rangeDays) * 864e5));
    criteria.push(['SINCE', since]); // must be Date object
  } else {
    // No time limit → ALL
    criteria.push('ALL');
  }

  // BACKWARD PAGING (optional)
  if (cursorBefore) {
    const before = toDateOnly(cursorBefore);
    criteria.push(['BEFORE', before]); // Date object
  }

  // We will fetch UIDs, then fetch bodies for the page we want.
  const pageLimit = clamp(Number(limit) || 20, 1, 200);

  // ---- Query server ----
  return await withImapConnection(cfg, async (conn) => {
    // Search returns array of match descriptors.
    // Using bodies:['HEADER','TEXT'] can be expensive; for paging we first get UIDs then fetch only page.
    const searchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: false };

    let matched;
    try {
      matched = await conn.search(criteria, searchOptions);
    } catch (e) {
      // Helpful log when server complains (e.g., if SINCE isn't Date)
      console.error('IMAP search error; criteria (server-side):', JSON.stringify(criteria, null, 2));
      throw e;
    }

    // Normalize and sort newest → oldest using INTERNALDATE from attributes or header Date
    const stamped = matched.map(m => {
      const hdr = m.parts?.find(p => p.which === 'HEADER')?.body || {};
      const rawDate = parseAddressHeader(hdr.date);
      const parsedDate = rawDate ? new Date(rawDate) : (m.attributes?.date || null);
      return { raw: m, sortTs: parsedDate ? +parsedDate : 0 };
    });

    stamped.sort((a, b) => b.sortTs - a.sortTs);

    // Page slice
    const page = stamped.slice(0, pageLimit);

    // Convert each message to our shape
    const items = [];
    for (const s of page) {
      // Rebuild raw text (imap-simple returns per-part; simpleParser accepts a joined string)
      const headerPart = s.raw.parts?.find(p => p.which === 'HEADER')?.body || {};
      const textPart = s.raw.parts?.find(p => p.which === 'TEXT')?.body || '';

      const joined = [
        'From: ' + parseAddressHeader(headerPart.from),
        'To: ' + parseAddressHeader(headerPart.to),
        'Subject: ' + parseAddressHeader(headerPart.subject),
        'Date: ' + parseAddressHeader(headerPart.date),
        '',
        typeof textPart === 'string' ? textPart : ''
      ].join('\r\n');

      const hydrated = await hydrateMessage({ ...s.raw, raw: joined });
      items.push(hydrated);
    }

    // Determine nextCursor: if there are more than pageLimit matches,
    // use the oldest message date in this page as the exclusive upper bound for the next request.
    let nextCursor = null;
    let hasMore = false;

    if (stamped.length > page.length) {
      hasMore = true;
      const oldestInPage = page[page.length - 1];
      if (oldestInPage?.sortTs) {
        const d = new Date(oldestInPage.sortTs);
        // Add a tiny epsilon so we don't repeat the same date if another msg shares it
        d.setSeconds(d.getSeconds(), d.getMilliseconds() + 1);
        nextCursor = d.toISOString();
      }
    }

    return { items, nextCursor, hasMore };
  });
}

/**
 * Non-disruptive connectivity tester.
 * Returns { ok: true } if we could auth and open INBOX.
 */
export async function testLogin({ email, password, accessToken, host, port, tls, authType }) {
  const cfg = buildImapConfig({ email, password, accessToken, host, port, tls, authType });
  try {
    await withImapConnection(cfg, async () => true);
    return true;
  } catch (e) {
    console.warn('testLogin failed:', e?.message || e);
    return false;
  }
}
