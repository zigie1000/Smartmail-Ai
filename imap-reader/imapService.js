// imapService.js — wraps imap-simple with safer defaults
// - Fixes: IMAP "SINCE" must be a Date (server will format to DD-MMM-YYYY)
// - Memory safety: fetch HEADERS only, cap results, sort+slice on server
// - TLS: optional self-signed control via IMAP_ALLOW_SELF_SIGNED=1
// - Timeouts & keepalive tuned for flaky/free hosting

import imaps from 'imap-simple';
import dns from 'dns';

// Prefer IPv4 first (avoids some provider DNS oddities on free hosts)
dns.setDefaultResultOrder?.('ipv4first');

const ALLOW_SELF_SIGNED = (process.env.IMAP_ALLOW_SELF_SIGNED === '1');

// ---- Helpers ---------------------------------------------------------------

// Parse user-provided "since" (string/number/Date) into a Date, or null.
function toDateOrNull(input) {
  if (!input) return null;
  if (input instanceof Date && !isNaN(input)) return input;
  const d = new Date(input);
  return isNaN(d) ? null : d;
}

// Decide a SINCE date from { since, rangeDays } with safe defaults.
// If nothing provided, use 2 days by default (matches your UI default).
function decideSinceDate({ since, rangeDays }) {
  const fromProp = toDateOrNull(since);
  if (fromProp) return fromProp;

  const days = Number.isFinite(rangeDays) ? Number(rangeDays) : 2;
  const ms = Math.max(1, days) * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms);
}

// Extract a single header string safely
function pick(h, key, fallback = '') {
  if (!h) return fallback;
  const v = h[key];
  if (!v) return fallback;
  if (Array.isArray(v)) return (v[0] ?? fallback) + '';
  return (v ?? fallback) + '';
}

// Build imap-simple config
function buildConfig({
  email,
  password,
  accessToken,
  host,
  port = 993,
  tls = true,
  authType = 'password',
}) {
  const xoauth2 =
    authType?.toLowerCase() === 'xoauth2' && accessToken ? accessToken : undefined;

  const tlsOptions = {};
  if (ALLOW_SELF_SIGNED) {
    // When your environment sets IMAP_ALLOW_SELF_SIGNED=1, accept self-signed.
    tlsOptions.rejectUnauthorized = false;
  }
  if (host) tlsOptions.servername = host;

  return {
    imap: {
      user: email,
      password: xoauth2 ? undefined : password,
      xoauth2,
      host,
      port,
      tls,
      tlsOptions,

      // ---- Connection + auth timeouts ----
      connTimeout: 20_000,   // 20s TCP connect
      authTimeout: 20_000,   // 20s login
      socketTimeout: 60_000, // 60s inactivity

      // ---- Keepalive to avoid idle disconnects ----
      keepalive: {
        interval: 3_000,     // NOOP every 3s
        idleInterval: 300_000, // 5min max idle
        forceNoop: true,
      },
    },
  };
}

// Ensure connection closes even on error
async function withConnection(config, fn) {
  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');
    return await fn(connection);
  } finally {
    try { await connection?.end(); } catch {}
  }
}

// ---- Public API ------------------------------------------------------------

// Lightweight login check (no message fetch).
export async function testLogin(opts) {
  const config = buildConfig(opts);
  return await withConnection(config, async () => ({ ok: true }));
}

/**
 * Fetch message headers safely.
 *
 * Expected opts (all optional except creds):
 *  - email, password OR accessToken+authType='xoauth2'
 *  - host (e.g. 'imap.gmail.com'), port (default 993), tls (default true)
 *  - rangeDays (number) or since (Date/ISO string)
 *  - limit (number) default 50
 *
 * Returns: { ok, items: [ { uid, subject, from, to, date, flags } ], stats }
 */
export async function fetchMail(opts) {
  const {
    email, password, accessToken, host, port = 993, tls = true, authType = 'password',
    rangeDays, since, limit: rawLimit,
  } = opts || {};

  const limit = (Number(rawLimit) > 0 && Number(rawLimit) <= 200) ? Number(rawLimit) : 50;
  const sinceDate = decideSinceDate({ since, rangeDays });

  const config = buildConfig({ email, password, accessToken, host, port, tls, authType });

  const fetchOptions = {
    // HEADERS only — keeps memory low. Body/snippet can be fetched on-demand per UID elsewhere.
    bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
    struct: true,
    markSeen: false,
  };

  // Build server-side criteria. Using a Date object ensures correct IMAP format.
  const criteria = ['ALL', ['SINCE', sinceDate]];

  // Do all work inside a single connection.
  return await withConnection(config, async (conn) => {
    // Step 1: search UIDs only (no bodies) to avoid fetching too much
    const uids = await new Promise((resolve, reject) => {
      conn.imap.search(criteria, (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
      });
    });

    // If no messages, return fast.
    if (!uids.length) {
      return {
        ok: true,
        items: [],
        stats: { totalFound: 0, fetched: 0, since: sinceDate.toISOString(), limit },
      };
    }

    // Only fetch the newest N UIDs (server returns ascending order by UID)
    const slice = uids.slice(-limit);

    // Step 2: fetch headers for those UIDs
    const items = await new Promise((resolve, reject) => {
      const out = [];
      const f = conn.imap.fetch(slice, fetchOptions);

      f.on('message', (msg) => {
        let headerObj = null;
        let attrs = null;

        msg.on('attributes', (a) => { attrs = a; });

        msg.on('body', (stream/* , info */) => {
          // imap-simple/node-imap returns header as RFC822 text — parse with imaps library helper
          let buf = '';
          stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
          stream.once('end', () => {
            // imap-simple exposes .getParts helpers, but for a single HEADER we can parse quickly:
            // Use imaps to do it reliably:
            try {
              headerObj = imaps.getHeaders(buf);
            } catch {
              // minimal fallback: very rough parse
              headerObj = {};
              buf.split(/\r?\n/).forEach((line) => {
                const m = /^([\w-]+):\s*(.*)$/.exec(line);
                if (m) {
                  const k = m[1].toLowerCase();
                  headerObj[k] = headerObj[k] || [];
                  headerObj[k].push(m[2]);
                }
              });
            }
          });
        });

        msg.once('end', () => {
          const h = headerObj || {};
          // Prefer header date; fall back to attributes.date if needed
          const dateStr = pick(h, 'date', '') || (attrs?.date ? new Date(attrs.date).toUTCString() : '');
          const parsedDate = toDateOrNull(dateStr) || (attrs?.date ? new Date(attrs.date) : null);

          out.push({
            uid: attrs?.uid ?? null,
            flags: attrs?.flags ?? [],
            date: parsedDate ? parsedDate.toISOString() : null,
            subject: pick(h, 'subject', '(no subject)'),
            from: pick(h, 'from', ''),
            to: pick(h, 'to', ''),
          });
        });
      });

      f.once('error', reject);
      f.once('end', () => resolve(out));
    });

    // Sort newest → oldest just in case server order differs; ensure limit is respected.
    items.sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) : 0;
      const tb = b.date ? Date.parse(b.date) : 0;
      return tb - ta;
    });

    return {
      ok: true,
      items: items.slice(0, limit),
      stats: {
        totalFound: uids.length,
        fetched: Math.min(items.length, limit),
        since: sinceDate.toISOString(),
        limit,
      },
    };
  });
}
