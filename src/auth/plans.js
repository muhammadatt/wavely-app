/**
 * Plans and the features they unlock — ONE table, read by the browser and the
 * API server alike (the server imports this file, as it does src/audio/presets.js).
 *
 * Two copies of an entitlement rule drift, and the drift is invisible until a
 * Pro user is refused by the server for something the UI just offered them.
 *
 * The ladder:
 *
 *   null    signed out (or accounts off — see `gatingActive`)
 *   'free'  any account
 *   'pro'   a paid subscription
 *
 * A feature names the LOWEST rung that may use it; every rung above inherits it.
 * Adding a paid tier is a new rung in PLAN_ORDER and, where it differs, a
 * `requires` change here — nothing else in the app hard-codes a plan name.
 *
 * ⚠ BROWSER-SIDE GATES ARE PRODUCT LIMITS, NOT SECURITY. The DSP for client
 * plugins ships to every visitor; hiding Apply stops honest use, not a
 * determined one. Only `server: true` features are enforced, by the API.
 */

/** Plans in rank order, lowest first. */
export const PLAN_ORDER = ['free', 'pro']

export const PLAN_LABELS = { free: 'Free', pro: 'Pro' }

/**
 * Server features may be run by anyone on a short clip, so the result can be
 * HEARD before it is paid for — the preview-before-paywall rule — while a whole
 * file's worth of server time stays a Pro thing. The client sends at most this
 * much; the server re-checks the decoded duration rather than trusting it.
 */
export const FREE_PREVIEW_SECONDS = 30

/**
 * id -> { requires, label, server?, preview? }
 *
 *   requires  lowest plan that may use it ('free' = any account)
 *   server    enforced by the API, not just hidden in the UI
 *   preview   non-entitled users may run it on ≤ FREE_PREVIEW_SECONDS of audio
 */
export const FEATURES = {
  // Anything stored against the user needs somewhere to store it.
  savePresets: { requires: 'free', label: 'Saving presets' },

  // Real-time plugins: full preview for everyone, Apply needs Pro.
  pluginChainApply: { requires: 'pro', label: 'The Plugin Chain' },

  // Server processing: Pro, with a short preview for everyone else.
  autoLevel: { requires: 'pro', label: 'Auto Leveler', server: true, preview: true },
  sibilanceEditor: { requires: 'pro', label: 'Sibilance Editor', server: true, preview: true },
  spotEffects: { requires: 'pro', label: 'Server spot effects', server: true, preview: true },

  // The preset mastering chain: any account, so the whole-file result stays
  // free while the most expensive server work is tied to a sign-in. Signed-out
  // visitors still get the preview on a short clip.
  mastering: { requires: 'free', label: 'Mastering', server: true, preview: true },
}

/** Rank of a plan: -1 signed out, 0 free, 1 pro… Unknown plans rank as signed out. */
export function planRank(plan) {
  return plan == null ? -1 : PLAN_ORDER.indexOf(plan)
}

/** Lowest plan that unlocks `featureId`. Throws on an unknown id — a typo must not open a gate. */
export function requiredPlan(featureId) {
  const feature = FEATURES[featureId]
  if (!feature) throw new Error(`Unknown feature: ${featureId}`)
  return feature.requires
}

/** May a user on `plan` (null = signed out) use `featureId`? */
export function hasFeature(plan, featureId) {
  const need = planRank(requiredPlan(featureId))
  const have = planRank(plan)
  return have >= 0 && have >= need
}

/** May a non-entitled user still run it on a short clip? */
export function allowsPreview(featureId) {
  requiredPlan(featureId)
  return FEATURES[featureId].preview === true
}

/**
 * What stands between a user and a feature:
 *   null        nothing
 *   'signIn'    needs an account (signed out; the feature is free-tier)
 *   'upgrade'   needs a higher plan (signed out users are told to upgrade too,
 *               since signing in alone would not be enough)
 */
export function blockerFor(plan, featureId) {
  if (hasFeature(plan, featureId)) return null
  return requiredPlan(featureId) === 'free' ? 'signIn' : 'upgrade'
}
