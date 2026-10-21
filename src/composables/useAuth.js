import { watch } from 'vue'
import { AUTH_ENABLED, SUPABASE_URL, SUPABASE_KEY, API_BASE } from '../auth/config.js'
import { createAuthStore, createAccountFetcher } from '../auth/authStore.js'
import { getSupabase } from '../auth/supabaseClient.js'
import { createAccountPresetBackend } from '../auth/presetBackend.js'
import { setPresetBackend } from '../audio/pluginPresets/store.js'

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
    const client = AUTH_ENABLED ? getSupabase(SUPABASE_URL, SUPABASE_KEY) : null
    store = createAuthStore({ client, fetchAccount: createAccountFetcher(API_BASE) })
    store.start()
    if (client) bindPresetBackend(store, client)
  }
  return store
}

/**
 * User presets follow the session: the account's rows while signed in, none
 * (and no saving) otherwise. With accounts off the store keeps its default
 * localStorage backend, which is why this only runs with a client.
 */
function bindPresetBackend(auth, client) {
  watch(
    () => (auth.state.status === 'signedIn' ? auth.user.value?.id ?? null : null),
    (userId) => {
      setPresetBackend(userId ? createAccountPresetBackend(client, userId) : 'none')
    },
    { immediate: true },
  )
}
