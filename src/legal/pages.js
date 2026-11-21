/**
 * The legal pages: which Markdown file each URL shows.
 *
 * The documents themselves are plain Markdown in `src/content/legal/` — edit
 * them there (on GitHub's web editor if you like). The dev server reloads the
 * page on save; production picks the change up on the next deploy.
 *
 * Adding a page is a file in that folder and an entry here.
 */
export const LEGAL_PAGES = {
  terms: { file: 'terms.md', label: 'Terms of Service' },
  privacy: { file: 'privacy.md', label: 'Privacy Policy' },
}

/** `/terms/`, `/privacy` → 'terms' / 'privacy'; anything else → null. */
export function legalPageFromPath(pathname) {
  const m = /^\/([a-z-]+)\/?$/.exec(pathname || '')
  return m && LEGAL_PAGES[m[1]] ? m[1] : null
}

export const legalUrl = id => `/${id}/`
