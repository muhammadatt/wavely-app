/**
 * Server-side Supabase client, authenticated with the service key.
 *
 * ⚠ THE SERVICE KEY BYPASSES ROW-LEVEL SECURITY. It must never reach the
 * browser, and every query made with this client has to scope itself to the
 * user the request was authenticated as — the database will not do it for us.
 */

import { createClient } from '@supabase/supabase-js'

let cached = null

/** The admin client, or null when SUPABASE_URL / the service key are unset. */
export function getSupabaseAdmin({ supabaseUrl, serviceKey }) {
  if (!supabaseUrl || !serviceKey) return null
  if (!cached) {
    cached = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  return cached
}

/**
 * Load the account record for an authenticated user: profile plus
 * subscriptions. Creates the profile if the sign-up trigger never ran (a user
 * who signed up before the migration was applied).
 */
export async function loadAccount(admin, user) {
  let { data: profile, error } = await admin
    .from('profiles')
    .select('id, email, display_name, created_at')
    .eq('id', user.id)
    .maybeSingle()
  if (error) throw error

  if (!profile) {
    ;({ data: profile, error } = await admin
      .from('profiles')
      .upsert({ id: user.id, email: user.email }, { onConflict: 'id' })
      .select('id, email, display_name, created_at')
      .single())
    if (error) throw error
  }

  const { data: subscriptions, error: subError } = await admin
    .from('subscriptions')
    .select('id, plan, status, current_period_end, cancel_at_period_end')
    .eq('user_id', user.id)
  if (subError) throw subError

  return { profile, subscriptions: subscriptions ?? [] }
}
