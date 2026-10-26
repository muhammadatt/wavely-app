/**
 * What the current user may do, as reactive answers over the auth store and
 * the shared feature table (src/auth/plans.js).
 *
 * With accounts off (`status: 'disabled'`) EVERYTHING is allowed: a build
 * without Supabase configured behaves exactly as before accounts existed, and
 * the server lets the same requests through (server/lib/entitlements.js).
 */

import { computed } from 'vue'
import { hasFeature, blockerFor, allowsPreview, FEATURES, FREE_PREVIEW_SECONDS } from './plans.js'

export function createEntitlements(auth) {
  const gatingActive = computed(() => auth.state.status !== 'disabled')

  /** May the user use this feature now? */
  function can(featureId) {
    if (!gatingActive.value) return true
    return hasFeature(auth.plan.value, featureId)
  }

  /** null | 'signIn' | 'upgrade' */
  function blocker(featureId) {
    if (!gatingActive.value) return null
    return blockerFor(auth.plan.value, featureId)
  }

  /** One line for a disabled control's tooltip or caption, or '' when allowed. */
  function hint(featureId) {
    const b = blocker(featureId)
    if (!b) return ''
    const label = FEATURES[featureId].label
    return b === 'signIn' ? `Sign in to use ${lowerFirst(label)}` : `${label} is a Pro feature`
  }

  /**
   * Gate an action: true when allowed; otherwise opens the sign-in or upgrade
   * prompt and returns false. Call it from the click, before the work.
   */
  function request(featureId) {
    const b = blocker(featureId)
    if (!b) return true
    if (b === 'signIn') auth.openDialog('signUp')
    else auth.openUpgrade(featureId)
    return false
  }

  /**
   * Longest selection (seconds) this user may send for a server feature, or
   * Infinity when not limited. Matches the server's check.
   */
  function previewLimit(featureId) {
    if (can(featureId)) return Infinity
    return allowsPreview(featureId) ? FREE_PREVIEW_SECONDS : 0
  }

  /**
   * Handle an API error: true if it was a plan refusal (and the prompt is
   * open). A feature any account unlocks asks for a sign-in, not an upgrade.
   */
  function handleServerRefusal(err) {
    if (!err?.upgrade) return false
    if (err.upgrade.requires === 'free') auth.openDialog('signUp')
    else auth.openUpgrade(err.upgrade.feature)
    return true
  }

  return { gatingActive, can, blocker, hint, request, previewLimit, handleServerRefusal }
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1)
}
