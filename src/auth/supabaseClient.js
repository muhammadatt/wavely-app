import { createClient } from '@supabase/supabase-js'

let client = null

/**
 * The browser's Supabase client, created on first use.
 *
 * PKCE rather than the implicit flow: email links and OAuth return with a
 * one-time `?code=` that is exchanged for a session, instead of tokens in the
 * URL fragment where browser history and extensions can read them.
 *
 * The session persists in localStorage and refreshes itself, and supabase-js
 * keeps tabs in sync — signing in from an email link opened in a new tab signs
 * this tab in too, which matters here because leaving the editor tab would
 * cost the user their unsaved work.
 */
export function getSupabase(url, key) {
  if (!client) {
    client = createClient(url, key, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }
  return client
}
