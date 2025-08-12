// imap-reader/imapService.js
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Local root CA bundle (no remote fetch)
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject(); // also updates the global https agent

dotenv.config();

/** IMAP "SINCE" needs DD-Mon-YYYY (UTC) */
function toImapSince(dateObj) {
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dateObj.getUTCMonth()];
  const year = dateObj.getUTCFullYear();
  return `${day}-${mon}-${year}`;
}

/** Normalize criteria:
 *  - ['SINCE', Date]  -> ['SINCE', 'DD-Mon-YYYY']
 *  - undefined + sinceDays -> ['SINCE', 'DD-Mon-YYYY'] (computed)
 *  - otherwise pass through or default to ['ALL']
 */
function normalizeCriteria(criteria, sinceDays) {
  if (Array.isArray(criteria) && criteria.length) {
    if (criteria[0] === 'SINCE' && criteria[1] instanceof Date) {
      return ['SINCE', toImapSince(criteria[1])];
    }
    return criteria;
  }
  if (sinceDays && Number(sinceDays) > 0) {
    const d = new Date(Date.now() - Number(sinceDays) * 24 * 60 * 60 * 1000);
    return ['SINCE', toImapSince(d)];
  }
  return ['ALL'];
}

/** Build XOAUTH2 string for node-imap when using OAuth access tokens */
function buildXOAuth2(user, accessToken) {
  // Format: base64("user=<email>\x01auth=Bearer <token>\x01\x01")
  const raw = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/**
 * Fetch emails over IMAP
 * Supports:
 *  - Password/App Password auth (default)
 *  - XOAUTH2 (accessToken) for Microsoft/Gmail OAuth
 *  - TLS on/off
 *  - Date range via sinceDays OR custom criteria
 */
export async function fetchEmails({
  email,
  password,
  host,
  port = 993,
  criteria,           // optional IMAP criteria array
  sinceDays,          // optional number of days for SINCE
  limit = 20,
  tls = true,         // boolean
  authType = 'password',   // 'password' | 'xoauth2'
  accessToken = ''    // required when authType === 'xoauth2'
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data || []);
    };

    const searchCriteria = normalizeCriteria(criteria, sinceDays);

    // ---- Build IMAP connection config ----
    const imapConfig = {
      user: email,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      connTimeout: 30000,  // generous for cold starts/providers
      authTimeout: 30000
      // debug: (/*msg*/) => {}  // keep off to avoid leaking
    };

    if (imapConfig.tls) {
      imapConfig.tlsOptions = {
        rejectUnauthorized: true, // keep validation strict
        servername: host,         // SNI
        ca: rootCas               // ✅ local trusted CA bundle
      };
    }

    if (authType === 'xoauth2') {
      if (!accessToken) return finish(new Error('Missing access token for XOAUTH2'));
      imapConfig.xoauth2 = buildXOAuth2(email, accessToken);
    } else {
      // default: password/app-password
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

        imap.search(searchCriteria, (err, results = []) => {
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
                  res(); // never block whole batch on one message
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
      // Normalize a couple of common errors for better UX (optional)
      const m = (err?.message || '').toLowerCase();
      if (m.includes('authentication') || m.includes('auth')) {
        return finish(new Error('Authentication failed (check password/app password or token).'));
      }
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
