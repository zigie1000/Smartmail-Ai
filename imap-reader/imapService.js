// imapService.js
// Minimal IMAP helpers used by imapRoutes.js
// - fetchEmails(opts)  -> { items, nextCursor, hasMore }
// - testLogin(opts)    -> boolean (safe to delete later)
//
// Uses node-imap directly (no imap-simple) and GUARANTEES that
// the search criteria passed to imap.search() are RFC-correct.

import Imap from 'imap';
import { StringDecoder } from 'string_decoder';

// ----------------------------------------------
// TLS helper (optional self-signed bypass)
// ----------------------------------------------
function tlsOptionsFor(host) {
  // Keep the bypass behind an env flag so it’s easy to remove later.
  if (process.env.ALLOW_SELF_SIGNED === '1') {
    return { rejectUnauthorized: false };
  }
  // For Gmail/Outlook/etc this is plenty.
  return { servername: host };
}

// ----------------------------------------------
// CRITICAL: normalize search criteria
// Ensures we pass a real Date object after 'SINCE'
// ----------------------------------------------
function normalizeSearchCriteria(raw) {
  if (!raw) return ['ALL'];

  if (Array.isArray(raw)) {
    // ['SINCE', Date]
    if (raw[0] === 'SINCE' && raw[1] instanceof Date) return raw;

    // ['SINCE', '2025-...'] -> convert to Date
    if (raw[0] === 'SINCE' && typeof raw[1] === 'string') {
      const d = new Date(raw[1]);
      return ['SINCE', isNaN(d) ? new Date(Date.now() - 7 * 864e5) : d];
    }

    // ['SINCE', [<v>]] -> flatten + convert
    if (raw[0] === 'SINCE' && Array.isArray(raw[1])) {
      const v = raw[1][0];
      const d = v instanceof Date ? v : new Date(v);
      return ['SINCE', isNaN(d) ? new Date(Date.now() - 7 * 864e5) : d];
    }

    // already like ['ALL'] / other flags
    return raw;
  }

  return ['ALL'];
}

// ----------------------------------------------
// IMAP connection (Promise-wrapped)
// ----------------------------------------------
function connectIMAP({
  email,
  password,
  accessToken,
  host = 'imap.gmail.com',
  port = 993,
  tls = true,
  authType = 'password',
}) {
  const imap = new Imap({
    user: email,
    password: authType === 'password' ? password : undefined,
    xoauth2: authType === 'xoauth2' ? accessToken : undefined,
    host,
    port,
    tls,
    tlsOptions: tls ? tlsOptionsFor(host) : undefined,
    autotls: tls ? 'always' : 'never',
  });

  return new Promise((resolve, reject) => {
    const onReady = () => resolve(imap);
    const onError = (err) => reject(err);
    imap.once('ready', onReady);
    imap.once('error', onError);
    imap.connect();
  });
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', true, (err, box) => (err ? reject(err) : resolve(box)));
  });
}

function endSafe(imap) {
  try { imap.end(); } catch (_) {}
}

// ----------------------------------------------
// Small helpers
// ----------------------------------------------
const decoder = new StringDecoder('utf8');

