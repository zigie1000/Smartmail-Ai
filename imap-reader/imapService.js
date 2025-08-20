// imapService.js (ESM) — drop-in replacement
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Connect helper
async function createClient({ host, port = 993, tls = true, authType = 'password', email, password, accessToken }) {
  const client = new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: !!tls,
    auth: (String(authType).toLowerCase() === 'xoauth2')
      ? { user: email, accessToken: accessToken }
      : { user: email, pass: password },
    logger: false
  });

  await client.connect();
  // Select INBOX
  await client.mailboxOpen('INBOX');
  return client;
}

// Convert ImapFlow envelope to our UI schema
function envelopeToModel(msg) {
  const fromAddr = (msg.envelope?.from && msg.envelope.from[0]) || {};
  const fromName = (fromAddr.name || '').toString();
  const fromEmail = (fromAddr.address || '').toString();

  const subject = (msg.envelope?.subject || '').toString();
  const date = msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString();

  return {
    id: String(msg.uid ?? msg.seq),
    uid: msg.uid,
    subject,
    from: fromName || fromEmail,
    fromEmail,
    to: (msg.envelope?.to && msg.envelope.to[0]?.address) || '',
    date,
    importance: 'unclassified',
    intent: '',
    urgency: 0,
    action_required: false,
    isVip: false,
    snippet: (msg.snippet || '').trim()
  };
}

// Fetch first text/plain or text/html part to make snippet
async function addSnippet(client, uid, base) {
  try {
    // Try BODY[] first few KB
    const source = await client.download(uid);
    if (!source) return base;
    const parsed = await simpleParser(source.content);
    const text = (parsed.text || parsed.html || '').toString().replace(/<[^>]+>/g, ' ');
    base.snippet = text.substring(0, 400);
  } catch (e) {
    // ignore
  }
  return base;
}

// Build search criteria dates
function buildDateCriteria({ rangeDays, monthStart, monthEnd }) {
  const criteria = ['ALL'];
  if (monthStart) {
    criteria.push(['SINCE', new Date(monthStart)]);
  } else if (rangeDays && Number(rangeDays) > 0) {
    const since = new Date(Date.now() - Number(rangeDays) * 24 * 3600 * 1000);
    criteria.push(['SINCE', since]);
  }
  if (monthEnd) {
    const before = new Date(new Date(monthEnd).getTime() + 24 * 3600 * 1000);
    criteria.push(['BEFORE', before]);
  }
  return criteria;
}

// Route handler: POST /api/imap/fetch
export async function fetchEmails(req, res) {
  const {
    email, password, host, port, tls = true,
    authType = 'password', accessToken = '',
    rangeDays = 7, monthStart, monthEnd,
    limit = 20, cursor
  } = req.body || {};

  if (!email || !host) {
    return res.status(400).json({ error: 'email and host are required' });
  }

  let client;
  try {
    client = await createClient({ host, port, tls, authType, email, password, accessToken });

    const criteria = buildDateCriteria({ rangeDays, monthStart, monthEnd });
    const uidListRaw = await client.search(criteria, { uid: true });

    // Ensure it's an array of numbers
    const uidList = Array.isArray(uidListRaw) ? uidListRaw.map(Number).filter(n => Number.isFinite(n)) : [];

    // Sort by UID descending (approx chronological)
    uidList.sort((a, b) => b - a);

    // Pagination based on cursor (uid of last item previously returned)
    let startIndex = 0;
    if (cursor) {
      const idx = uidList.indexOf(Number(cursor));
      startIndex = idx >= 0 ? idx + 1 : 0;
    }

    const slice = uidList.slice(startIndex, startIndex + Number(limit || 20));
    const msgList = [];
    for await (const msg of client.fetch(slice, { uid: true, envelope: true, internalDate: true, source: false })) {
      msgList.push(msg);
    }

    // Map to our model and add snippet (best-effort)
    const emails = [];
    for (const m of msgList) {
      let model = envelopeToModel(m);
      // try to add a snippet for the first few emails only to save time
      model = await addSnippet(client, m.uid, model);
      emails.push(model);
    }

    const more = startIndex + slice.length < uidList.length;
    const nextCursor = more ? String(slice[slice.length - 1]) : null;

    await client.logout();
    res.json({
      ok: true,
      emails,
      nextCursor,
      notice: more ? null : 'End of results'
    });
  } catch (err) {
    try { if (client) await client.logout(); } catch {}
    res.status(500).json({ error: `IMAP fetch error: ${err.message || String(err)}` });
  }
}

// Route handler: POST /api/imap/test
export async function testLogin(req, res) {
  const { email, password, host, port, tls = true, authType = 'password', accessToken = '' } = req.body || {};
  if (!email || !host) return res.status(400).json({ error: 'email and host are required' });

  let client;
  try {
    client = await createClient({ host, port, tls, authType, email, password, accessToken });
    const mailbox = await client.mailboxOpen('INBOX');
    await client.logout();

    res.json({ ok: true, mailbox: mailbox?.path || 'INBOX' });
  } catch (err) {
    try { if (client) await client.logout(); } catch {}
    res.status(500).json({ error: `Login failed: ${err.message || String(err)}` });
  }
}
