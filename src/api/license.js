import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/license?email=example@example.com
export async function getLicense(req, res) {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Missing email parameter' });
  }

  const { data, error } = await supabase
    .from('licenses')
    .select('tier, product')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Error checking license' });
  }

  if (!data) {
    return res.status(404).json({ tier: 'free', reason: 'License not found' });
  }

  return res.json({
    tier: data.tier,
    product: data.product || 'SmartEmail',
  });
}
