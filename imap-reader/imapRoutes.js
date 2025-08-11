// imap-reader/imapRoutes.js
import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

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
      // ✅ default to last 2 days for testing
      sinceDays = 2,
      // ✅ reasonable upper bound so we don’t flood the model
      limit = 25,
      criteria = ['ALL']
    } = req.body || {};

    if (!email || !password || !host) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    // Build IMAP criteria with SINCE date (e.g. 11-Aug-2025)
    let crit = Array.isArray(criteria) ? [...criteria] : ['ALL'];
    if (sinceDays && Number(sinceDays) > 0) {
      const d = new Date();
      d.setDate(d.getDate() - Number(sinceDays));
      const fmt = d
        .toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        .replace(/ /g, '-');
      crit.push(['SINCE', fmt]);
    }

    // Keep a hard ceiling regardless of client input
    const safeLimit = Math.min(Number(limit) || 25, 50);

    // Fetch raw emails (headers/body) from IMAP
    const raw = await fetchEmails({ email, password, host, port, criteria: crit, limit: safeLimit });

    // Compact each email to keep token usage small
    const compact = raw.map(e => ({
      subject: (e.subject || '(no subject)').slice(0, 140),
      from: (e.from || '').slice(0, 120),
      date: e.date || null,
      // Use a short text snippet only; drop HTML for classification
      snippet: ((e.text || '').trim()).slice(0, 300)
    }));

    // If no OpenAI key present, just return compact data unclassified
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ success: true, emails: compact.map(x => ({ ...x, importance: 'unclassified' })) });
    }

    // Batch classify to avoid token/rate limits
    const chunkSize = 20; // small safe chunks
    const chunks = [];
    for (let i = 0; i < compact.length; i += chunkSize) {
      chunks.push(compact.slice(i, i + chunkSize));
    }

    const results = [];
    for (const chunk of chunks) {
      let tries = 0;
      while (true) {
        try {
          const out = await classifyEmails(chunk); // returns [{subject, from, importance}]
          // Merge importance back onto items (preserve date/snippet)
          const merged = chunk.map((c, idx) => ({
            ...c,
            importance: (out[idx]?.importance || 'unclassified')
          }));
          results.push(...merged);
          break;
        } catch (err) {
          const msg = String(err?.message || '');
          // Simple backoff on 429s
          if (++tries <= 2 && /429|rate|limit/i.test(msg)) {
            await new Promise(r => setTimeout(r, 1200 * tries));
            continue;
          }
          throw err;
        }
      }
    }

    return res.json({ success: true, emails: results });
  } catch (err) {
    console.error('IMAP fetch/classify error:', err?.message || err);
    return res.status(500).json({ success: false, error: 'IMAP fetch failed' });
  }
});

export default router;
