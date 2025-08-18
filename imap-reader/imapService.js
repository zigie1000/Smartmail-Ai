// imapService.js  — ESM module
// Works with node-imap (CJS). Keep extremely defensive around inputs.

import Imap from 'imap';
import { simpleParser } from 'mailparser';

/** Build a safe IMAP connection */
function createConnection({
  email = '',
  password = '',
  accessToken = '',
  host = 'imap.gmail.com',
  port = 993,
  tls = true,
  authType = 'password',
}) {
  const imapConfig = {
    user: email,
    host,
    port: Number(port) || 993,
    tls: !!tls,
    // SNI + CA verification; Gmail is properly signed — do NOT disable.
    tlsOptions: { servername: host, rejectUnauthorized: true },
    autotls: 'always',
  };

  if (authType === 'oauth2' && accessToken) {
    imapConfig.xoauth2 = Buffer.from(
      `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`,
      'utf-8'
    ).toString('base64');
  } else {
    imapConfig.password = password || '';
  }

  return new Imap(imapConfig);
}

/** Promisified connect/open/close helpers */
function imapConnect(imap) {
  return new Promise((resolve, reject) => {
    const cleanupError = (err) => reject(err || new Error('IMAP connect error'));
    imap.once('ready', () => resolve());
    imap.once('error', cleanupError);
    imap.connect();
  });
}

function imapOpenBox(imap, mailbox = 'INBOX') {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, true, (err, box) => (err ? reject(err) : resolve(box)));
  });
}

function imapEnd(imap) {
  return new Promise((resolve) => {
    try {
      imap.end();
      imap.once('end', resolve);
      setTimeout(resolve, 1000);
    } catch {
      resolve();
    }
  });
}

/** Ensure node-imap gets a Date *object* after SINCE */
function normalizeSearchCriteria(search, rangeDays, nowMs = Date.now()) {
  // If caller passed an explicit, already-correct array (e.g. ['ALL'])
  // keep it — but upgrade any SINCE strings to Date objects.
  if (Array.isArray(search) && search.length) {
    const up = [...search];
    for (let i = 0; i < up.length; i++) {
      if (String(up[i]).toUpperCase() === 'SINCE') {
        // Next token must be a Date object
        const nxt = up[i + 1];
        if (!(nxt instanceof Date)) {
          const asDate = new Date(nxt || 0);
          // Fallback: if invalid, use now - 7d
          up[i + 1] = Number.isFinite(asDate.getTime())
            ? asDate
            : new Date(nowMs - 7 * 864e5);
        }
      }
    }
    return up;
  }

  // Otherwise, synthesize from rangeDays
  const days = Math.max(0, Number(rangeDays) || 0);
  if (days > 0) {
    // node-imap expects a Date, not an ISO string
    return ['SINCE', new Date(nowMs - days * 864e5)];
  }
  return ['ALL'];
}

