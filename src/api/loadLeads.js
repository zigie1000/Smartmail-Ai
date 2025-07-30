const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*');

  if (error) {
    return res.status(500).json({ error: 'Failed to load leads' });
  }

  res.json(data);
});

module.exports = router;
