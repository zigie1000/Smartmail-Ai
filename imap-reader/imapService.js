// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';
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
    const done = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data || []);
    };

    // ✅ Force TLS and reject bad certs
    const imap = new Imap({
      user: email,
      password,                           // in-memory only; never logged
      host,
      port: Number(port) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: true }, // no self-signed fallback
      connTimeout: 15000,                 // optional: fail fast on bad hosts
      authTimeout: 15000                  // optional: fail fast on bad creds
      // debug: (/*msg*/) => {}           // keep disabled to avoid leaking
    });

    const emails = [];
    const parsePromises = [];

    // Safety: abort if connect takes too long (belt & braces)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      done(new Error('IMAP connection timed out'));
    }, 45000);

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { clearTimeout(watchdog); return done(err); }

        imap.search(criteria, (err, results = []) => {
          if (err) { clearTimeout(watchdog); return done(err); }

          // ✅ Handle empty mailbox or no matches
          if (!Array.isArray(results) || results.length === 0) {
            clearTimeout(watchdog);
            imap.end();                    // triggers 'end' → resolve([])
            return;
          }

          // ✅ Respect limit safely
          const n = Math.max(0, Math.min(Number(limit) || 0, results.length)) || results.length;
          const uids = results.slice(-n);

          const fetcher = imap.fetch(uids, { bodies: '' });

          fetcher.on('message', (msg /*, seqno*/) => {
            msg.on('body', (stream /*, info*/) => {
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
                  res(); // always resolve to avoid hanging on a bad message
                });
              });
              parsePromises.push(p);
            });
          });

          fetcher.once('error', (e) => {
            clearTimeout(watchdog);
            done(new Error(`IMAP fetch error: ${e?.message || e}`));
          });

          // Wait for parser(s) to finish before closing the connection
          fetcher.once('end', () => {
            Promise.allSettled(parsePromises).finally(() => {
              try { imap.end(); } catch {}
            });
          });
        });
      });
    });

    imap.once('error', (err) => {
      clearTimeout(watchdog);
      done(new Error(err?.message || 'IMAP error'));
    });

    imap.once('end', () => {
      clearTimeout(watchdog);
      done(null, emails);
    });

    try {
      imap.connect();
    } catch (e) {
      clearTimeout(watchdog);
      done(new Error(e?.message || 'Failed to start IMAP connection'));
    }
  });
}
