import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /api/loadLeads
export async function loadLeads(req, res) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Missing email in request' });
  }

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('email', email)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to load leads' });
  }

  return res.json({ leads: data });
}
