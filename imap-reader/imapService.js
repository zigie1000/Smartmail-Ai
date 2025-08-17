// imapService.js — stable, OOM-safe, classifier-friendly
import Imap from 'imap-simple';
import libmime from 'libmime';

// ---- helpers ---------------------------------------------------------------

function rfc3501Date(d) {
  // IMAP expects e.g. 17-Aug-2025 (UTC date is fine; server interprets local)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dt = new Date(d);
  const day = String(dt.getDate()).padStart(2, '0');
  return `${day}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
}

function decodeHeader(val) {
  if (!val) return '';
  try { return libmime.decodeWords(String(val)); } catch { return String(val); }
}

function htmlToText(html) {
  try {
    // very light, no deps: strip tags & collapse whitespace
    return String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  } catch { return ''; }
}

function buildConfig({
  email, password, accessToken, host = 'imap.gmail.com', port = 993,
  tls = true, authType = 'password'
}) {
  const cfg = {
    imap: {
      user: email,
      host, port, tls: !!tls,
      authTimeout: 20000,
      connTimeout: 20000,
      socketTimeout: 60000
    }
  };
  if (authType === 'password') {
    cfg.imap.password = password;
  } else if (authType === 'xoauth2' && accessToken) {
    // imap-simple passes xoauth2 token through to node-imap
    cfg.imap.xoauth2 = accessToken;
  }
  return cfg;
}

function buildCriteria({ rangeDays }) {
  if (Number.isFinite(rangeDays) && rangeDays > 0) {
    const since = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);
    return ['ALL', ['SINCE', rfc3501Date(since)]];
  }
  return ['ALL'];
}

// Extract best-effort plain text from fetched parts
function extractText(parts) {
  const textPart = parts.find(p => /^TEXT$/i.test(p.which));
  if (textPart?.body) return String(textPart.body);

  // Sometimes we only get BODY[] as one giant chunk; fall back, but cap size.
  const bodyPart = parts.find(p => /^BODY\[\]$/i.test(p.which));
  if (bodyPart?.body) {
    const asText = htmlToText(bodyPart.body);
    return asText || String(bodyPart.body);
  }
  return '';
}

// ---- API -------------------------------------------------------------------

export async function fetchEmails(
  account,                    // { email, password|accessToken, host, port, tls, authType }
  { rangeDays = 0, limit = 20 } = {}
) {
  let conn;
  try {
    const config = buildConfig(account);
    const criteria = buildCriteria({ rangeDays });

    conn = await Imap.connect(config);
    await conn.openBox('INBOX');

    // Keep it small: headers + TEXT + BODY[] (fallback). No attachments.
    const fetchOptions = {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT', 'BODY[]'],
      struct: true,
      markSeen: false
    };

    const results = await conn.search(criteria, fetchOptions);

    // Normalize and cap sizes to avoid OOM on free dynos
    const MAX_BODY = 70_000; // ~70KB body cap
    const items = results.slice(0, Math.max(0, limit)).map(msg => {
      const parts = msg.parts || [];
      const header = parts.find(p => /^HEADER/i.test(p.which))?.body || {};
      const fromRaw = header.from?.[0] || '';
      const subjectRaw = header.subject?.[0] || '';
      const dateRaw = header.date?.[0] || null;

      let body = extractText(parts);
      if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

      const subject = decodeHeader(subjectRaw) || '(no subject)';

      return {
        id: msg.attributes?.uid,
        uid: msg.attributes?.uid,
        from: decodeHeader(fromRaw),
        subject,
        date: dateRaw ? new Date(dateRaw).toISOString() : null,
        text: body,
        snippet: body.slice(0, 220),

        // leave these undefined so your classifier can populate them later
        importance: undefined,
        intent: undefined,
        urgency: undefined
      };
    });

    return { items, hasMore: results.length > limit };
  } catch (err) {
    console.error('IMAP fetch error:', err);
    throw err;
  } finally {
    if (conn) {
      try { await conn.end(); } catch (e) { /* ignore */ }
    }
  }
}

export async function testLogin(account) {
  let conn;
  try {
    const config = buildConfig(account);
    conn = await Imap.connect(config);
    await conn.getBoxes();
    return true;
  } catch (e) {
    console.error('testLogin error:', e?.message || e);
    return false;
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
}
