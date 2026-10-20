import { AUTH_ENABLED, SUPABASE_URL, SUPABASE_KEY, API_BASE } from '../auth/config.js'
import { createAuthStore, createAccountFetcher } from '../auth/authStore.js'
import { getSupabase } from '../auth/supabaseClient.js'

/**
 * The app's one auth store. See src/auth/authStore.js for the state machine and
 * src/auth/config.js for how accounts are switched on.
 *
 * With accounts off this returns a store whose status is 'disabled' and whose
 * actions do nothing — callers never need to check AUTH_ENABLED themselves.
 */
let store = null

export function useAuth() {
  if (!store) {
    store = createAuthStore({
      client: AUTH_ENABLED ? getSupabase(SUPABASE_URL, SUPABASE_KEY) : null,
      fetchAccount: createAccountFetcher(API_BASE),
    })
    store.start()
  }
  return store
}
