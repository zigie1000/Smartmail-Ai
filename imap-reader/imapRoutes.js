// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

/* ----------------------- Step 1: helpers (top of file) ---------------------- */
const stripHtml = (html = '') => {
  const txt = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '');
  return txt;
};

// quick heuristic — returns 'important' | 'unimportant' | null
function heuristicImportance(e) {
  const subj = (e.subject || '').toLowerCase();
  const snip = (e.snippet || '').toLowerCase();
  const fromDomain = (e.fromDomain || '').toLowerCase();

  const hotWords = [
    'invoice','payment','overdue','past due','contract','nda',
    'offer','interview','meeting','schedule','deadline','urgent',
    'action required','security alert','verification code','2fa','otp'
  ];
  if (hotWords.some(w => subj.includes(w) || snip.includes(w))) return 'important';

  const promoDomains = ['newsletters.','mailchimp.','sendgrid.','amazonses.','sparkpost.','substack.com'];
  if (promoDomains.some(d => fromDomain.includes(d))) return 'unimportant';

  if (/^re:|^fwd:/i.test(e.subject || '')) return 'important';

  return null;
}
/* --------------------------------------------------------------------------- */

// Health check
router.get('/', (_req, res) => {
  res.json({ success: true, message: 'IMAP API is live' });
});

router.post('/fetch', async (req, res) => {
  try {
    const {
      email,
      password,
      host,
      port = 993,
      sinceDays = 2,   // ✅ default to last 2 days for testing
      limit = 25,      // ✅ default count
      criteria = ['ALL']
    } = req.body || {};

    if (!email || !password || !host) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    // Build IMAP criteria with SINCE (e.g., 11-Aug-2025)
    let crit = Array.isArray(criteria) ? [...criteria] : ['ALL'];
    if (sinceDays && Number(sinceDays) > 0) {
      const d = new Date();
      d.setDate(d.getDate() - Number(sinceDays));
      const fmt = d
        .toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        .replace(/ /g, '-');
      crit.push(['SINCE', fmt]);
    }

    // Hard ceiling
    const safeLimit = Math.min(Number(limit) || 25, 50);

    // Fetch from IMAP
    const raw = await fetchEmails({ email, password, host, port, criteria: crit, limit: safeLimit });

    // Compact & enrich signals for classification
    const compact = raw.map(e => {
      const fromText = e.from || '';
      const fromEmail = (fromText.match(/<([^>]+)>/) || [,''])[1] || fromText;
      const fromDomain = (fromEmail.split('@')[1] || '').trim();

      const body = e.text && e.text.trim()
        ? e.text
        : stripHtml(e.html || '');

      const item = {
        subject: (e.subject || '(no subject)').slice(0, 180),
        from: fromText.slice(0, 160),
        fromEmail: fromEmail.slice(0, 120),
        fromDomain: fromDomain.slice(0, 120),
        to: (e.to || '').slice(0, 200),
        cc: (e.cc || '').slice(0, 200),
        date: e.date || null,
        snippet: (body || '').slice(0, 600)
      };

      // Heuristic first (cheap)
      const h = heuristicImportance(item);
      if (h) item.importance = h;

      return item;
    });

    // Only send uncertain to OpenAI
    const certain = compact.filter(x => x.importance);
    const uncertain = compact.filter(x => !x.importance);

    // If no API key or nothing uncertain, return now
    if (!process.env.OPENAI_API_KEY || uncertain.length === 0) {
      const result = certain.concat(uncertain.map(u => ({ ...u, importance: 'unclassified' })));
      return res.json({ success: true, emails: result });
    }

    // Batch classify uncertain items
    const chunkSize = 18;
    for (let i = 0; i < uncertain.length; i += chunkSize) {
      const chunk = uncertain.slice(i, i + chunkSize);
      let tries = 0;
      // light retry/backoff on rate limits
      while (true) {
        try {
          const out = await classifyEmails(chunk); // returns [{ importance }]
          out.forEach((o, idx) => {
            uncertain[i + idx].importance = /important/i.test(o?.importance) ? 'important' : 'unimportant';
          });
          break;
        } catch (err) {
          const msg = String(err?.message || '');
          if (++tries <= 2 && /429|rate|limit/i.test(msg)) {
            await new Promise(r => setTimeout(r, 1200 * tries));
            continue;
          }
          throw err;
        }
      }
    }

    const results = certain.concat(uncertain);
    return res.json({ success: true, emails: results });
  } catch (err) {
    console.error('IMAP fetch/classify error:', err?.message || err);
    return res.status(500).json({ success: false, error: 'IMAP fetch failed' });
  }
});

export default router;
