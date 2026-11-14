/**
 * Which marketing page a URL asks for: `/plugins/` is the index and
 * `/plugins/<slug>/` an effect's page (`marketingSlug`: the product name, the
 * help page's slug). Returns the slug, or null for the index; an unknown slug
 * is the page's to report as not found. Pure, so the test can pin it.
 */
export function marketingSlugFromPath(pathname) {
  const m = /^\/plugins\/?([^/]*)\/?$/.exec(pathname || '')
  if (!m) return null
  let slug = m[1] || ''
  // A malformed escape must not blank the page; the raw segment matches no slug.
  try { slug = decodeURIComponent(slug) } catch { /* keep the raw segment */ }
  return slug || null
}
