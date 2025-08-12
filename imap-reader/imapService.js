// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Local root CA bundle (no remote fetch)
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject(); // also updates the global https agent

dotenv.config();

/** Date -> DD-Mon-YYYY (UTC) */
function toImapSince(dateObj) {
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const year = dateObj.getUTCFullYear();
  return `${day}-${mon}-${year}`;
}

/**
 * Normalize/validate IMAP search criteria.
 * Guarantees a safe array for the imap lib.
 */
// --- replace your normalizeCriteria with this version ---

function normalizeCriteria(raw) {
  // Default
  if (!raw) return ['ALL'];

  // If already an array of criteria (e.g., ['ALL', ['SINCE', Date]])
  // and looks valid, keep it.
  if (Array.isArray(raw)) {
    // Convert ["SINCE", "string"] -> ["SINCE", Date] and nest if needed
    if (String(raw[0]).toUpperCase() === 'SINCE') {
      let v = raw[1];
      if (!(v instanceof Date)) {
        v = new Date(v);
        if (isNaN(v.getTime())) return ['ALL'];
      }
      // MUST be nested: [ ['SINCE', Date] ]
      return [['SINCE', v]];
    }

    // If it’s already an array of multiple criteria, make sure any SINCE inside is Date
    const fixed = raw.map(c => {
      if (Array.isArray(c) && String(c[0]).toUpperCase() === 'SINCE') {
        let v = c[1];
        if (!(v instanceof Date)) {
          v = new Date(v);
          if (isNaN(v.getTime())) return null;
        }
        return ['SINCE', v];
      }
      return c;
    }).filter(Boolean);

    return fixed.length ? fixed : ['ALL'];
  }

  // Anything else -> ALL
  return ['ALL'];
}
    }
    // Ensure only two args for SINCE
    criteria = ['SINCE', criteria[1]];
  }

  return criteria;
}

export async function fetchEmails({
  email,
  password,
  host,
  port = 993,
  criteria = ['ALL'],
  limit = 20
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data || []);
    };

    // ✅ Ensure criteria is always valid for the imap lib
    criteria = normalizeCriteria(criteria);

    const imap = new Imap({
      user: email,
      password,                               // in-memory only; never logged
      host,
      port: Number(port) || 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: true,             // strict
        servername: host,                     // SNI
        ca: rootCas                           // ✅ local trusted CA bundle
      },
      connTimeout: 30000,
      authTimeout: 30000
      // debug: (/*msg*/) => {}
    });

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

        // 🔎 tiny debug to verify final criteria in logs
        console.log('IMAP search criteria =>', criteria);

        imap.search(criteria, (err, results = []) => {
          if (err) { clearTimeout(watchdog); return finish(err); }
          if (!Array.isArray(results) || results.length === 0) {
            clearTimeout(watchdog);
            try { imap.end(); } catch {}
            return; // 'end' resolves with []
          }

          const n = Math.max(0, Math.min(Number(limit) || 0, results.length)) || results.length;
          const uids = results.slice(-n);

          const fetcher = imap.fetch(uids, { bodies: '' /* full */, struct: false });

          fetcher.on('message', (msg) => {
            let currentUid = null;
            let internalDate = null;

            // capture UID & internal date early
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
                      internalDate,
                      subject: parsed.subject || '(no subject)',
                      from: parsed.from?.text || '',
                      date: parsed.date || internalDate || null,
                      text: parsed.text || '',
                      html: parsed.html || ''
                    });
                  }
                  res(); // never let one bad message hang the batch
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
