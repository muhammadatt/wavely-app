import { ref } from 'vue'

/**
 * Whether the category toolbar sits IN the header (one row) or in its own row
 * under it.
 *
 * One row needs about 1100 px: the logo, search, the categories, Chain, Undo /
 * Redo and the account controls. Below that, and on any compact viewport (see
 * the `compact:` variant in main.css), the categories keep their own row — the
 * phone layouts were built and checked as two rows, and a single row there
 * would have to drop the category labels a new user navigates by.
 *
 * ONE matchMedia for the app, so the header and the editor agree on the answer
 * in the same tick and the toolbar is never mounted twice.
 */
export const HEADER_TOOLS_QUERY = '(min-width: 1100px) and (min-height: 521px)'

let headerTools = null

export function useHeaderTools() {
  if (!headerTools) {
    const mq = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(HEADER_TOOLS_QUERY)
      : null
    headerTools = ref(mq ? mq.matches : true)
    mq?.addEventListener?.('change', (e) => { headerTools.value = e.matches })
  }
  return headerTools
}
