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
 * Format a Date to IMAP SINCE format: DD-Mon-YYYY (UTC)
 */
function toImapSince(dateObj) {
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const year = dateObj.getUTCFullYear();
  return `${day}-${mon}-${year}`;
}

/**
 * Normalize/format criteria:
 * - Supports ['SINCE', Date]  -> ['SINCE', 'DD-Mon-YYYY']
 * - Supports ['UID', 'X:*'] as-is
 * - Fallback to ['ALL']
 */
function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return ['ALL'];
  if (criteria[0] === 'SINCE' && criteria[1] instanceof Date) {
    return ['SINCE', toImapSince(criteria[1])];
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

    // Ensure criteria is IMAP-ready
    criteria = normalizeCriteria(criteria);

    const imap = new Imap({
      user: email,
      password,                               // in-memory only; never logged
      host,
      port: Number(port) || 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: true,             // keep validation strict
        servername: host,                     // SNI
        ca: rootCas                           // ✅ local trusted CA bundle
      },
      connTimeout: 30000,                     // generous for cold starts
      authTimeout: 30000
      // debug: (/*msg*/) => {}               // keep off to avoid leaking
    });

    const emails = [];
    const parsers = [];

    // Safety watchdog (allow slow Gmail handshake)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      finish(new Error('IMAP connection timed out'));
    }, 90000);

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { clearTimeout(watchdog); return finish(err); }

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
