/**
 * The account dashboard's address: `#/account` or `#/account/<section>`.
 *
 * A hash, not a route: the editor is one page whose documents live only in
 * memory, so the dashboard is a layer over it, never a navigation away from
 * it. The hash gives it what a page would have — Back closes it, and a link
 * (an email, the payment-failed pill, a portal return) opens a section.
 *
 * Pure, so it is testable under `node --test`; `useAccountScreen` owns the
 * history calls.
 */

export const ACCOUNT_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'billing', label: 'Plan & billing' },
  { id: 'security', label: 'Security' },
]

export const DEFAULT_SECTION = 'overview'

const SECTION_IDS = new Set(ACCOUNT_SECTIONS.map(s => s.id))

/**
 * The section a hash asks for, or null when it is not an account hash.
 * An unknown section falls back to the overview rather than to nothing —
 * a stale link still lands on the dashboard.
 */
export function parseAccountHash(hash) {
  const m = /^#\/account(?:\/([^/?#]*))?\/?$/.exec(String(hash ?? ''))
  if (!m) return null
  const section = (m[1] ?? '').toLowerCase()
  return SECTION_IDS.has(section) ? section : DEFAULT_SECTION
}

/** The hash for a section ('#/account' for the overview). */
export function accountHash(section = DEFAULT_SECTION) {
  return !section || section === DEFAULT_SECTION ? '#/account' : `#/account/${section}`
}

/** `href` with the hash replaced (or removed with ''). */
export function withHash(href, hash) {
  const url = new URL(href)
  url.hash = hash
  return hash ? url.toString() : url.toString().replace(/#$/, '')
}
