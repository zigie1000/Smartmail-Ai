// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Load Mozilla root CAs (fixes "self-signed certificate" on some hosts)
import sslRootCAs from 'ssl-root-cas/latest.js';
const rootCas = sslRootCAs.create();
rootCas.inject(); // also affects global https agent (safe)

dotenv.config();

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

    const imap = new Imap({
      user: email,
      password,                               // in-memory only
      host,
      port: Number(port) || 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: true,             // keep validation strict
        servername: host,                     // SNI
        ca: rootCas                           // ✅ trusted CA bundle
      },
      connTimeout: 15000,
      authTimeout: 15000
      // debug: (/*msg*/) => {}               // keep off to avoid leaking
    });

    const emails = [];
    const parsers = [];

    // Watchdog (belt & braces)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      finish(new Error('IMAP connection timed out'));
    }, 45000);

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
          const fetcher = imap.fetch(uids, { bodies: '' });

          fetcher.on('message', (msg) => {
            msg.on('body', (stream) => {
              const p = new Promise((res) => {
                simpleParser(stream, (err, parsed) => {
                  if (!err && parsed) {
                    emails.push({
                      subject: parsed.subject || '(no subject)',
                      from: parsed.from?.text || '',
                      date: parsed.date || null,
                      text: parsed.text || '',
                      html: parsed.html || ''
                    });
                  }
                  res(); // don’t let one bad message hang the whole fetch
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
