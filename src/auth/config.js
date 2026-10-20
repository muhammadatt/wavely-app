/**
 * Account settings, read from the Vite env at build time.
 *
 * Accounts are OFF unless both Supabase variables are set. Off means off: no
 * Supabase client is created, nothing is fetched, and the top bar shows no
 * sign-in button — the app behaves exactly as it did before accounts existed.
 * That is the rollout switch, and it is also why a fresh checkout runs with no
 * setup.
 *
 *   VITE_SUPABASE_URL              https://<project>.supabase.co
 *   VITE_SUPABASE_PUBLISHABLE_KEY  the project's publishable key (sb_publishable_…);
 *                                  VITE_SUPABASE_ANON_KEY (legacy anon key) also works
 *   VITE_AUTH_PROVIDERS            optional, comma-separated OAuth providers that are
 *                                  enabled in the Supabase dashboard, e.g. "google"
 *
 * Both keys are PUBLIC by design — row-level security is what protects the
 * data. The service/secret key belongs on the API server only.
 */

// `import.meta.env` is Vite's; under `node --test` it does not exist.
const env = import.meta.env ?? {}

export const SUPABASE_URL = (env.VITE_SUPABASE_URL ?? '').trim()
export const SUPABASE_KEY = (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '').trim()

export const AUTH_ENABLED = SUPABASE_URL !== '' && SUPABASE_KEY !== ''

const KNOWN_PROVIDERS = ['google', 'apple', 'github']

/** OAuth providers the sign-in dialog offers, in the order given. */
export const AUTH_PROVIDERS = parseProviders(env.VITE_AUTH_PROVIDERS)

export const API_BASE = env.VITE_API_BASE_URL ?? ''

export function parseProviders(raw) {
  return [...new Set(String(raw ?? '')
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => KNOWN_PROVIDERS.includes(p)))]
}
