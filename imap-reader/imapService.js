// imap-reader/imapService.js — precise error reasons + optional debug
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';

// ✅ Local root CA bundle (kept; safe on Render)
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject(); // updates the global https agent

dotenv.config();

const IMAP_DEBUG = String(process.env.IMAP_DEBUG || '').toLowerCase() === 'true';

/**
 * Normalize/validate IMAP search criteria so the `imap` library
 * always receives the correct nested shape:
 *   Good: [ ['SINCE', Date] ]
 *   Also OK: ['ALL', ['SINCE', Date]]
 */
function normalizeCriteria(raw) {
  if (!raw) return ['ALL'];

  // Single SINCE pair
  if (Array.isArray(raw) && String(raw[0]).toUpperCase() === 'SINCE') {
    let v = raw[1];
    if (!(v instanceof Date)) v = new Date(v);
    if (isNaN(v.getTime())) return ['ALL'];
    return [['SINCE', v]];
  }

  // Mixed criteria
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

/** Map low-level IMAP errors to human-readable reasons (no secrets) */
function friendlyImapError(msg = '', ctx = {}) {
  const s = String(msg || '');
  const host = String(ctx.host || '');
  const email = String(ctx.email || '');
  const authType = String(ctx.authType || 'password');

  const isIcloud =
    /imap\.mail\.me\.com/i.test(host) ||
    /@(icloud\.com|me\.com|mac\.com)$/i.test(email);

  // Authentication / login errors
  if (/AUTHENTICATIONFAILED|Invalid credentials|login failed|AUTHENTICATION FAILED/i.test(s)) {
    if (isIcloud && authType !== 'xoauth2') {
      return 'Authentication Failed — iCloud requires an App-Specific Password when 2FA is enabled. Generate one at appleid.apple.com → Sign-In & Security → App-Specific Passwords.';
    }
    return 'Authentication Failed (check username and password/app password)';
  }

  if (/ENOTFOUND|getaddrinfo|hostname|not found/i.test(s)) return 'IMAP host not found';
  if (/self signed|certificate|unable to verify|hostname\/IP.*certificate/i.test(s))
    return 'TLS certificate validation failed';
  if (/timed out|timeout/i.test(s)) return 'IMAP connection timed out';
  if (/Too many simultaneous connections/i.test(s))
    return 'Too many simultaneous IMAP connections';
  if (/rate limit|temporarily unavailable/i.test(s))
    return 'IMAP rate limited or temporarily unavailable';

  return s;
}

/** Minimal login test (no fetch) */
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
      user: String(email || '').trim(),
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: {
        rejectUnauthorized: true,
        servername: host,     // SNI: important for iCloud
        ca: rootCas,
        minVersion: 'TLSv1.2' // enforce modern TLS
      },
      // More patient on hosted platforms (Apple can be slow)
      connTimeout: 60000,
      authTimeout: 60000,
      keepalive: { interval: 300000, idleInterval: 300000, forceNoop: true }
    };
    if (authType === 'xoauth2') imapConfig.xoauth2 = accessToken || password || '';
    else imapConfig.password = password;

    const imap = new Imap(imapConfig);

    const fail = (e) => reject(new Error(friendlyImapError(e?.message || e, { host, email, authType })));
    const done = () => {
      try { imap.end(); } catch {}
      resolve(true);
    };

    if (IMAP_DEBUG) {
      imap.on('alert', (m) => console.log('[IMAP alert]', m));
      imap.on('close', (hadErr) => console.log('[IMAP close]', hadErr));
      imap.on('ready', () => console.log('[IMAP ready] login OK'));
      imap.on('error', (e) => console.log('[IMAP error]', e?.message || e));
    }

    imap.once('error', fail);
    imap.once('ready', () => done());

    try {
      imap.connect();
    } catch (e) {
      fail(e);
    }
  });
}

/** Full fetch with parsing */
export async function fetchEmails({
  email,
  password,          // password or XOAUTH2 token (see authType)
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

    criteria = normalizeCriteria(criteria);

    const imapConfig = {
      user: String(email || '').trim(),
      host,
      port: Number(port) || 993,
      tls: !!tls,
      tlsOptions: {
        rejectUnauthorized: true,
        servername: host,     // SNI
        ca: rootCas,
        minVersion: 'TLSv1.2'
      },
      connTimeout: 60000,
      authTimeout: 60000,
      keepalive: { interval: 300000, idleInterval: 300000, forceNoop: true }
    };
    if (authType === 'xoauth2') imapConfig.xoauth2 = accessToken || password || '';
    else imapConfig.password = password;

    const imap = new Imap(imapConfig);
    const emails = [];
    const parsers = [];

    // Server-side watchdog (allow slow Apple handshakes but don't hang forever)
    const watchdog = setTimeout(() => {
      try { imap.end(); } catch {}
      finish(new Error('IMAP connection timed out'));
    }, 90000);

    if (IMAP_DEBUG) {
      imap.on('alert', (m) => console.log('[IMAP alert]', m));
      imap.on('close', (hadErr) => console.log('[IMAP close]', hadErr));
      imap.on('error', (e) => console.log('[IMAP error]', e?.message || e));
    }

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) {
          clearTimeout(watchdog);
          return finish(new Error(friendlyImapError(err?.message || err, { host, email, authType })));
        }

        if (IMAP_DEBUG) {
          try { console.log('IMAP search criteria (final) =>', JSON.stringify(criteria)); } catch {}
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
                      to: parsed.to?.text || '',
                      date: parsed.date || internalDate || null,
                      text: parsed.text || '',
                      html: parsed.html || ''
                    });
                  }
                  res(); // swallow single-message parse errors
                });
              });
              parsers.push(p);
            });
          });

          fetcher.once('error', (e) => {
            clearTimeout(watchdog);
            finish(new Error(friendlyImapError(e?.message || e, { host, email, authType })));
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
