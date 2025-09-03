// imap-reader/imapRoutes.js
// ESM-only. Mount this router in server.js:  app.use("/api/imap", imapRouter);

import express from "express";
import { fetchEmails, fetchBodiesByUid, testLogin } from "./imapService.js";

export const imapRouter = express.Router();

// Utility: normalize auth block from request body
function readAuth(body) {
  const {
    email = "",
    password = "",
    host = "",
    port = 993,
    tls = true,
    authType = "password",
    accessToken = "",
  } = body || {};
  return {
    email: String(email || ""),
    password: String(password || ""),
    host: String(host || ""),
    port: Number(port || 993),
    tls: !!tls,
    authType: String(authType || "password"),
    accessToken: String(accessToken || ""),
  };
}

// Utility: normalize search window from request body
function readSearch(body) {
  let { monthStart, monthEnd, rangeDays } = body || {};
  monthStart = monthStart || null;
  monthEnd = monthEnd || null;

  // If client sent both monthStart and monthEnd, month mode wins
  if (monthStart && monthEnd) {
    return { monthStart, monthEnd };
  }

  // else range mode
  const n = Number(
    body?.rangeDays ??
      body?.range ??
      30
  );
  return { rangeDays: Number.isFinite(n) ? n : 30 };
}

// POST /api/imap/test  — quick login check
imapRouter.post("/test", async (req, res) => {
  try {
    const auth = readAuth(req.body);
    if (!auth.host) return res.status(400).json({ error: "IMAP host is required." });
    const data = await testLogin(auth);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Login failed" });
  }
});

// POST /api/imap/fetch — main fetch + (optionally) full bodies
imapRouter.post("/fetch", async (req, res) => {
  const started = Date.now();
  try {
    const auth = readAuth(req.body);
    const search = readSearch(req.body);
    const limit = Math.max(1, Number(req.body?.limit || 20));

    // Full bodies: allow forcing from client; default true in our stable service
    const fullBodies = (req.body?.fullBodies ?? true) ? true : false;

    // server logs
    console.log(
      "[FETCH] IN",
      JSON.stringify({
        email: maskEmail(auth.email),
        host: auth.host,
        port: auth.port,
        tls: auth.tls,
        mode: search.monthStart ? "month" : "range",
        monthStart: search.monthStart || null,
        monthEnd: search.monthEnd || null,
        rangeDays: search.rangeDays ?? null,
        limit,
        cursor: !!req.body?.cursor,
      })
    );

    const page = await fetchEmails({
      auth,
      search,
      limit,
      cursor: req.body?.cursor || null,
      fullBodies,
    });

    const ms = Date.now() - started;
    console.log(
      "[FETCH] OUT",
      JSON.stringify({
        returned: (page?.emails || []).length,
        nextCursor: !!page?.nextCursor,
        ms,
      })
    );

    res.json({
      emails: page.emails || [],
      nextCursor: page.nextCursor || null,
      notice: false,
    });
  } catch (e) {
    console.error("[FETCH] ERROR", e);
    res.status(500).json({ error: e?.message || "Fetch failed" });
  }
});

// POST /api/imap/bodyBatch — hydrate specific UIDs to full bodies
imapRouter.post("/bodyBatch", async (req, res) => {
  try {
    const auth = readAuth(req.body);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const uids = ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);

    if (!uids.length) return res.json({ items: [] });

    const items = await fetchBodiesByUid({ auth, uids });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e?.message || "bodyBatch failed" });
  }
});

// (Optional) /tier and /feedback endpoints — stubbed to keep the shape your UI expects.
// Hook your DB/logic here if needed.
imapRouter.post("/tier", async (req, res) => {
  try {
    // Minimal: treat everyone as free unless you have license checks
    res.json({ tier: "free", isPaid: false, notice: null });
  } catch {
    res.json({ tier: "free", isPaid: false, notice: null });
  }
});

imapRouter.post("/feedback", async (req, res) => {
  // Accept and 200 — you can wire this to persist sender/category overrides
  res.json({ ok: true });
});

// Helper to mask email in logs
function maskEmail(e) {
  if (!e) return "";
  const i = e.indexOf("@");
  if (i <= 1) return `*${e.slice(i)}`;
  return `${e[0]}***${e.slice(i)}`;
}

export default imapRouter;
