// server/imapRoutes.js
import express from "express";
import { randomBytes } from "crypto";
import { listAndClassify, fetchBodiesByUid, testLogin } from "./imapService.js";

const router = express.Router();

function tag() {
  return randomBytes(3).toString("base64url");
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function truthy(v) {
  if (v === true) return true;
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/* -----------------------------------------
   POST /api/imap/fetch
   Body:
     email, password | accessToken, host, port, tls,
     authType('password'|'xoauth2'),
     monthStart, monthEnd  (optional)
     rangeDays             (optional)
     limit                 (page size)
     cursor                (server paging token)
     fullBodies            (force full bodies for range too)
     query                 (optional IMAP text query)
----------------------------------------- */
router.post("/fetch", async (req, res) => {
  const id = tag();

  try {
    const {
      email = "",
      password = "",
      accessToken = "",
      host = "",
      port = 993,
      tls = true,
      authType = "password",

      monthStart = null,
      monthEnd = null,
      rangeDays = null,

      limit = 20,
      cursor = null,
      query = "",

      fullBodies: fullBodiesIn = false,

      // optional UI flags (harmless on server)
      includePreview = true,
      includeSnippet = true,
      includeBody = false,
      licenseKey = "",
    } = req.body || {};

    // Normalize window
    const monthMode = !!(monthStart && monthEnd);
    const rangeN = monthMode ? null : num(rangeDays, 30);

    // If client requested full bodies explicitly, respect it for RANGE too.
    const fullBodies = monthMode ? true : truthy(fullBodiesIn);

    const paid = true; // your real tier logic can set this
    const tier = paid ? "premium" : "free";

    console.log(`[FETCH:${id}] IN {`);
    console.log(
      `  email: '${email.replace(/(.{2}).+(@.*)/, "$1***$2")}',\n  host: '${host}',\n  port: ${num(
        port,
        993
      )},\n  tls: ${!!tls},\n  authType: '${authType}',\n  mode: '${monthMode ? "month" : "range"}',`
    );
    console.log(
      `  monthStart: ${monthMode ? `'${monthStart}'` : "null"},\n  monthEnd: ${
        monthMode ? `'${monthEnd}'` : "null"
      },\n  rangeDays: ${rangeN ?? "null"},\n  limit: ${num(limit, 20)},\n  cursor: ${
        cursor ? "true" : "false"
      },\n  query: '${String(query || "").slice(0, 80)}'`
    );
    console.log(`}`);

    console.log(`[FETCH:${id}] tier=${tier} paid=${paid}`);
    console.log(
      `[FETCH:${id}] window { mode: '${monthMode ? "month" : "range"}', monthStart: ${
        monthMode ? `'${monthStart}'` : "null"
      }, monthEnd: ${monthMode ? `'${monthEnd}'` : "null"}, rangeDays: ${rangeN ?? "undefined"}, limit: ${num(
        limit,
        20
      )} }`
    );
    if (fullBodies) console.log(`[FETCH:${id}] fullBodies=true`);

    // Run the IMAP fetch (+ classification)
    const t0 = Date.now();
    const out = await listAndClassify({
      auth: { authType, email, password, accessToken },
      conn: { host, port: num(port, 993), tls: !!tls },
      window: monthMode
        ? { mode: "month", monthStart, monthEnd }
        : { mode: "range", rangeDays: rangeN },
      page: { limit: Math.max(1, num(limit, 20)), cursor: cursor || null },
      want: {
        preview: !!includePreview,
        snippet: !!includeSnippet,
        body: !!includeBody || fullBodies, // <- ensures bodies are returned when requested
        fullBodies, // <- pass through so the service chooses BODY[] strategy
      },
      query: String(query || ""),
      paid,
    });

    const ms = Date.now() - t0;

    // Basic counters for logs
    console.log(
      `[FETCH:${id}] fetched=${(out && out.count) || (out && out.emails && out.emails.length) || 0} nextCursor=${
        out && out.nextCursor ? "true" : "false"
      } hasMore=${out && out.hasMore ? "true" : "false"}`
    );
    console.log(`[FETCH:${id}] classified=${out && out.emails ? out.emails.length : 0}`);
    console.log(
      `[FETCH:${id}] OUT { returned: ${out && out.emails ? out.emails.length : 0}, nextCursor: ${
        out && out.nextCursor ? "true" : "false"
      }, notice: ${out && out.notice ? "true" : "false"}, ms: ${ms} }`
    );

    return res.json({
      emails: out.emails || [],
      nextCursor: out.nextCursor || null,
      hasMore: !!out.hasMore,
      tier,
      notice: out.notice || null,
    });
  } catch (err) {
    console.error(`[FETCH:${id}] ERROR`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

/* -----------------------------------------
   POST /api/imap/bodyBatch
   Body: {
     ids: number[] (UIDs),
     // same auth + connection as /fetch
     email,password,accessToken,host,port,tls,authType,
     // window hints (optional): monthStart/End or rangeDays
   }
----------------------------------------- */
router.post("/bodyBatch", async (req, res) => {
  const id = tag();
  try {
    const {
      ids = [],
      email = "",
      password = "",
      accessToken = "",
      host = "",
      port = 993,
      tls = true,
      authType = "password",

      monthStart = null,
      monthEnd = null,
      rangeDays = null,
    } = req.body || {};

    const uids = (Array.isArray(ids) ? ids : []).map((v) => Number(v)).filter((n) => Number.isFinite(n));

    if (!uids.length) return res.json({ items: [] });

    console.log(`[BATCH:${id}] ids=${uids.length} host=${host}`);

    const items = await fetchBodiesByUid({
      auth: { authType, email, password, accessToken },
      conn: { host, port: num(port, 993), tls: !!tls },
      window: monthStart && monthEnd
        ? { mode: "month", monthStart, monthEnd }
        : rangeDays != null
        ? { mode: "range", rangeDays: num(rangeDays, 30) }
        : null,
      uids,
      preferHtml: true,
      preferPlain: true,
    });

    return res.json({ items: items || [] });
  } catch (err) {
    console.error(`[BATCH:${id}] ERROR`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

/* -----------------------------------------
   POST /api/imap/test  (simple login check)
----------------------------------------- */
router.post("/test", async (req, res) => {
  const id = tag();
  try {
    const ok = await testLogin({
      auth: {
        authType: req.body?.authType || "password",
        email: req.body?.email || "",
        password: req.body?.password || "",
        accessToken: req.body?.accessToken || "",
      },
      conn: {
        host: req.body?.host || "",
        port: num(req.body?.port, 993),
        tls: !!req.body?.tls,
      },
    });
    return res.json({ ok: !!ok });
  } catch (err) {
    console.error(`[TEST:${id}] ERROR`, err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err?.message || "Login failed" });
  }
});

/* -----------------------------------------
   POST /api/imap/tier  (stub – make real if you have billing)
----------------------------------------- */
router.post("/tier", async (req, res) => {
  return res.json({ tier: "premium", isPaid: true });
});

export default router;
