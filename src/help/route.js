/**
 * Which help page a URL asks for: `/help/` (or `/help`) is the index, and
 * `/help/<window-id>/` is that effect's page. Anything else under `/help/`
 * resolves to an id the page then reports as not found.
 *
 * Pure so the test can pin it without a DOM.
 */
export function helpIdFromPath(pathname) {
  const m = /^\/help\/?([^/]*)\/?$/.exec(pathname || '')
  if (!m) return null
  const id = decodeURIComponent(m[1] || '')
  return id || null
}
