// imapService.js
// ------------------------------------------------------------------
// IMAP plumbing for SmartEmail (fetch + test login)
// - Robust search normalization (['SINCE', Date]) for node-imap
// - Password or XOAUTH2 auth
// - Safe TLS defaults (with optional self-signed override)
// - Converts messages to the shape expected by the classifier
// ------------------------------------------------------------------

import Imap from 'imap';
import { simpleParser } from 'mailparser';

// ---------- TLS helpers ----------
function buildTlsOptions(host, allowSelfSigned) {
  const tlsOptions = {
    servername: host || undefined,   // SNI for some providers
    rejectUnauthorized: true,
  };
  if (allowSelfSigned) {
    // Only enable if you *really* need it, by setting env ALLOW_SELF_SIGNED=1
    tlsOptions.rejectUnauthorized = false;
  }
  return tlsOptions;
}

// ---------- Search normalization (CRITICAL FIX) ----------
function toDateSafe(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d)) return d;
  }
  // fallback: 7 days ago
  return new Date(Date.now() - 7 * 864e5);
}

/**
 * Ensures node-imap compatible search array.
 * - Converts ['SINCE', '2025-08-17T…Z'] -> ['SINCE', Date]
 * - Accepts a number = last N days
 * - Accepts 'ALL' or 'SINCE:ISO'
 */
export function normalizeImapSearch(search) {
  if (search == null) return ['ALL'];

  if (typeof search === 'number') {
    return ['SINCE', new Date(Date.now() - Math.max(0, search) * 864e5)];
  }

  if (Array.isArray(search)) {
    const out = [];
    for (let i = 0; i < search.length; i++) {
      const tok = search[i];
      if (String(tok).toUpperCase() === 'SINCE') {
        const v = toDateSafe(search[i + 1]);
        out.push('SINCE', v);
        i += 1;
      } else {
        out.push(tok);
      }
    }
    return out.length ? out : ['ALL'];
  }

  const s = String(search).trim();
  if (/^all$/i.test(s)) return ['ALL'];
  if (/^since:/i.test(s)) {
    const iso = s.split(':', 2)[1] || '';
    return ['SINCE', toDateSafe(iso)];
  }
  return ['ALL'];
}

// ---------- Connection helpers ----------
function imapConfig({ email, password, accessToken, host, port, tls, authType }) {
  const allowSelfSigned = process.env.ALLOW_SELF_SIGNED === '1';

  const cfg = {
    user: email,
    host: host || 'imap.gmail.com',
    port: port || 993,
    tls: tls !== false,
    tlsOptions: buildTlsOptions(host, allowSelfSigned),
    connTimeout: 30_000,
    authTimeout: 30_000,
    keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true },
  };

  const mode = String(authType || 'password').toLowerCase();
  if (mode === 'xoauth2' || mode === 'oauth' || mode === 'oauth2') {
    cfg.xoauth2 = accessToken; // raw OAuth2 bearer token string
  } else {
    cfg.password = password;
  }
  return cfg;
}

function openInbox(imap, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', readOnly, (err, box) => (err ? reject(err) : resolve(box)));
  });
}

function endAndClose(imap) {
  try { imap.end(); } catch {}
}

// ---------- Public: testLogin ----------
export async function testLogin({ email, password, accessToken, host, port, tls, authType }) {
  const cfg = imapConfig({ email, password, accessToken, host, port, tls, authType });
  return new Promise((resolve) => {
    const imap = new Imap(cfg);

    const onError = (e) => { try { endAndClose(imap); } catch {} ; resolve(false); };
    imap.once('error', onError);

    imap.once('ready', async () => {
      try {
        await openInbox(imap, true);
        endAndClose(imap);
        resolve(true);
      } catch {
        endAndClose(imap);
        resolve(false);
      }
    });

    try { imap.connect(); } catch { resolve(false); }
  });
}

// ---------- Public: fetchEmails ----------
export async function fetchEmails({
  email, password, accessToken, host, port, tls, authType,
  search, limit = 20
}) {
  const cfg = imapConfig({ email, password, accessToken, host, port, tls, authType });
  const criteria = normalizeImapSearch(search);
  const hardLimit = Math.max(1, Math.min(Number(limit) || 20, 200)); // safety

  return new Promise((resolve, reject) => {
    const imap = new Imap(cfg);

    const bail = (err) => { endAndClose(imap); reject(err); };

    imap.once('error', bail);

    imap.once('ready', async () => {
      try {
        await openInbox(imap, true);

        // Search
        imap.search(criteria, (err, uids) => {
          if (err) return bail(err);

          // Take the newest N (node-imap returns ascending UIDs typically)
          const take = (uids || []).slice(-hardLimit);

          if (take.length === 0) {
            endAndClose(imap);
            return resolve({ items: [], nextCursor: null, hasMore: false });
          }

          const f = imap.fetch(take, { bodies: '', struct: true });
          const items = [];

          f.on('message', (msg, seqno) => {
            const parts = [];
            let attrs = null;

            msg.on('body', (stream) => {
              const chunks = [];
              stream.on('data', (c) => chunks.push(c));
              stream.on('end', () => parts.push(Buffer.concat(chunks)));
            });

            msg.once('attributes', (a) => { attrs = a; });

            msg.once('end', async () => {
              try {
                const raw = Buffer.concat(parts);
                const parsed = await simpleParser(raw);

                const hdr = parsed.headers;
                const fromAddr = parsed.from?.value?.[0] || {};
                const toAddr = parsed.to?.value?.[0] || {};

                const fromEmail = (fromAddr.address || '').toLowerCase();
                const fromDomain = fromEmail.split('@')[1] || '';

                const hasIcs = (parsed.attachments || []).some(a => /calendar|ics/i.test(a.contentType));
                const attachTypes = (parsed.attachments || []).map(a => (a.contentType || '').toLowerCase());

                items.push({
                  id: attrs?.uid || seqno,
                  uid: attrs?.uid,
                  from: fromAddr.name || fromEmail,
                  fromEmail,
                  fromDomain,
                  to: toAddr.address || '',
                  subject: parsed.subject || '',
                  date: parsed.date ? parsed.date.toISOString() : (attrs?.date ? new Date(attrs.date).toISOString() : ''),
                  text: parsed.text || '',
                  snippet: (parsed.text || '').slice(0, 300),
                  unread: !(attrs?.flags || []).includes('\\Seen'),
                  flagged: (attrs?.flags || []).includes('\\Flagged'),
                  contentType: parsed.mimeType || '',
                  hasIcs,
                  attachTypes,
                  headers: Object.fromEntries([...hdr].map(([k, v]) => [String(k).toLowerCase(), String(v)])),
                });
              } catch (e) {
                // Skip malformed message but continue
              }
            });
          });

          f.once('error', bail);

          f.once('end', () => {
            endAndClose(imap);

            // Sort newest first by date (fallback to UID)
            items.sort((a, b) => {
              const da = a.date ? Date.parse(a.date) : 0;
              const db = b.date ? Date.parse(b.date) : 0;
              if (db !== da) return db - da;
              return (b.uid || 0) - (a.uid || 0);
            });

            // Cursoring hooks (simple stub; extend if you add pagination)
            resolve({
              items,
              nextCursor: null,
              hasMore: false,
            });
          });
        });
      } catch (e) {
        bail(e);
      }
    });

    try { imap.connect(); } catch (e) { bail(e); }
  });
}

export default {
  fetchEmails,
  testLogin,
  normalizeImapSearch,
};
