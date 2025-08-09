import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

router.post('/imap/fetch', async (req, res) => {
  try {
    const { email, password, host, port, criteria, limit } = req.body;
    const rawEmails = await fetchEmails({ email, password, host, port, criteria, limit });
    const classified = await classifyEmails(rawEmails);
    res.json({ success: true, emails: classified });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
