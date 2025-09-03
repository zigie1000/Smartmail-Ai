// imapService.js
// SmartEmail IMAP service (full file)
// - Fetch & classify messages (range/month) with optional full bodies
// - Batch body hydration
// - Test login
// Requires: imapflow, mailparser

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// --- Utilities ---------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toNumber(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function toUTCDateOnly(iso) {
  // iso -> 2025-09-03 => Date at 00:00:00Z
  if (!iso) return null;
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(t) ? new Date(t) : null;
}

function endOfDayUTC(iso) {
  if (!iso) return null;
  const t = Date.parse(iso + 'T23:59:59Z');
  return Number.isFinite(t) ? new Date(t) : null;
}

function stripHtml(x, max = 300) {
  try {
    const s = String(x || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  } catch {
    return '';
  }
}

function bestDateEpoch(headers, internalDate) {
  // Prefer Date header; fallback to internalDate
  const h = headers || {};
  const cand = h.date || h['Date'] || internalDate;
  const d = cand ? new Date(cand) : null;
  const t = d && Number.isFinite(d.getTime()) ? d.getTime() : null;
  return t ?? (internalDate ? new Date(internalDate).getTime() : null);
}

// Very light classifier (placeholder). You can swap with your own.
function classifyOne(msg) {
  const subj = (msg.subject || '').toLowerCase();
  const from = (msg.from || '').toLowerCase();
  const text = (msg.text || msg.snippet || '').toLowerCase();

  let intent = '';
  if (subj.includes('invoice') || text.includes('invoice') || text.includes('payment')) intent = 'billing';
  else if (subj.includes('meeting') || subj.includes('invite') || text.includes('zoom')) intent = 'meeting';
  else if (subj.includes('unsubscribe') || text.includes('newsletter')) intent = 'newsletter';
  else if (subj.includes('security') || subj.includes('verify') || text.includes('2fa')) intent = 'security';
  else intent = 'other';

  // toy importance/urgency
  const importance = /urgent|asap|immediately/.test(text) ? 'important' : 'unclassified';
  const urgency = /urgent|asap|immediately|reply soon/.test(text) ? 2 : 0;

  return { intent, importance, urgency };
}

// --- IMAP connection helper --------------------------------------------------

async function withImapClient(opts, fn) {
  const {
    email, password, host, port, tls,
    authType, accessToken
  } = opts;

  const client = new ImapFlow({
    host: host || 'imap.gmail.com',
    port: toNumber(port, 993),
    secure: coerceBool(tls) !== false, // default true
    auth: (String(authType || 'password').toLowerCase() === 'xoauth2')
      ? { user: email, accessToken: accessToken }
      : { user: email, pass: password },
    logger: false,
    disableAutoIdle: false
  });

  try {
    await client.connect();
    // open INBOX readonly for safety
    await client.mailboxOpen('INBOX', { readOnly: true });
    const out = await fn(client);
    try { await client.logout(); } catch {}
    return out;
  } catch (err) {
    try { await client.logout(); } catch {}
    throw err;
  }
}

// --- Search window builder ---------------------------------------------------

function buildSearch({ mode, monthStart, monthEnd, rangeDays, query }) {
  // imapflow search uses arrays, e.g. ['SINCE', new Date(...), 'BEFORE', new Date(...)]
  const crit = [];

  const hasMonth = !!(monthStart && monthEnd);
  if (hasMonth) {
    const s = toUTCDateOnly(monthStart);
    const e = endOfDayUTC(monthEnd);
    if (s) crit.push('SINCE', s);
    if (e) {
      const d2 = new Date(e.getTime() + 1000); // before is exclusive
      crit.push('BEFORE', d2);
    }
  } else {
    const days = toNumber(rangeDays, 30);
    if (days > 0) {
      const end = new Date();
      const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86400000);
      // Use local Date objects; imapflow converts to RFC822 dates
      crit.push('SINCE', new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())));
    }
    // If days === 0 => no SINCE (unbounded)
  }

  if (query && String(query).trim()) {
    // Basic subject OR from search; server-specific advanced search omitted for portability.
    const q = String(query).trim();
    crit.push(['OR', ['HEADER', 'Subject', q], ['FROM', q]]);
  }

  return crit.length ? crit : ['ALL'];
}

// --- Core fetch --------------------------------------------------------------

