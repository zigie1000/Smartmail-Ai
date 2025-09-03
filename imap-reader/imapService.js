// imap-reader/imapService.js  (ESM)
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// ---------- helpers ----------
const asBool = (v, d = false) =>
  typeof v === "boolean" ? v : String(v ?? "").toLowerCase() === "true" ? true : d;
const asNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// open an ImapFlow client and log in; caller must client.logout() in finally
async function openClient({ host, port = 993, tls = true, authType = "password", email, password, accessToken }) {
  const client = new ImapFlow({
    host,
    port: asNum(port, 993),
    secure: asBool(tls, true),
    auth: authType?.toLowerCase() === "xoauth2"
      ? { user: email, accessToken }
      : { user: email, pass: password },
  });
  await client.connect();
  await client.getMailboxLock("INBOX"); // lock is released on client.logout()
  return client;
}

function computeSearchRange({ monthStart, monthEnd, rangeDays }) {
  const monthMode = !!(monthStart && monthEnd);
  if (monthMode) {
    const since = new Date(`${monthStart}T00:00:00Z`);
    const before = new Date(`${monthEnd}T23:59:59Z`);
    return { monthMode: true, since, before };
  }
  const today = new Date();
  const end = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
    23, 59, 59, 999
  ));
  if (!Number.isFinite(+rangeDays) || rangeDays <= 0) {
    return { monthMode: false, since: undefined, before: end };
  }
  const start = new Date(end.getTime() - (Math.max(1, Number(rangeDays)) - 1) * 86400000);
  return { monthMode: false, since: start, before: end };
}

function classifyLite(msg) {
  const from = (msg.from?.text || msg.envelope?.from?.map(x => x.address).join(",") || "").toLowerCase();
  const subj = (msg.subject || "").toLowerCase();

  let category = "other";
  if (/invoice|receipt|payment|billing/i.test(subj)) category = "billing";
  else if (/meeting|calendar|invite|zoom|meet/i.test(subj)) category = "meeting";
  else if (/security|password|alert|verify/i.test(subj)) category = "security";
  else if (/unsubscribe|newsletter|digest/i.test(subj)) category = "newsletter";
  else if (/privacy|terms|copyright|nda|contract|legal/i.test(subj)) category = "legal";
  else if (/sale|offer|deal|discount/i.test(subj)) category = "sales";
  else if (/social|twitter|x\.com|facebook|instagram|linkedin/i.test(from)) category = "social";

  const isVip = /@apple\.com|@google\.com|@microsoft\.com/i.test(from);
  const importance = /urgent|asap|important|action required/i.test(subj) ? "important" : "unclassified";
  const urgency = /urgent|asap|immediately|now/i.test(subj) ? 3 : (/today|soon/i.test(subj) ? 2 : 0);

  return { category, intent: category, isVip, importance, urgency };
}

async function parseIfNeeded(raw) {
  if (!raw) return { text: "", html: "" };
  try {
    const parsed = await simpleParser(raw);
    return {
      text: parsed.text || "",
      html: parsed.html || "",
    };
  } catch {
    return { text: "", html: "" };
  }
}

// ---------- primary APIs ----------

/**
 * List messages and (optionally) fetch bodies.
 * Required: email, password/accessToken, host. Optional: monthStart+monthEnd or rangeDays, limit, cursor.
 */
export async function listAndClassify({
  email,
  password,
  host,
  port = 993,
  tls = true,
  authType = "password",
  accessToken = "",
  monthStart = null,
  monthEnd = null,
  rangeDays = 30,
  limit = 20,
  cursor = null, // not persisted cross sessions here; client supplies back/next
  query = "",
  includePreview = true,
  includeSnippet = true,
  includeBody = false,
  fullBodies = false,
}) {
  const client = await openClient({ host, port, tls, authType, email, password, accessToken });

  try {
    // basic search window
    const { since, before } = computeSearchRange({ monthStart, monthEnd, rangeDays });

    const search = [];
    if (since) search.push(["SINCE", since]);
    if (before) search.push(["BEFORE", new Date(before.getTime() + 1000)]); // day end inclusive
    if (query && String(query).trim()) search.push(["OR", ["SUBJECT", query], ["BODY", query]]);

    // ImapFlow fetches newest-last by default; we want newest first → reverse later
    const uids = await client.search(search.length ? search : ["ALL"], { uid: true });
    const sorted = uids.sort((a, b) => b - a); // newest first
    const page = sorted.slice(0, asNum(limit, 20));

    const items = [];
    for await (const msg of client.fetch(page, { envelope: true, internalDate: true, source: includeBody || fullBodies })) {
      const base = {
        id: msg.uid,           // use UID as stable id
        uid: msg.uid,
        subject: msg.envelope?.subject || "",
        from: msg.envelope?.from?.map(a => a.name || a.address).join(", ") || "",
        fromEmail: msg.envelope?.from?.[0]?.address || "",
        to: msg.envelope?.to?.map(a => a.address).join(", "),
        date: msg.internalDate?.toISOString?.() || null,
      };

      let text = "", html = "", snippet = "";
      if (includeBody || fullBodies) {
        const { text: t, html: h } = await parseIfNeeded(msg.source);
        text = t; html = h;
        if (includeSnippet) snippet = (t || h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
      } else if (includePreview || includeSnippet) {
        // lightweight: fetch the first text/plain or text/html part ~ ImapFlow needs BODYSTRUCTURE + partial fetch; keep simple with source off
        snippet = ""; // client may hydrate later with bodyBatch
      }

      const tags = classifyLite({ from: base.fromEmail, subject: base.subject });
      items.push({ ...base, snippet, text, html, ...tags });
    }

    const nextCursor = sorted.length > page.length ? String(page[page.length - 1]) : null; // naive "there are more" signal

    return {
      emails: items,
      nextCursor,
      tier: "premium",
      isPaid: true,
    };
  } finally {
    try { await client.logout(); } catch {}
  }
}

/**
 * Fetch full bodies for given UIDs.
 */
export async function fetchBodiesByUid({
  ids = [],
  email,
  password,
  host,
  port = 993,
  tls = true,
  authType = "password",
  accessToken = "",
}) {
  if (!Array.isArray(ids) || !ids.length) return [];

  const client = await openClient({ host, port, tls, authType, email, password, accessToken });
  try {
    const want = ids.map(n => Number(n)).filter(n => Number.isFinite(n));
    const out = [];
    for await (const msg of client.fetch(want, { uid: true, source: true, envelope: true, internalDate: true })) {
      const { text, html } = await parseIfNeeded(msg.source);
      out.push({
        id: msg.uid,
        uid: msg.uid,
        subject: msg.envelope?.subject || "",
        date: msg.internalDate?.toISOString?.() || null,
        text,
        html,
      });
    }
    return out;
  } finally {
    try { await client.logout(); } catch {}
  }
}

// Back-compat name some code bases use
export async function bodyBatch(opts) {
  return fetchBodiesByUid(opts);
}

/**
 * Quick auth probe.
 */
export async function testLogin({ email, password, host, port = 993, tls = true, authType = "password", accessToken = "" }) {
  const client = await openClient({ host, port, tls, authType, email, password, accessToken });
  try {
    return true;
  } finally {
    try { await client.logout(); } catch {}
  }
}
