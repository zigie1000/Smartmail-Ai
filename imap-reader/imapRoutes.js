// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

/** Hard limits & defaults */
const MAX_DAYS = 180;     // don’t scan beyond this by default
const MAX_LIMIT = 200;    // protect server from huge pulls per page
const MIN_LIMIT = 10;
const DEFAULT_DAYS = 30;
const DEFAULT_LIMIT = 50;
const TOP_MODEL_N = 60;   // classify only the top-N heuristic candidates

/** Build IMAP search criteria safely */
function buildCriteria(rangeDays) {
  if (rangeDays === 'all') return ['ALL'];
  const days = Number(rangeDays);
  if (Number.isFinite(days) && days > 0) {
    const clamped = Math.min(Math.max(days, 1), MAX_DAYS);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - clamped);
    return ['SINCE', since];
  }
  // fallback
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - DEFAULT_DAYS);
  return ['SINCE', since];
}

/** Basic newsletter / low-signal detection */
const NEWSLETTER_DOMAINS = new Set([
  'members.netflix.com','netflix.com','property24.com','mailchimp.com',
  'sendgrid.net','substack.com','medium.com','news.google.com'
]);
const NOREPLY = /(^|\b)no-?reply@/i;

const KW = {
  billing: /(invoice|payment|paid|unpaid|overdue|refund|charge|billing|receipt|statement)/i,
  meeting: /(meeting|call|zoom|teams|google meet|schedule|reschedule|calendar|invite)/i,
  sales: /(quote|pricing|proposal|order|purchase|rfq|rfi|tender|lead)/i,
  support: /(issue|bug|error|help|support|down|outage|urgent)/i,
  legal: /(contract|nda|legal|policy|compliance|gdpr|popia|terms|arbitration|litigation)/i,
  security: /(security|breach|phishing|compromised|password|2fa|mfa|login attempt)/i,
  hr: /(cv|resume|recruit|interview|offer|onboarding|leave|payroll)/i
};
const URGENT = /(due today|due tomorrow|overdue|final notice|failed payment|action required|respond within|24 hours|immediately|suspended)/i;

/** Cheap heuristic scoring for “important-first” preselection */
function heuristicScore(m) {
  const subj = (m.subject || '').toLowerCase();
  const body = (m.snippet || '').toLowerCase();
  const fromEmail = (m.fromEmail || '').toLowerCase();
  const domain = (m.fromDomain || '').toLowerCase();

  let score = 0;

  // recency bonus (hours since)
  if (m.date) {
    const hours = Math.max(0, (Date.now() - new Date(m.date).getTime()) / 36e5);
    score += Math.max(0, 24 - Math.min(hours, 72)) * 0.1; // up to +2.4 for new mail
  }

  // clear intent keywords
  if (KW.billing.test(subj) || KW.billing.test(body)) score += 6;
  if (KW.meeting.test(subj) || KW.meeting.test(body)) score += 4;
  if (KW.support.test(subj) || KW.support.test(body)) score += 5;
  if (KW.security.test(subj) || KW.security.test(body)) score += 7;
  if (KW.sales.test(subj) || KW.sales.test(body)) score += 3;
  if (KW.legal.test(subj) || KW.legal.test(body)) score += 3;
  if (KW.hr.test(subj) || KW.hr.test(body)) score += 2;

  // urgency cues
  if (URGENT.test(subj) || URGENT.test(body)) score += 5;

  // downweight newsletters/notifications unless they contain urgency
  const isNewsletter =
    NEWSLETTER_DOMAINS.has(domain) || NOREPLY.test(fromEmail);
  if (isNewsletter) score -= 4;

  // flagged / unread hints if your IMAP layer sets them
  if (m.flagged) score += 4;
  if (m.unread) score += 2;

  return score;
}

/** Server-side pagination by UID (descending) */
function paginateByUid(all, lastUid, limit) {
  const sorted = [...all].sort((a, b) => (b.uid || 0) - (a.uid || 0));
  let page = sorted;
  if (lastUid) {
    const last = Number(lastUid);
    page = sorted.filter(m => (m.uid || 0) < last);
  }
  const slice = page.slice(0, limit);
  const hasMore = page.length > slice.length;
  const nextCursor = hasMore ? slice[slice.length - 1]?.uid : null;
  return { page: slice, hasMore, nextCursor, total: sorted.length };
}

/** Clamp helper */
function clamp(n, lo, hi, def) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  return Math.min(Math.max(x, lo), hi);
}

