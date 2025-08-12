// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Local root CA bundle (no remote fetch)
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject(); // also updates the global https agent

dotenv.config();

/**
 * Normalize/validate IMAP search criteria so the `imap` library
 * always receives the correct nested shape:
 *   - Good: [ ['SINCE', Date] ]
 *   - Also OK: ['ALL', ['SINCE', Date]]
 *   - BAD (what caused your crash): ['SINCE', '10-Aug-2025']  // string date, not nested
 */
function normalizeCriteria(raw) {
  // Default
  if (!raw) return ['ALL'];

  // If user passed a single pair like ['SINCE', <something>]
  if (Array.isArray(raw) && String(raw[0]).toUpperCase() === 'SINCE') {
    let v = raw[1];
    if (!(v instanceof Date)) v = new Date(v);
    if (isNaN(v.getTime())) return ['ALL'];
    return [['SINCE', v]];
  }

  // If user passed an array of multiple criteria,
  // ensure any SINCE item inside it is nested and uses a Date.
  if (Array.isArray(raw)) {
    const fixed = raw
      .map((c) => {
        if (Array.isArray(c) && String(c[0]).toUpperCase() === 'SINCE') {
          let v = c[1];
          if (!(v instanceof Date)) v = new Date(v);
          if (isNaN(v.getTime())) return null;
          return ['SINCE', v];
        }
        return c;
      })
      .filter(Boolean);

    return fixed.length ? fixed : ['ALL'];
  }

  // Anything else -> ALL
  return ['ALL'];
}

export async function fetchEmails({
  email,
  password,          // for password/app password OR XOAUTH2 access token (see authType)
  host,
  port = 993,
  criteria = ['ALL'],
  limit = 20,
  tls = true,
  authType = 'password', // 'password' | 'xoauth2'
  accessToken = ''       // required if authType === 'xoauth2'
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data || []);
    };

    // Ensure criteria is IMAP-ready right before search
    criteria = normalizeCriteria(criteria);

    // Build IMAP config
    const imapConfig = {
      user: email,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: {
        rejectUnauthorized: true,     // keep validation strict
        servername: host,             // SNI
        ca: rootCas                   // ✅ local trusted CA bundle
      },
      connTimeout: 30000,             // generous for cold starts
      authTimeout: 30000
      // debug: (/*msg*/) => {}       // keep off to avoid leaking
    };

    if (authType === 'xoauth2') {
      // XOAUTH2: supply the access token
      imapConfig.xoauth2 = accessToken || password || '';
    } else {
      // Password/App Password
      imapConfig.password = password;
    }

    const imap = new Imap(imapConfig);

    const emails = [];
    const parsers = [];

    // Safety watchdog (allow slow handshakes)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      finish(new Error('IMAP connection timed out'));
    }, 90000);

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { clearTimeout(watchdog); return finish(err); }

        // 🔎 Final criteria (keep this log until you confirm it’s fixed)
        try {
          console.log('IMAP search criteria (final) =>', JSON.stringify(criteria));
        } catch {}

        imap.search(criteria, (err, results = []) => {
          if (err) { clearTimeout(watchdog); return finish(err); }

          if (!Array.isArray(results) || results.length === 0) {
            clearTimeout(watchdog);
            try { imap.end(); } catch {}
            return; // 'end' will resolve with []
          }

          const n = Math.max(0, Math.min(Number(limit) || 0, results.length)) || results.length;
          const uids = results.slice(-n);

          const fetcher = imap.fetch(uids, { bodies: '' /* full */, struct: false });

          fetcher.on('message', (msg) => {
            let currentUid = null;
            let internalDate = null;

            msg.once('attributes', (attrs) => {
              currentUid = attrs?.uid ?? null;
              internalDate = attrs?.date ?? null;
            });

            msg.on('body', (stream) => {
              const p = new Promise((res) => {
                simpleParser(stream, (err, parsed) => {
                  if (!err && parsed) {
                    emails.push({
                      uid: currentUid,
                      internalDate: internalDate,
                      subject: parsed.subject || '(no subject)',
                      from: parsed.from?.text || '',
                      date: parsed.date || internalDate || null,
                      text: parsed.text || '',
                      html: parsed.html || ''
                    });
                  }
                  // Always resolve so one bad message doesn't hang the batch
                  res();
                });
              });
              parsers.push(p);
            });
          });

          fetcher.once('error', (e) => {
            clearTimeout(watchdog);
            finish(new Error(`IMAP fetch error: ${e?.message || e}`));
          });

          fetcher.once('end', () => {
            Promise.allSettled(parsers).finally(() => {
              try { imap.end(); } catch {}
            });
          });
        });
      });
    });

    imap.once('error', (err) => {
      clearTimeout(watchdog);
      finish(new Error(err?.message || 'IMAP error'));
    });

    imap.once('end', () => {
      clearTimeout(watchdog);
      finish(null, emails);
    });

    try {
      imap.connect();
    } catch (e) {
      clearTimeout(watchdog);
      finish(new Error(e?.message || 'Failed to start IMAP connection'));
    }
  });
}
