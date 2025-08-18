// imapService.js — normalized IMAP fetch + safe SINCE handling
import Imap from 'imap';
import { simpleParser } from 'mailparser';

function toBool(v, d=false){ return v === true || v === 'true' ? true : v === false || v === 'false' ? false : d; }

/** Ensure criteria is valid for node-imap:
 *  - ['ALL']  OR
 *  - ['SINCE', Date]  (Date object ONLY)
 */
function normalizeCriteria(search, fallbackRangeDays = 0) {
  // If a valid array comes in from the route, sanitize it.
  if (Array.isArray(search) && search.length > 0) {
    const key = String(search[0] || '').toUpperCase();
    if (key === 'ALL') return ['ALL'];
    if (key === 'SINCE') {
      const raw = search[1];
      // Accept Date | number | string(ISO) and convert to Date
      let dt = raw instanceof Date ? raw
            : (typeof raw === 'number' ? new Date(raw)
            : (typeof raw === 'string' ? new Date(raw) : null));
      if (dt && !isNaN(dt.getTime())) return ['SINCE', dt];
      // bad date -> fall back below
    }
  }

  // Build from fallback days if provided
  const days = Math.max(0, Number(fallbackRangeDays) || 0);
  if (days > 0) return ['SINCE', new Date(Date.now() - days * 864e5)];
  return ['ALL'];
}

function openBox(imap, box = 'INBOX') {
  return new Promise((resolve, reject) => {
    imap.openBox(box, true, (err, boxInfo) => err ? reject(err) : resolve(boxInfo));
  });
}

function imapConnect({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const conf = {
    user: email,
    host: host || 'imap.gmail.com',
    port: Number(port) || 993,
    tls: toBool(tls, true),
    tlsOptions: { rejectUnauthorized: true },
    connTimeout: 15000,
    authTimeout: 15000,
  };

  if (authType === 'xoauth2' && accessToken) {
    conf.xoauth2 = accessToken;
  } else {
    conf.password = password || '';
  }

  const imap = new Imap(conf);

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    imap.once('ready', () => {
      imap.removeListener('error', onError);
      resolve(imap);
    });
    imap.once('error', onError);
    imap.connect();
  });
}

function fetchEnvelope(imap, uids, { maxBytesPerBody = 64 * 1024 } = {}) {
  if (!uids || uids.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const out = [];
    const f = imap.fetch(uids, {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
      struct: true
    });

    f.on('message', (msg, seqno) => {
      const rec = { id: String(seqno), uid: null, from: '', to: '', subject: '', date: null, snippet: '', hasIcs: false, attachTypes: [] };

      msg.on('attributes', (attrs) => {
        rec.uid = attrs.uid;
        // detect attachment types lightly
        if (Array.isArray(attrs.struct)) {
          const walk = (parts) => {
            parts.forEach(p => {
              if (Array.isArray(p)) return walk(p);
              if (p && p.disposition && /attachment/i.test(p.disposition.type) && p.type) {
                rec.attachTypes.push(`${p.type}/${p.subtype}`.toLowerCase());
                if (String(p.subtype).toLowerCase() === 'calendar') rec.hasIcs = true;
              }
            });
          };
          walk(attrs.struct);
        }
      });

      msg.on('body', async (stream, info) => {
        const chunks = [];
        let bytes = 0;
        stream.on('data', (chunk) => {
          if (bytes < maxBytesPerBody) {
            chunks.push(chunk);
            bytes += chunk.length;
          } else {
            stream.resume();
          }
        });
        stream.on('end', async () => {
          try {
            const buf = Buffer.concat(chunks);
            if (/HEADER/i.test(info.which)) {
              const hdr = Imap.parseHeader(buf.toString('utf8'));
              rec.from = (hdr.from && hdr.from[0]) || '';
              rec.to = (hdr.to && hdr.to[0]) || '';
              rec.subject = (hdr.subject && hdr.subject[0]) || '';
              rec.date = (hdr.date && hdr.date[0]) || null;
            } else {
              // lightweight parse to get a nice snippet (avoid full decode for memory)
              const text = buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 500);
              rec.snippet = text;
            }
          } catch (e) {
            // ignore parse errors for robustness
          }
        });
      });

      msg.on('end', () => out.push(rec));
    });

    f.once('error', reject);
    f.once('end', () => resolve(out));
  });
}

export async function fetchEmails({
  email, password, accessToken, host, port = 993, tls = true, authType = 'password',
  search, limit = 20, rangeDays // optional fallback if search isn’t set
}) {
  const imap = await imapConnect({ email, password, accessToken, host, port, tls, authType });

  try {
    await openBox(imap, 'INBOX');

    // *** THIS IS THE IMPORTANT BIT ***
    const criteria = normalizeCriteria(search, rangeDays);

    // node-imap search
    const uids = await new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => (err ? reject(err) : resolve(results || [])));
    });

    // newest first, apply limit
    const pick = (uids || []).sort((a, b) => b - a).slice(0, Math.max(1, Number(limit) || 20));

    const emails = await fetchEnvelope(imap, pick);
    const nextCursor = null; // keep for future paging
    const hasMore = false;

    return { items: emails, nextCursor, hasMore };
  } finally {
    try { imap.end(); } catch {}
  }
}

/** Minimal, removable login test.
 * Safe to delete later; fetchEmails does not depend on it.
 */
export async function testLogin({ email, password, accessToken, host, port = 993, tls = true, authType = 'password' }) {
  const imap = await imapConnect({ email, password, accessToken, host, port, tls, authType });
  try {
    await openBox(imap, 'INBOX');
    return true;
  } finally {
    try { imap.end(); } catch {}
  }
}
