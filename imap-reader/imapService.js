// imapService.js — ImapFlow-based IMAP access with full range/month search and classification
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// ---- Utility: open client ----
async function openClient({ host, port, tls, authType, email, password, accessToken }) {
  const client = new ImapFlow({
    host,
    port,
    secure: tls,
    auth: authType === "oauth2"
      ? { user: email, accessToken }
      : { user: email, pass: password },
  });
  await client.connect();
  await client.selectMailbox("INBOX");
  return client;
}

// ---- Utility: parse raw email if needed ----
async function parseIfNeeded(source) {
  if (!source) return { text: "", html: "" };
  try {
    const parsed = await simpleParser(source);
    return {
      text: parsed.text || "",
      html: parsed.html || "",
    };
  } catch {
    return { text: "", html: "" };
  }
}

// ---- Utility: classify emails (light) ----
function classifyLite({ from, subject }) {
  const low = (s = "") => s.toLowerCase();
  const f = low(from), s = low(subject);

  if (s.includes("invoice") || s.includes("payment")) return { priority: "high", intent: "finance" };
  if (s.includes("meeting") || s.includes("schedule")) return { priority: "medium", intent: "meeting" };
  if (f.includes("no-reply")) return { priority: "low", intent: "bulk" };
  return { priority: "low", intent: "other" };
}

// ---- Utility: compute range/month search ----
function computeSearchRange({ monthStart, monthEnd, rangeDays }) {
  let since = null, before = null;
  if (monthStart) since = new Date(monthStart);
  if (monthEnd) before = new Date(monthEnd);
  if (!since && rangeDays) {
    since = new Date();
    since.setDate(since.getDate() - rangeDays);
  }
  return { since, before };
}

// ---- MAIN: list + classify ----
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
  cursor = null,
  query = "",
  includePreview = true,
  includeSnippet = true,
  includeBody = false,
  fullBodies = false,
}) {
  const client = await openClient({ host, port, tls, authType, email, password, accessToken });

  try {
    // ---- Build search criteria ----
    const { since, before } = computeSearchRange({ monthStart, monthEnd, rangeDays });
    const criteria = {};
    if (since) criteria.since = since;
    if (before) criteria.before = before;

    if (query && String(query).trim()) {
      criteria.or = [
        { header: ["subject", query] },
        { body: query },
      ];
    }

    // ---- Run search ----
    let uids = await client.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true });
    uids = Array.isArray(uids) ? uids : Array.from(uids || []);

    if (!uids.length) {
      return { emails: [], nextCursor: null, tier: "premium", isPaid: true };
    }

    // ---- Sort + paginate ----
    const sorted = uids.sort((a, b) => b - a);
    const page = sorted.slice(0, Math.max(1, Number(limit) || 20));

    // ---- Fetch messages ----
    const items = [];
    for await (const msg of client.fetch(page, { uid: true, envelope: true, internalDate: true, source: includeBody || fullBodies })) {
      const base = {
        id: msg.uid,
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
        if (includeSnippet) {
          snippet = (t || h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
        }
      }

      const tags = classifyLite({ from: base.fromEmail, subject: base.subject });
      items.push({ ...base, snippet, text, html, ...tags });
    }

    const nextCursor = sorted.length > page.length ? String(page[page.length - 1]) : null;
    return { emails: items, nextCursor, tier: "premium", isPaid: true };
  } finally {
    try { await client.logout(); } catch {}
  }
}

// ---- Optional: test login ----
export async function testLogin({ email, password, host, port = 993, tls = true, authType = "password", accessToken = "" }) {
  const client = await openClient({ host, port, tls, authType, email, password, accessToken });
  try {
    return { success: true };
  } finally {
    try { await client.logout(); } catch {}
  }
}
