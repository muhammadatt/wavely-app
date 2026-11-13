/**
 * Which help page a URL asks for: `/help/` (or `/help`) is the index, and
 * `/help/<slug>/` is an effect's page, named for the product (`la-vintage-2a`;
 * `helpSlug` in src/content/help/index.js). Returns the slug, or null for the
 * index; an unknown slug is the page's to report as not found.
 *
 * Pure so the test can pin it without a DOM.
 */
export function helpSlugFromPath(pathname) {
  const m = /^\/help\/?([^/]*)\/?$/.exec(pathname || '')
  if (!m) return null
  const slug = decodeURIComponent(m[1] || '')
  return slug || null
}
