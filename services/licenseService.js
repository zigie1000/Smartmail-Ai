// services/licenseService.js
import { supabase } from '../supabaseClient.js';

export async function getLicenseByEmail(email) {
  if (!email) return null;
  // DO NOT select non-existent "tier" column
  const { data, error } = await supabase
    .from('licenses')
    .select('email, license_key, smartemail_tier')
    .eq('email', email.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}