/** POST /fetch — fetch messages with paging & important-first */
router.post('/fetch', async (req, res) => {
  try {
    const {
      email, password, host,
      port = 993, tls = true,
      authType = 'password', accessToken = '',
      // NEW:
      rangeDays = DEFAULT_DAYS,       // 1..180 or 'all'
      limit = DEFAULT_LIMIT,          // 10..200
      lastUid = null,                 // cursor for older mail
      unreadOnly = false,
      flaggedOnly = false,
      subjectContains = '',
      importantFirst = true
    } = req.body || {};

    if (!email || !host || !port) {
      return res.status(400).json({ success: false, error: 'Email, host and port are required.' });
    }

    const cappedLimit = clamp(limit, MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT);
    const criteria = buildCriteria(rangeDays);

    // Pull a slightly larger working set so we can prioritize
    const workingLimit = Math.min(MAX_LIMIT, Math.max(cappedLimit, TOP_MODEL_N + 20));

    // Fetch raw messages (implementation hidden in imapService)
    const rawItems = await fetchEmails({
      email, password, host, port, tls,
      authType, accessToken,
      criteria,
      limit: workingLimit, // server-side cap (best effort)
      // Some IMAP libs accept lastUid; if not, we’ll paginate below
      lastUid: lastUid ? Number(lastUid) : null
    });

    // Apply server-side pagination by UID if the service returned more than requested
    const { page, hasMore, nextCursor, total } = paginateByUid(rawItems, lastUid, cappedLimit);

    // Client-side filters that should not hide items at fetch time
    let items = page.filter(m => {
      if (unreadOnly && !m.unread) return false;
      if (flaggedOnly && !m.flagged) return false;
      if (subjectContains) {
        const needle = String(subjectContains).toLowerCase();
        const hay = (m.subject || '').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    // Heuristic scores
    const scored = items.map((m, i) => ({ i, score: heuristicScore(m) }));
    // Pick top candidates for model classification
    const topN = Math.min(TOP_MODEL_N, scored.length);
    const topCandidates = [...scored].sort((a, b) => b.score - a.score).slice(0, topN).map(x => x.i);

    // Prepare arrays for model
    const toClassify = topCandidates.map(idx => items[idx]);

    // Classify top candidates
    let classified = [];
    if (toClassify.length > 0) {
      try {
        classified = await classifyEmails(toClassify);
      } catch (e) {
        // If classifier fails, we’ll just skip and continue with neutral defaults
        console.error('IMAP /fetch classify error:', e?.message || e);
        classified = [];
      }
    }

    // Attach results back to items (others remain neutral)
    const aligned = items.map((m, idx) => {
      const pos = topCandidates.indexOf(idx);
      const cls = pos >= 0 && classified[pos] ? classified[pos] : {
        importance: 'unclassified',
        intent: 'other',
        urgency: 0,
        action_required: false,
        confidence: 0.5,
        reasons: []
      };
      return { ...m, classification: cls };
    });

    // Final ordering
    let finalItems = aligned;
    if (importantFirst) {
      const impWeight = v => v === 'important' ? 2 : v === 'unclassified' ? 1 : 0;
      finalItems = [...aligned].sort((a, b) => {
        const ia = impWeight(a.classification?.importance);
        const ib = impWeight(b.classification?.importance);
        if (ib !== ia) return ib - ia;
        const ua = a.classification?.urgency ?? 0;
        const ub = b.classification?.urgency ?? 0;
        if (ub !== ua) return ub - ua;
        // newest first
        return new Date(b.date || 0) - new Date(a.date || 0);
      });
    } else {
      // Default: newest first
      finalItems = [...aligned].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    }

    return res.json({
      success: true,
      items: finalItems,
      nextCursor,
      hasMore,
      totalFetched: items.length,
      rangeApplied: rangeDays === 'all' ? 'all' : clamp(rangeDays, 1, MAX_DAYS, DEFAULT_DAYS)
    });
  } catch (err) {
    console.error('IMAP /fetch error:', err?.stack || err);
    return res.status(500).json({ success: false, error: 'Server error while fetching mail.' });
  }
});

/** POST /classify — allow front-end to classify arbitrary items when needed */
router.post('/classify', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items array required.' });
    }
    const out = await classifyEmails(items);
    return res.json({ success: true, results: out });
  } catch (e) {
    console.error('IMAP /classify error:', e?.message || e);
    return res.status(500).json({ success: false, error: 'Classification failed.' });
  }
});

export default router;
