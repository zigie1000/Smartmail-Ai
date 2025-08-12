// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Local root CA bundle (no remote fetch)
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject(); // also updates the global https agent

dotenv.config();

/** Format a Date to IMAP SINCE format: DD-Mon-YYYY (UTC) */
function toImapSince(dateObj) {
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const year = dateObj.getUTCFullYear();
  return `${day}-${mon}-${year}`;
}

/** Criteria normalizer (accepts ['SINCE', Date]) */
function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return ['ALL'];
  if (criteria[0] === 'SINCE' && criteria[1] instanceof Date) {
    return ['SINCE', toImapSince(criteria[1])];
  }
  return criteria;
}

/** Build XOAUTH2 token (RFC 7628 style) */
function buildXoauth2(user, accessToken) {
  // "user=<email>\x01auth=Bearer <token>\x01\x01" then base64
  const raw = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

export async function fetchEmails({
  email,
  password,
  host,
  port = 993,
  criteria = ['ALL'],
  limit = 20,
  tls = true,
  authType = 'password',       // 'password' | 'xoauth2'
  accessToken = ''             // if authType === 'xoauth2'
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

    // Base IMAP config
    const imapConfig = {
      user: email,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: !!tls ? {
        rejectUnauthorized: true,
        servername: host,
        ca: rootCas
      } : undefined,
      connTimeout: 30000,
      authTimeout: 30000
      // debug: (msg) => console.log('[imap]', msg)
    };

    if (authType === 'xoauth2') {
      if (!accessToken) return finish(new Error('Missing access token for XOAUTH2'));
      imapConfig.xoauth2 = buildXoauth2(email, accessToken);
    } else {
      imapConfig.password = password;
    }

    const imap = new Imap(imapConfig);

    const emails = [];
    const parsers = [];

    // Safety watchdog
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

          const fetcher = imap.fetch(uids, { bodies: '', struct: false });

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