function headerValue(hdr, key) {
  const v = (hdr && hdr[key]) ? hdr[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function extractSnippet(buffers, max = 8000) {
  const buf = Buffer.concat(buffers).slice(0, max);
  // very light cleanup for preview
  return decoder.write(buf).replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function parseAddress(raw) {
  // raw looks like: '"Name" <user@example.com>' or just the email
  const m = String(raw || '').match(/<?([^<>\s@]+@[^<>\s@]+)>?/);
  return m ? m[1].toLowerCase() : '';
}

function domainOf(email) {
  const m = String(email).toLowerCase().split('@');
  return m.length === 2 ? m[1] : '';
}

// ----------------------------------------------
// Public: testLogin (safe to remove later)
// ----------------------------------------------
export async function testLogin(opts) {
  let imap;
  try {
    imap = await connectIMAP(opts);
    await openInbox(imap);
    endSafe(imap);
    return true;
  } catch (e) {
    endSafe(imap);
    return false;
  }
}

// ----------------------------------------------
// Public: fetchEmails
// opts: { email, password, accessToken, host, port, tls, authType, search, limit }
// returns: { items, nextCursor, hasMore }
// ----------------------------------------------
export async function fetchEmails(opts) {
  const {
    email,
    password,
    accessToken,
    host = 'imap.gmail.com',
    port = 993,
    tls = true,
    authType = 'password',
    search,
    limit = 20,
  } = opts || {};

  const criteria = normalizeSearchCriteria(search);
  let imap;

  try {
    imap = await connectIMAP({ email, password, accessToken, host, port, tls, authType });
    const box = await openInbox(imap);

    // SEARCH
    const uids = await new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
    });

    // Sort newest first, then cap to `limit`
    const wanted = (uids || []).sort((a, b) => b - a).slice(0, Math.max(0, Number(limit) || 0));

    if (wanted.length === 0) {
      endSafe(imap);
      return { items: [], nextCursor: null, hasMore: false };
    }

    // FETCH
    // Keep memory small: PEEK text and cap preview to first ~8KB
    const fetcher = imap.fetch(wanted, {
      bodies: [
        'HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID CONTENT-TYPE)',
        'BODY.PEEK[TEXT]' // do not mark seen
      ],
      struct: true,
    });

    const items = [];
    let current = {};

    await new Promise((resolve, reject) => {
      fetcher.on('message', (msg, seqno) => {
        current = { id: String(seqno), uid: null, headers: {}, snippet: '' };
        const bodyBuffers = [];

        msg.once('attributes', attrs => {
          current.uid = attrs.uid;
          current.flags = attrs.flags || [];
          current.hasIcs = (attrs.struct || []).some(s =>
            (s && s.type && s.subtype) && /calendar/i.test(`${s.type}/${s.subtype}`)
          );
          current.attachTypes = []; // (left empty — fill via struct scan if needed)
        });

        msg.on('body', (stream, info) => {
          if (info.which && info.which.startsWith('HEADER')) {
            let headerBuf = Buffer.alloc(0);
            stream.on('data', (chunk) => { headerBuf = Buffer.concat([headerBuf, chunk]); });
            stream.once('end', () => {
              const parsed = Imap.parseHeader(headerBuf.toString('utf8'));
              current.headers = parsed;
              current.from = headerValue(parsed, 'from') || '';
              current.to = headerValue(parsed, 'to') || '';
              current.subject = headerValue(parsed, 'subject') || '';
              const dateStr = headerValue(parsed, 'date') || '';
              current.date = new Date(dateStr).toISOString();
              current.fromEmail = parseAddress(current.from);
              current.fromDomain = domainOf(current.fromEmail);
              current.contentType = headerValue(parsed, 'content-type') || '';
            });
          } else {
            // TEXT body
            stream.on('data', (chunk) => { bodyBuffers.push(chunk); });
            stream.once('end', () => {
              if (!current.snippet) current.snippet = extractSnippet(bodyBuffers, 8192);
            });
          }
        });

        msg.once('end', () => {
          current.unread = !current.flags.includes('\\Seen');
          current.flagged = current.flags.includes('\\Flagged');
          items.push(current);
        });
      });

      fetcher.once('error', reject);
      fetcher.once('end', resolve);
    });

    endSafe(imap);

    // No server cursoring here; expose a simple shape compatible with your routes.
    return {
      items,
      nextCursor: null,
      hasMore: false,
    };
  } catch (err) {
    endSafe(imap);
    // Re-throw with a short tag so logs are clear but not noisy.
    const e = new Error(`IMAP fetch error: ${err?.message || err}`);
    e.cause = err;
    throw e;
  }
}
