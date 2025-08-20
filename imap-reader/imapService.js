// imapService.js — fast IMAP fetch with UID pagination + two-stage fetch
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Convert JS Date to IMAP-compatible search constraints
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/**
 * fetchEmails(opts)
 * @param {Object} opts
 *  - email, password, accessToken, host, port, tls, authType
 *  - monthStart, monthEnd (ISO)  OR  rangeDays (number)
 *  - limit (int, default 20)
 *  - cursor (string, optional)  // format "UID<12345"
 */
export async function fetchEmails(opts = {}) {
  const {
    email = '', password = '', accessToken = '',
    host = '', port = 993, tls = true, authType = 'password',
    monthStart = undefined, monthEnd = undefined,
    rangeDays = 7,
    limit = 20,
    cursor = null,              // NEW: paginate older by UID
  } = opts;

  const client = new ImapFlow({
    host, port, secure: !!tls,
    auth: (String(authType).toLowerCase() === 'xoauth2')
      ? { user: email, accessToken }
      : { user: email, pass: password },
    logger: false,
  });

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock('INBOX');

    // --- Build search range
    const criteria = [];

    // Handle month window: [monthStart, monthEnd] inclusive by adding 1 day to "before"
    const hasMonth = !!monthStart && !!monthEnd;
    if (hasMonth) {
      const since = new Date(monthStart);
      const before = addDays(new Date(monthEnd), 1);
      criteria.push(['SINCE', startOfDay(since)]);
      criteria.push(['BEFORE', startOfDay(before)]);
    } else if (Number(rangeDays) > 0) {
      const since = addDays(new Date(), -Number(rangeDays));
      criteria.push(['SINCE', startOfDay(since)]);
    } // else: no time bound (not recommended)

    // UID cursor (older than)
    let uidCutoff = null;
    if (cursor && /^uid<\d+$/i.test(String(cursor))) {
      uidCutoff = Number(String(cursor).match(/\d+/)[0]);
      criteria.push(['UID', `1:${uidCutoff - 1}`]); // fetch strictly older
    }

    // ---- Stage A: fast discovery; newest first
    // We only need UIDs + ENVELOPE metadata to decide page
    // ImapFlow sorts ascending by UID; we reverse to get newest first.
    const uids = [];
    for await (const msg of client.fetch(
      { seen: false, ...criteria.length ? { or: criteria } : {} }, // criteria to search
      { uid: true, envelope: true, internalDate: true, flags: true, structure: true },
      { uid: true }
    )) {
      uids.push(msg.uid);
    }
    uids.sort((a, b) => b - a); // newest → oldest

    const pageUIDs = uids.slice(0, Math.max(1, Number(limit)));
    const hasMore = uids.length > pageUIDs.length;
    const nextCursor = hasMore ? `uid<${pageUIDs[pageUIDs.length - 1]}` : null;

    if (pageUIDs.length === 0) {
      return { items: [], hasMore: false, nextCursor: null };
    }

    // ---- Stage B: fetch minimal parts for the chosen page UIDs
    const items = [];
    const fetchOpts = {
      uid: true,
      envelope: true,
      internalDate: true,
      flags: true,
      structure: true,
      // Pull small text preview cheaply; avoid full source for speed
      source: false,
      bodyParts: [ '1.TEXT' ]
    };

    // ImapFlow can fetch by sequence set "uid1,uid2:uid3"
    const seq = pageUIDs.join(',');
    for await (const msg of client.fetch({ uid: seq }, fetchOpts)) {
      try {
        // Build a tiny snippet; fallback to subject if body not available
        const subject = (msg.envelope?.subject || '').toString();
        let snippet = '';
        if (msg.bodyParts && msg.bodyParts.get('1.TEXT')) {
          const buf = await client.download(msg.uid, '1');
          const text = await streamToText(buf, 2048);
          snippet = text.replace(/\s+/g, ' ').trim().slice(0, 280);
        }

        // sender parsing
        const fromAddr = (msg.envelope?.from && msg.envelope.from[0]) || {};
        const fromEmail = (fromAddr.address || '').toLowerCase();
        const fromDomain = fromEmail.split('@')[1] || '';
        const toAddr = (msg.envelope?.to && msg.envelope.to[0]) || {};
        const toEmail = (toAddr.address || '');

        items.push({
          id: String(msg.uid),
          uid: msg.uid,
          from: fromAddr.name || fromEmail || '',
          fromEmail,
          fromDomain,
          to: toEmail,
          subject,
          snippet,
          date: msg.internalDate ? new Date(msg.internalDate).toISOString() : '',
          unread: !msg.flags?.has('\\Seen'),
          flagged: !!msg.flags?.has('\\Flagged'),
          hasIcs: structureHasIcs(msg.structure),
          attachTypes: listAttachTypes(msg.structure),
          importance: 'unclassified' // placeholder for classifier to fill
        });
      } catch (e) {
        // Resilient: push minimal item even if parse fails
        items.push({
          id: String(msg.uid),
          uid: msg.uid,
          subject: '(parse failed)',
          snippet: '',
          date: msg.internalDate ? new Date(msg.internalDate).toISOString() : '',
          unread: !msg.flags?.has('\\Seen'),
          flagged: !!msg.flags?.has('\\Flagged'),
          importance: 'unclassified'
        });
      }
    }

    return { items, hasMore, nextCursor };
  } finally {
    try { if (lock) lock.release(); } catch {}
    try { await client.logout(); } catch {}
  }
}

function structureHasIcs(struct) {
  if (!struct) return false;
  const stack = [struct];
  while (stack.length) {
    const node = stack.pop();
    const t = `${(node.type || '').toLowerCase()}/${(node.subtype || '').toLowerCase()}`;
    if (t === 'text/calendar' || /(\.ics)$/i.test(node.parameters?.name || '')) return true;
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
    if (Array.isArray(node.parts)) stack.push(...node.parts);
  }
  return false;
}
function listAttachTypes(struct) {
  const out = [];
  if (!struct) return out;
  const stack = [struct];
  while (stack.length) {
    const node = stack.pop();
    const disp = (node.disposition || '').toLowerCase();
    const name = (node.parameters?.name || node.filename || '').toLowerCase();
    if (disp === 'attachment' || name) out.push(name || (node.subtype || '').toLowerCase());
    if (Array.isArray(node.childNodes)) stack.push(...node.childNodes);
    if (Array.isArray(node.parts)) stack.push(...node.parts);
  }
  return out.slice(0, 6);
}
async function streamToText(readable, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    readable.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    readable.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    readable.on('error', reject);
  });
}
