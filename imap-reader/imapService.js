// imapService.js
import Imap from 'imap-simple';
import libmime from 'libmime';

// Configuration for IMAP connection
const buildConfig = (account) => ({
  imap: {
    user: account.email,
    password: account.password,
    host: account.imapHost || 'imap.gmail.com',
    port: account.port || 993,
    tls: account.tls !== false,
    authTimeout: 10000,
  }
});

// Decode MIME-encoded words (handles =?UTF-8?...?= subjects, etc.)
const decodeHeader = (val) => {
  if (!val) return '';
  try {
    return libmime.decodeWords(String(val));
  } catch {
    return String(val);
  }
};

// Fetch emails
export async function fetchEmails(account, criteria = ['ALL'], limit = 20) {
  let connection;
  try {
    const config = buildConfig(account);
    connection = await Imap.connect(config);
    await connection.openBox('INBOX');

    // Criteria passed to IMAP (default: ALL)
    const searchCriteria = criteria;

    // Options: only headers + plain text
    const fetchOptions = {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
      struct: true,
      markSeen: false,
    };

    // Run the search
    const results = await connection.search(searchCriteria, fetchOptions);

    // Map results -> normalized items
    const items = results.slice(0, limit).map((res) => {
      const parts = res.parts || [];
      const headerPart = parts.find((p) => /^HEADER/i.test(p.which));
      const textPart = parts.find((p) => /^TEXT$/i.test(p.which));

      const hdr = (headerPart && headerPart.body) || {};
      const fromRaw = hdr.from ? hdr.from[0] : '';
      const subjectRaw = hdr.subject ? hdr.subject[0] : '';
      const dateRaw = hdr.date ? hdr.date[0] : null;

      // Body text (truncate to prevent OOM)
      let body = '';
      if (textPart?.body) {
        body = String(textPart.body);
        if (body.length > 50000) {
          body = body.slice(0, 50000); // cap at 50KB
        }
      }

      return {
        uid: res.attributes?.uid,
        id: res.attributes?.uid,
        from: decodeHeader(fromRaw),
        subject: decodeHeader(subjectRaw) || '(no subject)',
        date: dateRaw ? new Date(dateRaw).toISOString() : null,
        text: body,
        snippet: body.slice(0, 220),
        // leave importance/intent/urgency fields untouched so classifier works
        importance: res.importance || undefined,
        intent: res.intent || undefined,
        urgency: res.urgency ?? undefined,
      };
    });

    return { items, hasMore: results.length > limit };
  } catch (err) {
    console.error('IMAP fetch error:', err);
    throw err;
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (e) {
        console.warn('Error closing IMAP connection:', e);
      }
    }
  }
}
