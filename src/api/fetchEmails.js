import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/fetchEmails?email=example@example.com
export async function fetchEmails(req, res) {
  const email = req.query.email;

  if (!email) {
    return res.status(400).json({ error: 'Missing email parameter' });
  }

  const { data, error } = await supabase
    .from('leads')
    .select('original_message, generated_reply, created_at')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    return res.status(500).json({ error: 'Error fetching emails' });
  }

  return res.json({ leads: data });
}
