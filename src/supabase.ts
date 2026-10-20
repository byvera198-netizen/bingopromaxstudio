import { createClient } from '@supabase/supabase-js'

// These are publishable Supabase values. A deployment can override them with
// VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY without changing code.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? 'https://qidfcahfwvdbysaszfhl.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_YMUMwP2WAwEow03fi-nlJA_gYu0-uTK'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
  },
})
