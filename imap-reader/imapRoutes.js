// imap-reader/imapRoutes.js
import express from "express";
import * as svc from "./imapService.js"; // import everything; pick available symbols at runtime

// Resolve service functions with safe fallbacks (avoids “does not provide an export named …”)
const listAndClassify =
  svc.listAndClassify || svc.listAndClassifyEmails || svc.fetchAndClassify;
const fetchBodiesByUid =
  svc.fetchBodiesByUid ||
  svc.bodyBatchByUid ||
  svc.getBodiesByUid ||
  svc.fetchBodies ||
  svc.bodyBatch;
const testLogin = svc.testLogin || svc.tryLogin || svc.verifyLogin;

if (!listAndClassify) {
  throw new Error("imapService.js is missing listAndClassify(..)");
}
if (!fetchBodiesByUid) {
  throw new Error(
    "imapService.js is missing a body-batch function (expected one of: fetchBodiesByUid, bodyBatchByUid, getBodiesByUid, fetchBodies, bodyBatch)"
  );
}

const router = express.Router();

// Small helper to coerce booleans/numbers safely
const asBool = (v, d = false) =>
  typeof v === "boolean" ? v : String(v ?? "").toLowerCase() === "true" ? true : d;
const asNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// ----- POST /api/imap/fetch ---------------------------------------------------
router.post("/fetch", async (req, res) => {
  const t0 = Date.now();
  const short = Math.random().toString(36).slice(2, 7);

  try {
    const {
      email = "",
      password = "",
      host = "",
      port = 993,
      tls = true,
      authType = "password",
      accessToken = "",
      // window
      monthStart = null,
      monthEnd = null,
      rangeDays = 30,
      limit = 20,
      cursor = null,
      query = "",
      fullBodies = false, // client may force this (we also force for month mode)
      includePreview = true,
      includeSnippet = true,
      includeBody = false,
      userEmail = "",
      licenseKey = ""
    } = req.body || {};

    const monthMode = !!(monthStart && monthEnd);
    const windowDesc = {
      mode: monthMode ? "month" : "range",
      monthStart: monthMode ? monthStart : null,
      monthEnd: monthMode ? monthEnd : null,
      rangeDays: monthMode ? undefined : asNum(rangeDays, 30),
      limit: asNum(limit, 20)
    };

    console.log(`[FETCH:${short}] IN`, {
      email,
      host,
      port: asNum(port, 993),
      tls: asBool(tls, true),
      authType,
      mode: windowDesc.mode,
      monthStart: windowDesc.monthStart,
      monthEnd: windowDesc.monthEnd,
      rangeDays: windowDesc.rangeDays ?? null,
      limit: windowDesc.limit,
      cursor: !!cursor,
      query
    });
    console.log(`[FETCH:${short}] window`, windowDesc);

    // Call service
    const result = await listAndClassify({
      email,
      password,
      host,
      port: asNum(port, 993),
      tls: asBool(tls, true),
      authType,
      accessToken,
      // window
      monthStart: windowDesc.monthStart,
      monthEnd: windowDesc.monthEnd,
      rangeDays: windowDesc.rangeDays,
      limit: windowDesc.limit,
      cursor,
      query,
      // content knobs
      includePreview,
      includeSnippet,
      includeBody,
      // FORCE full bodies in month mode; honor client flag for range
      fullBodies: monthMode ? true : !!fullBodies,
      // optional meta
      userEmail,
      licenseKey
    });

    const emails = Array.isArray(result?.emails) ? result.emails : [];
    const nextCursor = result?.nextCursor ?? null;
    const hasMore = !!nextCursor;

    console.log(
      `[FETCH:${short}] fetched=${emails.length} nextCursor=${!!nextCursor} hasMore=${hasMore}`
    );

    // Pass through tier/notice if provided
    const out = {
      emails,
      nextCursor,
      notice: result?.notice || false,
      tier: result?.tier || undefined,
      isPaid: !!result?.isPaid
    };

    console.log(
      `[FETCH:${short}] OUT`,
      { returned: emails.length, nextCursor: !!nextCursor, notice: !!out.notice, ms: Date.now() - t0 }
    );

    return res.json(out);
  } catch (err) {
    console.error(`[FETCH:${short}] ERROR`, err);
    const msg =
      err?.message ||
      (typeof err === "string" ? err : "Failed to fetch/classify emails");
    return res.status(500).json({ error: msg });
  }
});

// ----- POST /api/imap/bodyBatch ----------------------------------------------
// Fetch **full bodies** for a set of IMAP UIDs (or ids)
router.post("/bodyBatch", async (req, res) => {
  try {
    const {
      ids = [],
      email = "",
      password = "",
      host = "",
      port = 993,
      tls = true,
      authType = "password",
      accessToken = "",
      monthStart = null,
      monthEnd = null,
      rangeDays = null
    } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids (array) is required" });
    }

    const items = await fetchBodiesByUid({
      ids,
      email,
      password,
      host,
      port: asNum(port, 993),
      tls: asBool(tls, true),
      authType,
      accessToken,
      monthStart: monthStart || undefined,
      monthEnd: monthEnd || undefined,
      rangeDays: rangeDays == null ? undefined : asNum(rangeDays, 30)
    });

    return res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error("[bodyBatch] ERROR", err);
    const msg =
      err?.message || (typeof err === "string" ? err : "bodyBatch failed");
    return res.status(500).json({ error: msg });
  }
});

// ----- POST /api/imap/test ----------------------------------------------------
router.post("/test", async (req, res) => {
  try {
    const {
      email = "",
      password = "",
      host = "",
      port = 993,
      tls = true,
      authType = "password",
      accessToken = ""
    } = req.body || {};

    const ok = await testLogin({
      email,
      password,
      host,
      port: asNum(port, 993),
      tls: asBool(tls, true),
      authType,
      accessToken
    });

    return res.json({ ok: !!ok });
  } catch (err) {
    console.error("[TEST] ERROR", err);
    const msg = err?.message || "Login failed";
    return res.status(401).json({ ok: false, error: msg });
  }
});

// ----- POST /api/imap/tier ----------------------------------------------------
// Keep simple: if a non-empty licenseKey is present, mark as premium
router.post("/tier", async (req, res) => {
  try {
    const { email = "", licenseKey = "" } = req.body || {};
    const isPaid = !!String(licenseKey || "").trim();
    const tier = isPaid ? "premium" : "free";
    return res.json({
      tier,
      isPaid,
      notice: isPaid ? null : "Free plan limits may apply."
    });
  } catch {
    return res.json({ tier: "free", isPaid: false });
  }
});

// ----- POST /api/imap/feedback ------------------------------------------------
// Accept importance/category feedback; you can wire this to your DB later.
router.post("/feedback", async (req, res) => {
  try {
    const { ownerEmail, licenseKey, fromEmail, fromDomain, label, category } =
      req.body || {};
    console.log("[feedback]", {
      ownerEmail,
      hasKey: !!licenseKey,
      fromEmail,
      fromDomain,
      label,
      category
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "error" });
  }
});

export default router;
