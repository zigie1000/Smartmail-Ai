// src/lib/supabase.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('❌ Supabase environment variables are missing');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);
