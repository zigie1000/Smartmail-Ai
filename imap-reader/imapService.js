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
 * Build a date window from the UI's search payload.
 * Supports:
 *   - { monthStart, monthEnd } in YYYY-MM-DD (month mode)
 *   - { rangeDays } number of days back from today (range mode)
 */
function buildWindow({ monthStart, monthEnd, rangeDays } = {}) {
  const out = {};
  const now = new Date();
  const endOfTodayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

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
 *  - cursor paging (opaque base64 offset)
 *  - fullBodies (controls body parsing cost)
 */
export async function fetchEmails({ auth = {}, search = {}, limit = 20, cursor = null, fullBodies = true } = {}) {
  const client = await connectClient(auth);

  try {
    // 1) Build criteria and list UIDs within window
    const win = buildWindow(search);
    const criteria = {};
    if (win.since) criteria.since = win.since;
    if (win.before) criteria.before = win.before;

    // Pull the UIDs in the window (ascending), then sort desc for newest-first UI
    let uids = await client.search(criteria);
    // Ensure array of numbers
    uids = (Array.isArray(uids) ? uids : []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    uids.sort((a, b) => b - a); // newest first

    // 2) Cursor paging based on offset
    const offset = (() => {
      if (!cursor) return 0;
      try {
        const obj = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
        const off = Number(obj?.offset);
        return Number.isFinite(off) && off >= 0 ? off : 0;
      } catch {
        return 0;
      }
    })();

    const pageUids = uids.slice(offset, offset + Math.max(1, Number(limit) || 20));
    const nextOffset = offset + pageUids.length;
    const nextCursor =
      nextOffset < uids.length
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
        fromDomain: domainOf(fromAddr.address || ""),  // ← NEW: domain field used by classifier
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