async function fetchEmails(params = {}) {
  const {
    email, password, host, port, tls,
    authType, accessToken,
    limit = 20,
    rangeDays,
    monthStart, monthEnd,
    query = '',
    cursor = null,      // sequence uid to continue from
    fullBodies = false, // <-- honored for range & month
    includePreview = true,
    includeSnippet = true,
    includeBody = false // legacy switch; ignored when fullBodies = true
  } = params;

  const mode = (monthStart && monthEnd) ? 'month' : 'range';

  const MAX = Math.max(1, toNumber(limit, 20));

  return await withImapClient(
    { email, password, host, port, tls, authType, accessToken },
    async (client) => {

      // Build criteria and sort newest first (by UID)
      const criteria = buildSearch({ mode, monthStart, monthEnd, rangeDays, query });

      // Resolve matching UIDs
      let uids = await client.search(criteria, { uid: true });
      uids.sort((a, b) => b - a); // newest first

      // Paging: if cursor provided, continue *after* that uid
      let startIndex = 0;
      if (cursor) {
        const c = toNumber(cursor);
        if (c) {
          startIndex = uids.findIndex(u => u < c);
          if (startIndex < 0) startIndex = uids.length; // nothing older
        }
      }

      const pageUids = uids.slice(startIndex, startIndex + MAX);
      const nextCursor = (startIndex + MAX < uids.length) ? pageUids[pageUids.length - 1] : null;
      const hasMore = !!nextCursor;

      const wantBody = !!fullBodies || !!includeBody;

      // Fields to fetch
      const fetchOpts = {
        uid: true,
        source: wantBody,                 // raw message stream
        envelope: true,
        internalDate: true,
        bodyStructure: false
      };

      // If no fullBodies, still try to get small text parts for preview
      const previewOpts = {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
        source: false
      };

      const emails = [];

      if (wantBody) {
        // FULL bodies path
        for await (const msg of client.fetch(pageUids, fetchOpts)) {
          let text = '';
          let html = '';
          try {
            const parsed = await simpleParser(msg.source);
            text = parsed.text || '';
            html = parsed.html || '';
          } catch (_) {}

          const from = (msg.envelope?.from && msg.envelope.from.map(a => a.name || a.address).join(', ')) || '';
          const fromEmail = (msg.envelope?.from && msg.envelope.from[0]?.address) || '';
          const fromDomain = fromEmail.split('@')[1] || '';

          const snippet = includeSnippet ? (text ? text.slice(0, 280) : stripHtml(html, 280)) : '';

          const one = {
            id: msg.uid,
            uid: msg.uid,
            subject: msg.envelope?.subject || '',
            from,
            fromEmail,
            fromDomain,
            date: bestDateEpoch({ date: msg.envelope?.date }, msg.internalDate),
            snippet,
            preview: snippet,
            text,
            html
          };
          Object.assign(one, classifyOne(one));
          emails.push(one);
        }
      } else {
        // Lightweight preview path
        // Grab envelope + structure; then request the first small text part for a snippet.
        for await (const msg of client.fetch(pageUids, previewOpts)) {
          const from = (msg.envelope?.from && msg.envelope.from.map(a => a.name || a.address).join(', ')) || '';
          const fromEmail = (msg.envelope?.from && msg.envelope.from[0]?.address) || '';
          const fromDomain = fromEmail.split('@')[1] || '';

          let snippet = '';
          if (includePreview || includeSnippet) {
            // Try TEXT/PLAIN first, then TEXT/HTML; limit bytes
            const bs = msg.bodyStructure;
            let plainPart = null, htmlPart = null;

            const walk = (node) => {
              if (!node) return;
              if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
              if (node.type === 'text') {
                if (node.subtype === 'plain' && !plainPart) plainPart = node;
                if (node.subtype === 'html'  && !htmlPart)  htmlPart = node;
              }
            };
            walk(bs);

            let previewBuf = null;
            try {
              if (plainPart) {
                previewBuf = await client.download(msg.uid, plainPart.part);
              } else if (htmlPart) {
                previewBuf = await client.download(msg.uid, htmlPart.part);
              }
            } catch (_) {}

            if (previewBuf && previewBuf.content) {
              const raw = previewBuf.content.toString('utf8');
              snippet = plainPart ? raw.slice(0, 280) : stripHtml(raw, 280);
            }
          }

          const one = {
            id: msg.uid,
            uid: msg.uid,
            subject: msg.envelope?.subject || '',
            from,
            fromEmail,
            fromDomain,
            date: bestDateEpoch({ date: msg.envelope?.date }, msg.internalDate),
            snippet,
            preview: snippet
          };
          Object.assign(one, classifyOne(one));
          emails.push(one);
        }
      }

      return {
        emails,
        nextCursor,
        hasMore,
        tier: 'premium',
        notice: false
      };
    }
  );
}

// --- Batch full bodies -------------------------------------------------------

async function fetchBodiesBatch(params = {}) {
  const {
    email, password, host, port, tls,
    authType, accessToken,
    ids = [],
    monthStart, monthEnd,
    rangeDays
  } = params;

  if (!Array.isArray(ids) || !ids.length) return { items: [] };

  return await withImapClient(
    { email, password, host, port, tls, authType, accessToken },
    async (client) => {
      // Optional: apply the same search window to avoid fetching bodies outside the window
      const criteria = buildSearch({
        mode: (monthStart && monthEnd) ? 'month' : 'range',
        monthStart, monthEnd, rangeDays
      });

      let allowed = null;
      try {
        allowed = new Set(await client.search(criteria, { uid: true }));
      } catch (_) {
        allowed = null; // ignore if search fails; proceed with ids
      }

      const want = allowed ? ids.filter(u => allowed.has(Number(u))) : ids;

      const items = [];
      for await (const msg of client.fetch(want, { uid: true, source: true, envelope: true, internalDate: true })) {
        let text = '';
        let html = '';
        try {
          const parsed = await simpleParser(msg.source);
          text = parsed.text || '';
          html = parsed.html || '';
        } catch (_) {}

        items.push({
          id: msg.uid,
          uid: msg.uid,
          subject: msg.envelope?.subject || '',
          date: bestDateEpoch({ date: msg.envelope?.date }, msg.internalDate),
          text,
          html,
          snippet: text ? text.slice(0, 280) : stripHtml(html, 280)
        });

        // Gentle pacing to avoid rate spikes on some providers
        if (items.length % 10 === 0) await sleep(25);
      }

      return { items };
    }
  );
}

// --- Test login --------------------------------------------------------------

async function testLogin(params = {}) {
  const {
    email, password, host, port, tls,
    authType, accessToken
  } = params;

  await withImapClient(
    { email, password, host, port, tls, authType, accessToken },
    async (client) => {
      // simple NOOP: list mailbox to assert access
      await client.mailboxOpen('INBOX', { readOnly: true });
    }
  );

  return { ok: true };
}

// --- Exports -----------------------------------------------------------------

module.exports = {
  fetchEmails,
  fetchBodiesBatch,
  testLogin
};
