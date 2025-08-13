// imap-reader/imapService.js — iCloud-friendly IMAP fetcher (full file)

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Use a local root CA bundle (no remote fetch) so TLS verify passes on Render
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject();

dotenv.config();

const IMAP_DEBUG = String(process.env.IMAP_DEBUG || '').toLowerCase() === 'true';

/* ----------------------------------------------------------------
   Helpers
----------------------------------------------------------------- */

/** Make sure search criteria is in a shape the `imap` lib accepts */
function normalizeCriteria(raw) {
  if (!raw) return ['ALL'];

  // Single SINCE pair => wrap
  if (Array.isArray(raw) && String(raw[0]).toUpperCase() === 'SINCE') {
    let v = raw[1];
    if (!(v instanceof Date)) v = new Date(v);
    if (isNaN(v.getTime())) return ['ALL'];
    return [['SINCE', v]];
  }

  // Mixed array => normalize only SINCE
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
  return ['ALL'];
}

/** Human-readable IMAP error text (no secrets) */
function friendlyImapError(msg = '', ctx = {}) {
  const s = String(msg || '');
  const host = String(ctx.host || '');
  const email = String(ctx.email || '');
  const authType = String(ctx.authType || 'password');

  const isIcloud =
    /imap\.mail\.me\.com/i.test(host) ||
    /@(icloud\.com|me\.com|mac\.com)$/i.test(email);

  if (/AUTHENTICATIONFAILED|Invalid credentials|login failed|AUTHENTICATION FAILED/i.test(s)) {
    if (isIcloud && authType !== 'xoauth2') {
      return 'Authentication Failed — iCloud requires an App-Specific Password when 2FA is enabled. Generate one at appleid.apple.com → Sign-In & Security → App-Specific Passwords.';
    }
    return 'Authentication Failed (check username and password/app password)';
  }

  if (/ENOTFOUND|getaddrinfo|hostname|not found/i.test(s)) return 'IMAP host not found';
  if (/self signed|certificate|unable to verify|hostname\/IP.*certificate/i.test(s)) return 'TLS certificate validation failed';
  if (/timed out|timeout/i.test(s)) return 'IMAP connection timed out';
  if (/Too many simultaneous connections/i.test(s)) return 'Too many simultaneous IMAP connections';
  if (/rate limit|temporarily unavailable/i.test(s)) return 'IMAP rate limited or temporarily unavailable';

  return s;
}

/* ----------------------------------------------------------------
   Minimal login test (no fetch)
----------------------------------------------------------------- */
export async function testLogin({
  email,
  password,
  host,
  port = 993,
  tls = true,
  authType = 'password', // 'password' | 'xoauth2'
  accessToken = ''
}) {
  return new Promise((resolve, reject) => {
    const imapConfig = {
      user: email,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: {
        rejectUnauthorized: true,
        servername: host,
        ca: rootCas,
        minVersion: 'TLSv1.2'
      },
      connTimeout: 30000,
      authTimeout: 30000
    };
    if (authType === 'xoauth2') imapConfig.xoauth2 = accessToken || password || '';
    else imapConfig.password = password;

    const imap = new Imap(imapConfig);

    const fail = (e) => reject(new Error(friendlyImapError(e?.message || e, { host, email, authType })));
    const done = () => { try { imap.end(); } catch {} ; resolve(true); };

    if (IMAP_DEBUG) {
      imap.on('alert',  (m) => console.log('[IMAP alert]', m));
      imap.on('close',  (hadErr) => console.log('[IMAP close]', hadErr));
      imap.on('ready',  () => console.log('[IMAP ready] login OK'));
    }

    imap.once('error', fail);
    imap.once('ready', done);

    try { imap.connect(); } catch (e) { fail(e); }
  });
}

