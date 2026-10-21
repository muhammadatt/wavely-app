import { onMounted, onUnmounted } from 'vue'

/**
 * Repaint on-demand canvases after the browser throws their pixels away.
 *
 * A 2D canvas's backing store lives on the GPU, and the browser is free to
 * drop it: a GPU process reset (the page freezes for a few seconds, then
 * carries on) or memory pressure from the decoded audio both do it. The
 * element survives, its bitmap comes back blank, and Chrome fires
 * `contextlost` then `contextrestored`. A canvas redrawn every frame shrugs
 * that off; one painted only when its content changes — the waveform, the
 * overview strip, the file thumbnails — stays blank until something else asks
 * for a redraw. That was the "waveform vanishes, switching tabs brings it back"
 * bug: the tab switch was the only thing that called drawAll() again, so with
 * one document open it never came back.
 *
 * `contextlost` is deliberately NOT cancelled — for a 2D context, cancelling
 * it tells the browser not to restore the context at all.
 *
 * Returning to a hidden page also repaints, as a fallback for browsers that
 * discard background canvases without firing either event.
 *
 * @param {() => Array<HTMLCanvasElement|null|undefined>} getCanvases
 * @param {() => void} redraw
 */
export function useCanvasRecovery(getCanvases, redraw) {
  let attached = []

  function onVisibility() {
    if (document.visibilityState === 'visible') redraw()
  }

  onMounted(() => {
    attached = getCanvases().filter(Boolean)
    for (const el of attached) el.addEventListener('contextrestored', redraw)
    document.addEventListener('visibilitychange', onVisibility)
  })

  onUnmounted(() => {
    for (const el of attached) el.removeEventListener('contextrestored', redraw)
    attached = []
    document.removeEventListener('visibilitychange', onVisibility)
  })
}
