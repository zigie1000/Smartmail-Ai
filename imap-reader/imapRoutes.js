import express from 'express';
import { fetchEmails } from './imapService.js';
import { classifyEmails } from './emailClassifier.js';

const router = express.Router();

// ✅ Test GET route so /imap works in browser
router.get('/', (req, res) => {
    res.status(200).json({ success: true, message: 'IMAP route is active' });
});

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