/* ----------------------------------------------------------------
   Full fetch (iCloud-friendly)
   - iCloud: fetch ENVELOPE + small TEXT snippet => fast + reliable
   - Others: fetch full BODY[] and parse as before
----------------------------------------------------------------- */
export async function fetchEmails({
  email,
  password,          // password or XOAUTH2 token (see authType)
  host,
  port = 993,
  criteria = ['ALL'],
  limit = 20,
  tls = true,
  authType = 'password',
  accessToken = ''
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data || []);
    };

    const isIcloud = /imap\.mail\.me\.com/i.test(String(host));

    // Final search criteria
    criteria = normalizeCriteria(criteria);

    // iCloud: lighter fetch to prevent timeouts on Render
    const ICLOUD_SNIPPET_BYTES = 12 * 1024; // 12KB preview
    const FETCH_BODIES_ICLOUD = [
      'ENVELOPE',
      `BODY[TEXT]<0.${ICLOUD_SNIPPET_BYTES}>`, // small snippet
      'FLAGS',
    ];

    // Non-iCloud: full message for parser (kept behavior)
    const FETCH_BODIES_FULL = ['']; // BODY[] (full)

    const imapConfig = {
      user: email,
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: {
        rejectUnauthorized: true,
        servername: host,
        ca: rootCas,
        minVersion: 'TLSv1.2'
      },
      connTimeout: 30000,
      authTimeout: 30000
    };
    if (authType === 'xoauth2') imapConfig.xoauth2 = accessToken || password || '';
    else imapConfig.password = password;

    const imap = new Imap(imapConfig);
    const emails = [];
    const parsePromises = [];

    // 75s watchdog (shorter than Render’s 90s response timeout you set on server)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      finish(new Error('IMAP connection timed out'));
    }, 75000);

    if (IMAP_DEBUG) {
      imap.on('alert',  (m) => console.log('[IMAP alert]', m));
      imap.on('close',  (hadErr) => console.log('[IMAP close]', hadErr));
      imap.on('error',  (e) => console.log('[IMAP error]', e?.message || e));
    }

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) {
          clearTimeout(watchdog);
          return finish(new Error(friendlyImapError(err?.message || err, { host, email, authType })));
        }

        if (IMAP_DEBUG) {
          try { console.log('IMAP search criteria =>', JSON.stringify(criteria)); } catch {}
        }

        imap.search(criteria, (err, results = []) => {
          if (err) {
            clearTimeout(watchdog);
            return finish(new Error(friendlyImapError(err?.message || err, { host, email, authType })));
          }

          if (!Array.isArray(results) || results.length === 0) {
            clearTimeout(watchdog);
            try { imap.end(); } catch {}
            return; // 'end' resolves with []
          }

          // Only fetch the last N (most recent) messages
          const n = Math.max(0, Math.min(Number(limit) || 0, results.length)) || results.length;
          const uids = results.slice(-n);

          // Choose fetch profile based on provider
          const fetchBodies = isIcloud ? FETCH_BODIES_ICLOUD : FETCH_BODIES_FULL;

          const fetcher = imap.fetch(uids, {
            bodies: fetchBodies,
            struct: false
          });

          fetcher.on('message', (msg) => {
            let uid = null;
            let internalDate = null;

            const record = { uid };

            msg.once('attributes', (attrs) => {
              uid = attrs?.uid ?? null;
              internalDate = attrs?.date ?? null;
              record.uid = uid;
              record.internalDate = internalDate;
            });

            // iCloud light path: collect ENVELOPE + tiny TEXT
            if (isIcloud) {
              let snippet = '';
              let envelope = null;

              msg.on('body', (stream, info) => {
                const which = info?.which || '';
                const chunks = [];
                stream.on('data', (c) => chunks.push(Buffer.from(c)));
                stream.on('end', () => {
                  const buf = Buffer.concat(chunks).toString('utf8');
                  if (/ENVELOPE/i.test(which)) {
                    // ENVELOPE is returned as a string; imap lib doesn’t parse for us
                    // but simple way: rely on headers from BODY[TEXT] if present,
                    // otherwise just keep subject empty — iCloud will still send TEXT bytes.
                  } else if (/BODY\[TEXT\]</i.test(which)) {
                    snippet = buf;
                  }
                });
              });

              msg.once('end', () => {
                // We don’t have structured ENVELOPE fields parsed here;
                // so we parse the snippet headers quickly using mailparser on a tiny chunk
                const tiny = new Promise((resolve) => {
                  // Try to create a pseudo message with minimal headers if present
                  simpleParser(snippet, (err, parsed) => {
                    const item = {
                      uid,
                      internalDate,
                      subject: parsed?.subject || '(no subject)',
                      from: parsed?.from?.text || '',
                      to: parsed?.to?.text || '',
                      date: parsed?.date || internalDate || null,
                      text: parsed?.text || snippet || '',
                      html: parsed?.html || ''
                    };
                    emails.push(item);
                    resolve();
                  });
                });
                parsePromises.push(tiny);
              });
            } else {
              // Non-iCloud: full body parse as before
              msg.on('body', (stream) => {
                const p = new Promise((resolveOne) => {
                  simpleParser(stream, (err, parsed) => {
                    if (!err && parsed) {
                      emails.push({
                        uid,
                        internalDate,
                        subject: parsed.subject || '(no subject)',
                        from: parsed.from?.text || '',
                        to: parsed.to?.text || '',
                        date: parsed.date || internalDate || null,
                        text: parsed.text || '',
                        html: parsed.html || ''
                      });
                    }
                    resolveOne(); // swallow per-message parse errors
                  });
                });
                parsePromises.push(p);
              });
            }
          });

          fetcher.once('error', (e) => {
            clearTimeout(watchdog);
            finish(new Error(friendlyImapError(e?.message || e, { host, email, authType })));
          });

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
      finish(new Error(friendlyImapError(err?.message || err, { host, email, authType })));
    });

    imap.once('end', () => {
      clearTimeout(watchdog);
      finish(null, emails);
    });

    try {
      imap.connect();
    } catch (e) {
      clearTimeout(watchdog);
      finish(new Error(friendlyImapError(e?.message || e, { host, email, authType })));
    }
  });
}
