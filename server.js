require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

function checkTier(tier) {
  return (req, res, next) => {
    const userTier = req.headers['x-tier'];
    if (!userTier || ['free', 'pro', 'premium'].indexOf(userTier) === -1) {
      return res.status(403).json({ error: 'Invalid or missing tier' });
    }
    if (['pro', 'premium'].indexOf(userTier) < ['pro', 'premium'].indexOf(tier)) {
      return res.status(403).json({ error: 'Insufficient tier access' });
    }
    next();
  };
}

app.post('/api/summarize', async (req, res) => {
  const { email } = req.body;
  try {
    const summary = `Summary: ${email.substring(0, 100)}...`;
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: 'Summarization failed' });
  }
});

app.post('/api/reply', checkTier('pro'), async (req, res) => {
  const { email } = req.body;
  try {
    const reply = `Reply suggestion based on: ${email.substring(0, 100)}...`;
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Reply suggestion failed' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
