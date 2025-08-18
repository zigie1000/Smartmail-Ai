// imapService.js — node-imap helper used by imapRoutes.js
// Guarantees: accepts search arrays from the route; fixes SINCE date arg;
// lightweight fetch to avoid OOM; optional self-signed CA handling.

import Imap from 'imap';
import { inspect } from 'util';
import { Buffer } from 'node:buffer';

const DEFAULT_HOST = 'imap.gmail.com';
const DEFAULT_PORT = 993;

/** Convert a variety of inputs to a real Date, or null if invalid */
function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  if (typeof v === 'string') {
    // Allow ISO strings coming from JSON serialization
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  return null;
}

/** Normalize node-imap style search criteria */
function normalizeCriteria(search) {
  // Expected from route: ['ALL']  OR  ['SINCE', Date]
  if (!Array.isArray(search) || search.length === 0) return ['ALL'];

  // If something like ["SINCE", "2025-08-11T...Z"] slipped in, fix it:
  const key = String(search[0] || '').toUpperCase();
  if ((key === 'SINCE' || key === 'BEFORE' || key === 'ON') && search.length >= 2) {
    const fixed = toDate(search[1]);
    if (fixed) return [key, fixed];
    // If date is bad, fall back to ALL to avoid throwing
    return ['ALL'];
  }

  // If already valid, return as-is.
  return search;
}

/** Create an IMAP connection (node-imap) */
function createImap({ email, password, host, port, tls, authType }) {
  const allowSelfSigned = process.env.ALLOW_SELF_SIGNED === '1';
  const useSystemCA = process.env.USE_SYSTEM_CA === '1';

  const imap = new Imap({
    user: email,
    password: authType === 'password' ? password : password, // placeholder for XOAUTH2 if added later
    xoauth2: authType === 'xoauth2' ? password : undefined,
    host: host || DEFAULT_HOST,
    port: Number(port || DEFAULT_PORT),
    tls: tls !== false,
    tlsOptions: {
      // If you really must, you can allow self-signed by env.
      rejectUnauthorized: allowSelfSigned ? false : true
    },
    autotls: 'always', // be strict with TLS negotiation
    keepalive: {
      idleInterval: 30000,
      forceNoop: true
    }
  });

  // Optional: let node use system CAs if container has them
  if (useSystemCA) {
    // no explicit change required if the environment has proper CA bundle;
    // kept for clarity/documentation
  }

  return imap;
}

/** Promisified open/close helpers */
function openInbox(imap, box = 'INBOX') {
  return new Promise((resolve, reject) => {
    imap.openBox(box, true, (err, boxInfo) => (err ? reject(err) : resolve(boxInfo)));
  });
}
function endImap(imap) {
  return new Promise((resolve) => {
    try {
      imap.end();
    } catch {}
    imap.once('end', () => resolve());
  });
}
function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
  });
}

/** Fetch a safe subset of data for a list of message IDs (seqnos) */
function fetchLight(imap, seqnos) {
  return new Promise((resolve, reject) => {
    if (!seqnos || seqnos.length === 0) return resolve([]);

    const items = [];
    // Grab headers + a tiny chunk of text for snippet. Use PEEK to avoid setting \Seen.
    const fetcher = imap.fetch(seqnos, {
      bodies: [
        'HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID CONTENT-TYPE)',
        'TEXT[]<0.1024>' // first 1KB only for snippet
      ],
      struct: true
    });

    fetcher.on('message', (msg, seqno) => {
      const entry = { uid: seqno, headers: {}, text: '' };

      msg.on('body', (stream, info) => {
        const isHeader = typeof info.which === 'string' && info.which.startsWith('HEADER.FIELDS');
        const isSnippet = typeof info.which === 'string' && info.which.startsWith('TEXT');

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.once('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');

          if (isHeader) {
            // crude header parse (node-imap doesn’t parse for us here)
            const lines = raw.split(/\r?\n/);
            lines.forEach((line) => {
              const m = line.match(/^([A-Za-z\-]+):\s*(.*)$/);
              if (m) {
                entry.headers[m[1].toLowerCase()] = m[2];
              }
            });
          } else if (isSnippet) {
            entry.text = raw.replace(/\s+/g, ' ').trim().slice(0, 1000);
          }
        });
      });

      msg.once('attributes', (attrs) => {
        entry.attrs = attrs || {};
      });

      msg.once('end', () => {
        // Build friendly fields
        const h = entry.headers || {};
        const from = h['from'] || '';
        const to = h['to'] || '';
        const subject = h['subject'] || '';
        const date = h['date'] || '';
        const contentType = h['content-type'] || '';

        // Attempt to extract the email/domain from "From"
        let fromEmail = '';
        let fromDomain = '';
        const m = from.match(/<([^>]+)>/);
        if (m) fromEmail = m[1].toLowerCase();
        else if (from.includes('@')) fromEmail = from.toLowerCase().replace(/^.*\s|\s.*$/g, '');
        if (fromEmail.includes('@')) fromDomain = fromEmail.split('@').pop();

        items.push({
          id: String(entry.uid),
          uid: entry.uid,
          from,
          fromEmail,
          fromDomain,
          to,
          subject,
          date,
          snippet: entry.text || '',
          unread: !(entry.attrs?.flags || []).includes('\\Seen'),
          flagged: (entry.attrs?.flags || []).includes('\\Flagged'),
          hasIcs: /text\/calendar/i.test(contentType),
          attachTypes: [], // can be filled by walking struct if needed later
          contentType
        });
      });
    });

    fetcher.once('error', (err) => reject(err));
    fetcher.once('end', () => resolve(items));
  });
}

/** Public: fetch emails */
export async function fetchEmails({
  email = '',
  password = '',
  accessToken = '', // not used yet; reserved for XOAUTH2
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  tls = true,
  authType = 'password',
  search = ['ALL'],
  limit = 20
}) {
  const imap = createImap({
    email,
    password: authType === 'xoauth2' ? accessToken : password,
    host,
    port,
    tls,
    authType
  });

  // Important: make sure criteria are valid for node-imap
  const criteria = normalizeCriteria(search);

  const items = [];
  let hadError = null;

  await new Promise((resolve) => {
    imap.once('ready', resolve);
    imap.once('error', (err) => {
      hadError = err;
      resolve();
    });
    imap.connect();
  });
  if (hadError) {
    try { imap.destroy(); } catch {}
    throw hadError;
  }

  try {
    await openInbox(imap, 'INBOX');

    const results = await imapSearch(imap, criteria); // seq numbers
    // results can be huge; keep only the newest N
    const chosen = results.slice(-Math.max(0, Number(limit) || 0));

    const fetched = await fetchLight(imap, chosen);
    items.push(...fetched);
  } finally {
    await endImap(imap);
  }

  // Simple cursor stubs for now
  return { items, nextCursor: null, hasMore: false };
}

/** Public: isolated test login (safe to delete later) */
export async function testLogin({
  email = '',
  password = '',
  accessToken = '',
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  tls = true,
  authType = 'password'
}) {
  const imap = createImap({
    email,
    password: authType === 'xoauth2' ? accessToken : password,
    host,
    port,
    tls,
    authType
  });

  return new Promise((resolve) => {
    let resolved = false;

    imap.once('ready', async () => {
      try {
        await openInbox(imap, 'INBOX');
        resolved = true;
        resolve(true);
      } catch {
        resolve(false);
      } finally {
        await endImap(imap);
      }
    });

    imap.once('error', () => {
      if (!resolved) resolve(false);
    });

    imap.connect();
  });
}
