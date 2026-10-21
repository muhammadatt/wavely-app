import { useAuth } from './useAuth.js'
import { createEntitlements } from '../auth/entitlements.js'

/** Plan checks for the current user. See src/auth/entitlements.js. */
let entitlements = null

export function useEntitlements() {
  if (!entitlements) entitlements = createEntitlements(useAuth())
  return entitlements
}
