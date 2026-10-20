import { ref } from 'vue'
import { useWindows } from './useWindows.js'
import { createEqInstance } from './useEqInstance.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import { manualEqEffect } from '../audio/effects/manualEq.js'
import { createBand, DEFAULT_GENERAL_BANDS } from '../audio/eqBands.js'
import { PARAMETRIC_EQ_MAX_BANDS, presetBand } from '../audio/pluginPresets/parametricEq.js'

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
const GENERAL_MAX_BANDS = PARAMETRIC_EQ_MAX_BANDS

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own bands, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const instance = createEqInstance({
    effect: effectForCopy(manualEqEffect, copy),
    windowId: idForCopy(MANUAL_EQ_WINDOW_ID, copy),
    life,
    label: 'EQ',
    maxBands: GENERAL_MAX_BANDS,
  })

  // On by default — the whole point of the plot is reading your curve against
  // what is actually in the audio, and a reader who does not know the toggle
  // exists never sees the more useful half of the display.
  const showAnalyzer = ref(true)

  /**
   * Gain axis range: 'auto', or a fixed number of dB either side.
   *
   * Auto, whose floor is ±12 (see AUTO_FLOOR_DB in EqPlot). Pinning it at ±12
   * instead was tried and is worse: bands go to ±18, so any pinned range below
   * that lets a bell run into the ceiling and flatten off, which reads as the
   * display breaking rather than as the band reaching its limit. Auto keeps the
   * whole curve on the plot at every gain while still starting somewhere roomy.
   *
   * The ±6 stop is where the tighter view went — useful for 1 dB work, just not
   * as the thing you land on by default.
   */
  const dbRange = ref('auto')


  function useManualEq() {
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

    /** The band set as a preset stores it (pluginPresets/parametricEq.js). */
    function presetParams() {
      return { bands: api.bands.value.map(presetBand) }
    }

    /** Put a preset's band set into effect, replacing the current one. */
    function applyPreset(p) {
      api.clearBands()
      api.adoptBands((p.bands ?? []).map(b => ({ ...b, origin: 'manual_general' })))
    }

    return { ...api, showAnalyzer, dbRange, seedGeneralBands, resetBands, presetParams, applyPreset }
  }

  return useManualEq
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function useManualEq() {
  return copies()()
}

/**
 * Take a set of bands from elsewhere and open the window on them.
 *
 * Standalone rather than a method so VoiceRx can hand over without reaching into
 * this composable's lifecycle. The bands arrive as plain specs with no role —
 * once they are here they are ordinary parametric bands, and the frequency and
 * Q that VoiceRx measured is all that survives the trip.
 *
 * `copy` is which EQ receives them: the solo one by default, or a chain copy
 * when VoiceRx is itself a slot (see sendToEq in useVoiceRx.js).
 */
export function receiveBands(specs, { copy = 'solo', open = true } = {}) {
  const result = copies(copy)().adoptBands(
    specs.map(s => ({ ...s, role: null, origin: 'manual_general' })),
  )
  if (open) useWindows().openWindow(idForCopy(MANUAL_EQ_WINDOW_ID, copy))
  return result
}