/** Pull just enough content to classify (headers + short text snippet) */
async function fetchBatch(imap, uids) {
  const items = [];
  if (!uids || !uids.length) return items;

  // Small, memory-safe fetch options
  const fetcher = imap.fetch(uids, {
    bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT[]'],
    struct: true,
  });

  const byUid = new Map();

  await new Promise((resolve, reject) => {
    fetcher.on('message', (msg, seqno) => {
      let uid = null;
      let headersRaw = '';
      let textRaw = '';
      let dateHeader = '';

      msg.on('attributes', (attrs) => {
        uid = attrs.uid;
        byUid.set(uid, byUid.get(uid) || { attrs });
      });

      msg.on('body', (stream, info) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.once('end', async () => {
          const buf = Buffer.concat(chunks);
          const which = (info.which || '').toUpperCase();

          if (which.includes('HEADER')) {
            headersRaw = buf.toString('utf8');
          } else if (which.includes('TEXT')) {
            // Avoid large memory: only keep a small snippet
            textRaw = buf.toString('utf8').slice(0, 8000);
          }
        });
      });

      msg.once('end', async () => {
        // Parse headers safely
        let from = '';
        let to = '';
        let subject = '';
        let date = '';
        let fromEmail = '';
        let fromDomain = '';

        try {
          const parsed = await simpleParser(headersRaw);
          from = (parsed.from && parsed.from.text) || '';
          to = (parsed.to && parsed.to.text) || '';
          subject = parsed.subject || '';
          date = parsed.date ? parsed.date.toISOString() : '';
          dateHeader = parsed.date || '';
          if (parsed.from && parsed.from.value && parsed.from.value[0]) {
            fromEmail = parsed.from.value[0].address || '';
            fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();
          }
        } catch {
          // noop
        }

        const snippet =
          textRaw
            .replace(/\s+/g, ' ')
            .replace(/=\r?\n/g, '') // quoted-printable leftovers
            .slice(0, 280);

        items.push({
          id: String(uid || seqno),
          uid: uid || seqno,
          from,
          fromEmail,
          fromDomain,
          to,
          subject,
          snippet,
          date: date || (dateHeader ? new Date(dateHeader).toISOString() : ''),
          unread: !!(byUid.get(uid)?.attrs?.flags && !byUid.get(uid).attrs.flags.includes('\\Seen')),
          flagged: !!(byUid.get(uid)?.attrs?.flags && byUid.get(uid).attrs.flags.includes('\\Flagged')),
          hasIcs: /text\/calendar/i.test(headersRaw),
          attachTypes: [], // keep spot for your classifier
          headers: {}, // keep spot for your classifier
          contentType: '', // keep spot for your classifier
        });
      });
    });

    fetcher.once('error', reject);
    fetcher.once('end', resolve);
  });

  // Sort descending by internal date
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return items;
}

/**
 * Public: fetchEmails
 * @param {Object} opts - { email,password,accessToken,host,port,tls,authType, search, limit, rangeDays }
 * @returns {Promise<{items: Array, nextCursor: null, hasMore: boolean}>}
 */
export async function fetchEmails(opts = {}) {
  const {
    email = '',
    password = '',
    accessToken = '',
    host = 'imap.gmail.com',
    port = 993,
    tls = true,
    authType = 'password',
    search = null,
    limit = 20,
    rangeDays = 0,
  } = opts;

  const imap = createConnection({
    email,
    password,
    accessToken,
    host,
    port,
    tls,
    authType,
  });

  try {
    await imapConnect(imap);
    await imapOpenBox(imap, 'INBOX');

    const criteria = normalizeSearchCriteria(search, rangeDays);
    // DEBUG (optional): console.log('IMAP criteria (normalized):', criteria);

    const uids = await new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
    });

    if (!uids.length) {
      await imapEnd(imap);
      return { items: [], nextCursor: null, hasMore: false };
    }

    // Latest first, cap to limit
    const capped = uids.slice(-Number(limit || 20));
    const items = await fetchBatch(imap, capped);

    await imapEnd(imap);
    return { items, nextCursor: null, hasMore: uids.length > capped.length };
  } catch (err) {
    // Bubble a concise error up to routes; they log details
    throw new Error(`IMAP fetch error: ${err?.message || String(err)}`);
  } finally {
    try { imap.state && imap.state !== 'disconnected' && imap.end(); } catch {}
  }
}

/**
 * Public: testLogin
 * Connects and opens INBOX, then disconnects.
 * Return true/false only — easy to remove later without side effects.
 */
export async function testLogin(opts = {}) {
  const {
    email = '',
    password = '',
    accessToken = '',
    host = 'imap.gmail.com',
    port = 993,
    tls = true,
    authType = 'password',
  } = opts;

  const imap = createConnection({
    email,
    password,
    accessToken,
    host,
    port,
    tls,
    authType,
  });

  try {
    await imapConnect(imap);
    await imapOpenBox(imap, 'INBOX');
    await imapEnd(imap);
    return true;
  } catch {
    try { imap.end(); } catch {}
    return false;
  }
}
