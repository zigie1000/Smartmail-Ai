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
function normalizeCriteria(raw) {
  let criteria = Array.isArray(raw) ? raw.slice() : ['ALL'];

  // Empty / bad -> ALL
  if (!criteria.length) return ['ALL'];

  // If SINCE, ensure there are exactly 2 args and the 2nd is a DD-Mon-YYYY string
  if (String(criteria[0]).toUpperCase() === 'SINCE') {
    if (criteria.length < 2 || criteria[1] == null || criteria[1] === '') {
      return ['ALL']; // 🔒 avoid "Incorrect number of arguments for SINCE"
    }
    const v = criteria[1];
    if (v instanceof Date) {
      criteria[1] = toImapSince(v);
    } else if (typeof v === 'string') {
      // Accept DD-Mon-YYYY; if not, try to parse as Date and reformat
      const ddMonYYYY = /^\d{2}-[A-Z][a-z]{2}-\d{4}$/;
      if (!ddMonYYYY.test(v)) {
        const d = new Date(v);
        if (isNaN(d.getTime())) return ['ALL'];
        criteria[1] = toImapSince(d);
      }
    } else {
      return ['ALL'];
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
