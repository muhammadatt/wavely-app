/**
 * The editor shell this visit uses ('desktop' | 'mobile'), chosen once at
 * startup by `pickLayout` (src/ui/formFactor.js), and the user's override.
 * Choosing a layout swaps the shell at once and is remembered per browser;
 * the documents, undo history and plugin state live outside the shells, so
 * nothing is lost by the swap.
 */
import { ref } from 'vue'
import { LAYOUT_STORAGE_KEY, LAYOUTS, pickLayout } from '../ui/formFactor.js'

function readOverride() {
  try { return globalThis.localStorage?.getItem(LAYOUT_STORAGE_KEY) ?? null } catch { return null }
}

function detect(override) {
  const w = globalThis.window
  if (!w) return 'desktop'
  return pickLayout({
    width: w.screen?.width || w.innerWidth,
    height: w.screen?.height || w.innerHeight,
    coarsePointer: !!w.matchMedia?.('(pointer: coarse)').matches,
    override,
  })
}

const layout = ref(detect(readOverride()))
/** This device is a phone (its default layout is the mobile one), whatever was chosen. */
const isPhone = detect(null) === 'mobile'

export function useFormFactor() {
  /** Use `next` from now on, in this browser. */
  function chooseLayout(next) {
    if (!LAYOUTS.includes(next)) return
    try { globalThis.localStorage?.setItem(LAYOUT_STORAGE_KEY, next) } catch { /* kept for this visit only */ }
    layout.value = next
  }
  return { layout, isPhone, chooseLayout }
}
