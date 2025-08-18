// imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';

// ---------- Helpers ----------
function once(emitter, ev) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { cleanup(); reject(e); };
    const onOk  = (...args) => { cleanup(); resolve(args); };
    const cleanup = () => {
      emitter.removeListener('error', onErr);
      emitter.removeListener(ev, onOk);
    };
    emitter.once('error', onErr);
    emitter.once(ev, onOk);
  });
}

function imapConnect({ host, port = 993, tls = true, email, password, accessToken, authType = 'password' }) {
  const useXoauth2 = authType === 'xoauth2' && accessToken;
  const cfg = {
    user: email,
    host,
    port,
    tls,
    // If Render logs complain about self-signed certs and you *explicitly* allow it:
    tlsOptions: process.env.ALLOW_SELF_SIGNED === '1'
      ? { rejectUnauthorized: false, servername: host }
      : { servername: host },
  };
  if (useXoauth2) {
    cfg.xoauth2 = accessToken;
  } else {
    cfg.password = password;
  }

  const imap = new Imap(cfg);
  imap.connect();
  return imap;
}

// Make a safe, log-only copy of the criteria (DON'T use this for imap.search)
function criteriaForLog(criteria) {
  return criteria.map((c) => (c instanceof Date ? c.toISOString() : c));
}

// Pull a small body preview to avoid big memory usage
async function collectMessageParts(stream, maxBytes = 2000) {
  let buf = '';
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      if (buf.length < maxBytes) buf += chunk.toString('utf8');
    });
    stream.once('end', () => resolve(buf));
    stream.once('error', reject);
  });
}

// ---------- Public API ----------
export async function testLogin({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  let imap;
  try {
    imap = imapConnect({ email, password, accessToken, host, port, tls, authType });
    await once(imap, 'ready');
    imap.end();
    return true;
  } catch (e) {
    try { imap && imap.end(); } catch {}
    return false;
  }
}

/**
 * fetchEmails
 * @param {Object} opts
 *   - email, password | accessToken
 *   - host, port, tls, authType
 *   - search: Array node-imap criteria; OR supply rangeDays to auto-build
 *   - limit: number of messages to return (newest first)
 */
export async function fetchEmails(opts) {
  const {
    email, password, accessToken,
    host, port = 993, tls = true, authType = 'password',
    search, limit = 20, rangeDays,
  } = opts || {};

  // Build REAL criteria with Date object
  let criteria;
  if (Array.isArray(search) && search.length) {
    criteria = search;
  } else if (typeof rangeDays === 'number' && rangeDays > 0) {
    const sinceDate = new Date(Date.now() - rangeDays * 864e5); // Date object, not string
    criteria = ['SINCE', sinceDate];
  } else {
    criteria = ['ALL'];
  }

  // Log-friendly snapshot (DO NOT PASS to imap.search)
  const criteriaLog = criteriaForLog(criteria);
  console.log('IMAP criteria (server-side):', JSON.stringify(criteriaLog));

  let imap;
  try {
    imap = imapConnect({ email, password, accessToken, host, port, tls, authType });
    await once(imap, 'ready');

    // Open INBOX
    imap.openBox('INBOX', true, (err) => {
      if (err) imap.emit('error', err);
    });
    await once(imap, 'mail'); // mail event also fires at open with current message count
  } catch (e) {
    try { imap && imap.end(); } catch {}
    throw e;
  }

  // Wrap the whole fetch in a Promise
  const result = await new Promise((resolve, reject) => {
    imap.search(criteria, (err, uids) => {
      if (err) {
        return reject(new Error(`IMAP /fetch error: ${err.message || err}`));
      }
      // Newest first, cap to limit
      const sel = (uids || []).slice(-limit).reverse();

      if (!sel.length) {
        return resolve({ items: [], nextCursor: null, hasMore: false });
      }

      const f = imap.fetch(sel, {
        // small set of bodies; avoid downloading whole messages
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
        struct: true,
      });

      const items = [];

      f.on('message', (msg, seqno) => {
        let headersRaw = '';
        let textRaw = '';

        msg.on('body', async (stream, info) => {
          const chunk = await collectMessageParts(stream, 2000);
          if (info.which && info.which.startsWith('HEADER')) headersRaw += chunk;
          else textRaw += chunk;
        });

        msg.once('attributes', (attrs) => {
          // Keep UID for potential later actions
          msg._uid = attrs.uid;
          msg._attrs = attrs;
        });

        msg.once('end', async () => {
          // Parse headers
          let from = '', subject = '', date = '', to = '';
          try {
            const parsed = await simpleParser(headersRaw + '\r\n' + textRaw.slice(0, 0)); // headers only
            from = parsed.from ? parsed.from.text || '' : '';
            to = parsed.to ? parsed.to.text || '' : '';
            subject = parsed.subject || '';
            date = parsed.date ? parsed.date.toISOString() : '';
          } catch {}

          // Simple snippet from text
          const snippet = textRaw.replace(/\s+/g, ' ').trim().slice(0, 300);

          // Extract fromEmail/fromDomain
          let fromEmail = '';
          if (from) {
            const m = from.match(/<([^>]+)>/);
            fromEmail = (m ? m[1] : from).trim().toLowerCase();
          }
          const fromDomain = fromEmail.includes('@') ? fromEmail.split('@').pop() : '';

          items.push({
            id: String(msg._uid || seqno),
            uid: msg._uid,
            from,
            fromEmail,
            fromDomain,
            to,
            subject,
            snippet,
            date,
            unread: !!(msg._attrs && msg._attrs.flags && !msg._attrs.flags.includes('\\Seen')),
            flagged: !!(msg._attrs && msg._attrs.flags && msg._attrs.flags.includes('\\Flagged')),
            hasIcs: false,
            attachTypes: [],
            headers: {}, // keep light
            contentType: 'text',
          });
        });
      });

      f.once('error', (e) => reject(new Error(`IMAP fetch stream error: ${e.message || e}`)));
      f.once('end', () => resolve({ items, nextCursor: null, hasMore: false }));
    });
  }).finally(() => {
    try { imap.end(); } catch {}
  });

  return result;
}
