/**
 * Entry for the legal pages (`legal/index.html`, served at `/terms/` and
 * `/privacy/`). It renders the Markdown in `src/content/legal/` — imported
 * raw, so in `vite dev` saving the file reloads the page with the edit.
 *
 * The production build also writes each page's HTML into its own copy of the
 * entry (vite.config.js), so the text is there before this script runs; this
 * re-renders the same Markdown and marks the current page in the nav.
 */
import { renderMarkdown } from './markdown.js'
import { LEGAL_PAGES, legalPageFromPath } from './pages.js'

const sources = import.meta.glob('../content/legal/*.md', { query: '?raw', import: 'default', eager: true })

const id = legalPageFromPath(location.pathname)
const root = document.getElementById('legal')

if (!id) {
  document.title = 'Not found — crisp.fm'
  root.innerHTML = '<h1>Page not found</h1><p><a href="/terms/">Terms of Service</a> · <a href="/privacy/">Privacy Policy</a></p>'
} else {
  const { html, title } = renderMarkdown(sources[`../content/legal/${LEGAL_PAGES[id].file}`] ?? '')
  root.innerHTML = html
  document.title = `${title || LEGAL_PAGES[id].label} — crisp.fm`
  for (const a of document.querySelectorAll('.lg-nav a')) {
    if (a.getAttribute('href') === `/${id}/`) a.setAttribute('aria-current', 'page')
  }
  // A #fragment on load points into text that did not exist until now.
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView()
}
