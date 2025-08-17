// services/imapService.js
import imaps from 'imap-simple';

/** Build IMAP search criteria safely */
function buildCriteria({ daysRange }) {
  const criteria = ['ALL']; // start permissive
  if (typeof daysRange === 'number' && daysRange > 0) {
    const sinceDate = new Date(Date.now() - daysRange * 24 * 60 * 60 * 1000);
    // imap-simple expects: ['SINCE', Date]
    criteria.push(['SINCE', sinceDate]);
  }
  return criteria;
}

/** Fetch headers from IMAP with strict resource hygiene */
export async function fetchEmails({
  host,
  port = 993,
  tls = true,
  user,
  password,
  daysRange = 7,   // Premium -> 30, Free -> 7 (route layer sets it)
  limit = 20,      // enforced in route
}) {
  const config = {
    imap: {
      user,
      password,
      host,
      port,
      tls,
      authTimeout: 10000,
      // IMPORTANT: remove custom CA; keep default system store
      // Fixes DEPTH_ZERO_SELF_SIGNED_CERT on Render
      tlsOptions: { rejectUnauthorized: true, servername: host },
    },
  };

  let connection;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX', true);

    const criteria = buildCriteria({ daysRange });

    // Only fetch lightweight headers + structure to avoid OOM
    const fetchOptions = {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
      markSeen: false,
      struct: true,
    };

    const messages = await connection.search(criteria, fetchOptions);

    // Shape result, clamp to limit
    const items = messages.slice(0, Math.max(0, limit)).map((m) => {
      const header = m.parts.find(p => p.which.startsWith('HEADER')).body || {};
      return {
        uid: m.attributes?.uid,
        date: header.date?.[0] ?? m.attributes?.date,
        from: header.from?.[0] ?? '',
        to: header.to?.[0] ?? '',
        subject: header.subject?.[0] ?? '(no subject)',
        // keep raw attributes needed for later fetch of body if user selects it
        attributes: {
          uid: m.attributes?.uid,
          flags: m.attributes?.flags ?? [],
          date: m.attributes?.date ?? null,
        },
      };
    });

    return { ok: true, items };
  } catch (err) {
    // Normalize the common errors you hit so UI can show a clear message
    if (String(err?.message || '').includes('Incorrect number of arguments for search option: SINCE')) {
      return { ok: false, code: 'BAD_SINCE', message: 'Server rejected SINCE criteria.' };
    }
    if (String(err?.code || '').includes('DEPTH_ZERO_SELF_SIGNED_CERT')) {
      return { ok: false, code: 'TLS', message: 'TLS trust chain failed (self-signed).' };
    }
    if (String(err?.message || '').includes('timed out')) {
      return { ok: false, code: 'TIMEOUT', message: 'Connection timed out.' };
    }
    return { ok: false, code: 'IMAP', message: err?.message || 'IMAP error' };
  } finally {
    try { if (connection) await connection.end(); } catch {}
  }
}
