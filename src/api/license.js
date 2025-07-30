const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

router.post('/', async (req, res) => {
  const { email } = req.body;
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !data) {
    return res.status(404).json({ status: 'not_found' });
  }

  return res.json({ status: 'ok', tier: data.tier });
});

module.exports = router;
