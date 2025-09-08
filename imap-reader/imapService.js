// imap-reader/imapService.js
// ESM-only. Works with "type":"module" in package.json

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// helper: extract domain from an email address
function domainOf(addr = "") {
  const i = String(addr).indexOf("@");
  return i > -1 ? String(addr).slice(i + 1).toLowerCase().trim() : "";
}

/**
 * Create a connected ImapFlow client.
 */
async function connectClient({ host, port = 993, tls = true, authType = "password", email, password, accessToken }) {
  const auth =
    String(authType || "password").toLowerCase() === "xoauth2"
      ? { user: email, accessToken, method: "XOAUTH2" }
      : { user: email, pass: password };

  const client = new ImapFlow({
    host,
    port: Number(port || 993),
    secure: !!tls,
    auth,
    // gzip/deflate helps at scale; imapflow enables when server supports COMPRESS
    logger: false,
  });

  await client.connect();
  await client.mailboxOpen("INBOX");
  return client;
}

/**
 * Build an ImapFlow search object for month/range windows.
 * - If monthStart/monthEnd provided → use since/before (end+1d)
 * - Else if rangeDays > 0 → since end-of-today - (rangeDays-1)
 * - Else (0 or invalid) → no date filter (unbounded)
 */
function buildSearchWindow({ monthStart, monthEnd, rangeDays }) {
  const out = {};
  const endOfTodayUTC = (() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  })();

  if (monthStart && monthEnd) {
    // since = monthStartT00:00Z, before = (monthEnd + 1d)T00:00Z
    const s = new Date(`${monthStart}T00:00:00Z`);
    const e = new Date(`${monthEnd}T00:00:00Z`);
    if (!isNaN(s) && !isNaN(e)) {
      const before = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate() + 1, 0, 0, 0, 0));
      out.since = s;
      out.before = before;
      return out;
    }
  }

  const n = Number(rangeDays);
  if (Number.isFinite(n) && n > 0) {
    // end = endOfToday; start = end - (n-1) days
    const start = new Date(endOfTodayUTC.getTime() - (Math.max(1, n) - 1) * 86400000);
    out.since = start;
    // no 'before' keeps up to today
    return out;
  }

  // unbounded (dangerous on huge mailboxes, but allowed)
  return out;
}

/**
 * Fetch emails. Always returns newest-first limited page.
 * Supports:
 *  - range mode (rangeDays)
 *  - month mode (monthStart, monthEnd)
 *  - simple cursor (base64 JSON { offset })
 *  - fullBodies: when true, parse text/html; otherwise lightweight ENVELOPE/FLAGS
 */
export async function fetchEmails({
  auth = {},
  search = {},
  limit = 20,
  cursor = null,
  fullBodies = true,
}) {
  const client = await connectClient(auth);

  try {
    // 1) Find matching UIDs (ascending by spec); turn into newest-first list
    const window = buildSearchWindow(search);
    // ImapFlow can take an object with { since, before }
    const uidsAsc = await client.search(window); // returns numeric UIDs ascending
    const uids = Array.isArray(uidsAsc) ? uidsAsc.slice().reverse() : []; // newest first

    // 2) Cursor math
    const lim = Math.max(1, Number(limit || 20));
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
        if (decoded && Number.isFinite(decoded.offset)) offset = decoded.offset;
      } catch {
        // ignore bad cursor
      }
    }

    const pageUids = uids.slice(offset, offset + lim);
    const nextOffset = offset + pageUids.length;
    const nextCursor = nextOffset < uids.length
      ? Buffer.from(JSON.stringify({ offset: nextOffset }), "utf8").toString("base64")
      : null;

    // 3) Fetch metadata/bodies for the page
    const items = [];
    if (!pageUids.length) {
      return { emails: [], nextCursor: null };
    }

    // Choose fetch options
    const fetchOpts = fullBodies
      ? { uid: true, source: true, envelope: true, flags: true, internalDate: true }
      : { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: false };

    for await (const msg of client.fetch(pageUids, fetchOpts)) {
      const uid = msg.uid;
      const envelope = msg.envelope || {};
      const fromAddr = (envelope.from && envelope.from[0]) || {};
      const toAddr = (envelope.to && envelope.to[0]) || {};
      const subject = envelope.subject || "";

      let text = "";
      let html = "";
      if (fullBodies && msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          text = (parsed.text || "").trim();
          html = (parsed.html || "").trim();
        } catch {
          // keep graceful
        }
      }

      // Minimal normalization the UI expects
      items.push({
        uid,
        id: String(uid),
        subject,
        from: [fromAddr.name, fromAddr.address].filter(Boolean).join(" <") + (fromAddr.address ? ">" : ""),
        fromEmail: fromAddr.address || "",
        fromDomain: domainOf(fromAddr.address || ""),   // ← NEW
        to: [toAddr.name, toAddr.address].filter(Boolean).join(" <") + (toAddr.address ? ">" : ""),
        toEmail: toAddr.address || "",
        date: msg.internalDate || envelope.date || null,
        snippet: text ? text.slice(0, 280) : "",
        text,
        html,
        flags: Array.isArray(msg.flags) ? msg.flags : [],
        importance: "unclassified",
        urgency: 0,
        action_required: false,
      });
    }

    return { emails: items, nextCursor };
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Fetch bodies by UID list — used by your /bodyBatch hydrator.
 * Returns items with { uid,id,text,html } for any UIDs it can parse.
 */
export async function fetchBodiesByUid({ auth = {}, uids = [] }) {
  const client = await connectClient(auth);

  try {
    const ids = (Array.isArray(uids) ? uids : [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!ids.length) return [];

    const out = [];
    for await (const msg of client.fetch(ids, { uid: true, source: true })) {
      let text = "";
      let html = "";
      try {
        if (msg.source) {
          const parsed = await simpleParser(msg.source);
          text = (parsed.text || "").trim();
          html = (parsed.html || "").trim();
        }
      } catch {
        // ignore
      }
      out.push({
        uid: msg.uid,
        id: String(msg.uid),
        text,
        html,
      });
    }
    return out;
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Simple login test — opens INBOX and returns ok:true on success.
 */
export async function testLogin(auth = {}) {
  const client = await connectClient(auth);
  try {
    return { ok: true, user: auth?.email || "" };
  } finally {
    try { await client.logout(); } catch {}
  }
}
