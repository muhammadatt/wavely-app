import { ref } from 'vue'
import { useWindows } from './useWindows.js'
import { createEqInstance } from './useEqInstance.js'
import { manualEqEffect } from '../audio/effects/manualEq.js'
import { createBand, DEFAULT_GENERAL_BANDS } from '../audio/eqBands.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const MANUAL_EQ_WINDOW_ID = 'manual-eq'

/**
 * General mode — a conventional parametric EQ, and nothing else.
 *
 * VoiceRx used to share this pool as a second view. It is a separate plugin now
 * (useVoiceRx.js) with its own pool and its own node in the chain; see the note
 * at the top of useEqInstance.js for why the shared-pool design was abandoned.
 * Nothing here knows about roles, analysis or suggestions any more.
 */
/**
 * Eight bands, not the model's twelve.
 *
 * Every band is a strip on the faceplate and eight is what fits across a
 * 720 px window. A ninth wraps to a second row, which pushes Apply off the
 * bottom of the window — so the limit is set by what the control surface can
 * show rather than by leaving bands reachable only by scrolling to them.
 * VoiceRx keeps the higher limit: its bands are role knobs, and there are nine
 * roles.
 */
const GENERAL_MAX_BANDS = 8

const instance = createEqInstance({
  effect: manualEqEffect,
  windowId: MANUAL_EQ_WINDOW_ID,
  label: 'EQ',
  maxBands: GENERAL_MAX_BANDS,
})

// On by default — the whole point of the plot is reading your curve against
// what is actually in the audio, and a reader who does not know the toggle
// exists never sees the more useful half of the display.
const showAnalyzer = ref(true)

/**
 * Take a set of bands from elsewhere and open the window on them.
 *
 * Standalone rather than a method so VoiceRx can hand over without reaching into
 * this composable's lifecycle. The bands arrive as plain specs with no role —
 * once they are here they are ordinary parametric bands, and the frequency and
 * Q that VoiceRx measured is all that survives the trip.
 */
export function receiveBands(specs) {
  const result = instance.use().adoptBands(
    specs.map(s => ({ ...s, role: null, origin: 'manual_general' })),
  )
  useWindows().openWindow(MANUAL_EQ_WINDOW_ID)
  return result
}

export function useManualEq() {
  const api = instance.use()

  /**
   * The layout General mode opens with, if the pool is empty.
   *
   * Only ever adds to an empty pool, so it cannot appear on top of a user's
   * work. Every shape in the set is exactly unity at 0 dB, so opening the
   * window cannot change what is heard.
   */
  function seedGeneralBands() {
    if (api.bands.value.length > 0) return
    api.bands.value = DEFAULT_GENERAL_BANDS.map(spec =>
      createBand({ ...spec, gainDb: 0, origin: 'manual_general' }))
    api.pushBands()
  }

  /**
   * Put the faceplate back how it opened.
   *
   * "Reset" that empties the pool is the wrong reading of the word on a plugin
   * that opens with a layout: it leaves you somewhere you cannot get back to
   * without closing and reopening the window. Restoring the four neutral bands
   * undoes the edits, which is what the button is for.
   */
  function resetBands() {
    api.clearBands()
    seedGeneralBands()
  }

  return { ...api, showAnalyzer, seedGeneralBands, resetBands }
}
