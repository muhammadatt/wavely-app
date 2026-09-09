import { ref } from 'vue'
import { la2aTuningOverrides } from '../audio/effects/la2aTuning.js'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applySchepsRegion, computeSchepsTrim, computePeakCache } from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { getEffectChain } from '../audio/effectChain.js'
import { schepsEffect, SCHEPS_DEFAULTS } from '../audio/effects/scheps.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SCHEPS_WINDOW_ID = 'scheps-parallel'

// Singleton reactive state shared between the sidebar trigger and the modal.
const schepsCharacter = ref(SCHEPS_DEFAULTS.character)
const schepsSquash = ref(SCHEPS_DEFAULTS.squash)
const schepsMix = ref(SCHEPS_DEFAULTS.mix)
const schepsOutput = ref(SCHEPS_DEFAULTS.output)

/**
 * The two measured numbers behind the blend: the wet-path trim, and the
 * dry/wet correlation that corrects the mix law. Both come from the region
 * being edited, so they follow the material.
 *
 * Auto trim is on by default, for the same reason the compressors' auto makeup
 * is: without it, pushing Mix mostly makes things louder, and every A/B the
 * user runs is then decided by loudness rather than by character — which is the
 * one comparison this plugin exists to let them make honestly.
 */
const schepsAutoTrim = ref(true)
const schepsAutoTrimBusy = ref(false)
const schepsWetTrimDb = ref(SCHEPS_DEFAULTS.wetTrimDb)
const schepsCorrelation = ref(SCHEPS_DEFAULTS.correlation)
const schepsDensityDb = ref(SCHEPS_DEFAULTS.densityDb)
/**
 * The ceiling the last trim measurement produced, dBFS, or null. Measured
 * state alongside the other three, and it rides in `currentParams()` for the
 * same reason they do — so preview and apply cannot disagree about it.
 */
const schepsCeilingDb = ref(SCHEPS_DEFAULTS.ceilingDb)

/**
 * INPUT ALIGNMENT for the embedded compressor — see `dsp/inputAlign.js`.
 *
 * ⚠ NO SWITCH, UNLIKE OPTOSMOOTH, AND THAT IS DELIBERATE. There the toggle
 * exists because a user who understands that the knob is side-chain gain may
 * want the raw hardware behaviour to exploit it. Scheps has no Peak Reduction
 * knob to exploit — `squash` is a calibrated default and the panel does not
 * present it as a threshold — so "off" would only ever mean "the plugin does
 * less than it was voiced to do on a quiet file", which is not a setting anyone
 * would choose on purpose. If the switch is ever wanted here it should be the
 * same control, shared, rather than a second one that can disagree.
 */
const schepsInputAlignDb = ref(SCHEPS_DEFAULTS.inputAlignDb)
/**
 * Which timeline the offset above was measured from — `docId:revision`.
 *
 * ⚠ A NULL CHECK CANNOT ANSWER "IS THIS STILL THE RIGHT FILE", and this state
 * is a module singleton that outlives the document under it. The first version
 * refreshed only while `schepsInputAlignDb` was null, so it measured the FIRST
 * file this panel ever saw and then never again: switching documents left the
 * embedded compressor and the trim solve running the old file's offset, and
 * because the selection watcher calls `refreshAutoTrim`, every re-measure after
 * that reinforced it. `setActiveDocument` does not touch plugin state.
 */
let alignedFor = null

const schepsPreview = ref(false)
const schepsReduction = ref(0)
const schepsInputLevels = ref([])
const schepsOutputLevels = ref([])
let meterId = null

// Debounce + supersede state for the trim measurement, shared across every
// useScheps() caller so knob drags coalesce into one measurement. This pass is
// heavier than the compressors' — it runs two EQ cascades and the opto cell —
// so the window is longer than theirs.
const TRIM_DEBOUNCE_MS = 90
let trimTimer = null
let trimSeq = 0
let trimBurstActive = false
let trimBurstDirty = false

function currentParams() {
  return {
    character: schepsCharacter.value,
    squash: schepsSquash.value,
    mix: schepsMix.value,
    output: schepsOutput.value,
    wetTrimDb: schepsWetTrimDb.value,
    correlation: schepsCorrelation.value,
    densityDb: schepsDensityDb.value,
    /**
     * ⚠ ONLY WHILE AUTO OWNS THE TRIM. With AUTO off the wet trim is the user's
     * and there is no measured ceiling behind it; enforcing a stale one would
     * attenuate a setting they made deliberately. Same rule `useLA2A` follows.
     */
    ceilingDb: schepsAutoTrim.value ? schepsCeilingDb.value : null,
    /**
     * ⚠ INDEPENDENT OF AUTO TRIM, unlike the ceiling. The ceiling is half of the
     * trim solve and leaves with it; alignment decides how much the embedded
     * cell does at all, and turning the trim off is not a reason to hand back a
     * compressor that does nothing on a quiet file.
     */
    inputAlignDb: schepsInputAlignDb.value,
  }
}

/** Params for the measurement pass — the trim is what we're solving for. */
function measurementParams() {
  return {
    character: schepsCharacter.value,
    squash: schepsSquash.value,
    /**
     * ⚠ THE BENCH TUNING BELONGS IN THE MEASUREMENT — see the same note in
     * `useLA2A.js` for the measured cost. The trim renders the wet path to solve
     * itself, so a solve that does not know the bench is levelling a different
     * compressor from the one being auditioned.
     *
     * NESTED, unlike OptoSmooth's. `SchepsKernel` spreads `la2aTuning` into its
     * embedded `la2a.setParams` after its own allowlist; flattening it here
     * would collide with Scheps' own `cellMod` kernel param. Absent while the
     * bench is untouched, so a normal measurement is unchanged.
     */
    ...la2aTuningFor(),
    /**
     * ⚠ AND SO DOES THE ALIGNMENT, for the same reason and with more at stake.
     * The trim solve renders the wet path; on a file well below nominal the
     * aligned and unaligned kernels differ by the whole of the gain reduction,
     * so a solve that does not know the offset is levelling a compressor that
     * is barely working against one that is.
     *
     * FLAT, not nested: `inputAlignDb` is a Scheps kernel param in its own
     * right (`SchepsKernel` forwards it to the embedded `la2a.setParams`), so
     * it does not need the `la2aTuning` envelope and has no key to collide
     * with.
     */
    ...(Number.isFinite(schepsInputAlignDb.value)
      ? { inputAlignDb: schepsInputAlignDb.value } : {}),
  }
}

/** The nested shape `SchepsKernel` expects, or nothing while at defaults. */
function la2aTuningFor() {
  const overrides = la2aTuningOverrides()
  return Object.keys(overrides).length > 0 ? { la2aTuning: overrides } : {}
}

export function useScheps() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === schepsEffect.id)) {
      chain.addEffect(schepsEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === schepsEffect.id)?.nodes
      if (nodes) {
        schepsReduction.value = nodes.getReduction()
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        schepsInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        schepsOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
      }
      meterId = requestAnimationFrame(tick)
    }
    meterId = requestAnimationFrame(tick)
  }

  function stopMeters() {
    if (meterId !== null) {
      cancelAnimationFrame(meterId)
      meterId = null
    }
    schepsReduction.value = 0
    schepsInputLevels.value = []
    schepsOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(schepsEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    schepsPreview.value = !schepsPreview.value
    chain.setEnabled(schepsEffect.id, schepsPreview.value)

    if (schepsPreview.value) {
      // Before pushAllParams, which pushes `currentParams()` — otherwise
      // preview starts on a stale or unmeasured offset.
      refreshInputAlign()
      pushAllParams(chain)
      startMeters(chain)
      refreshAutoTrim()
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!schepsPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(schepsEffect.id, name, value)
  }

  /**
   * Measure the file's alignment offset for the embedded compressor and push it.
   *
   * ⚠ THE WHOLE FILE, IGNORING THE SELECTION — see `regionAlignDb`. Scheps
   * applies to a selection, so this is the one measurement here that is
   * deliberately NOT scoped to it: a per-selection offset would make the
   * embedded cell a different compressor on every selection, and two applies
   * over overlapping ranges would not agree.
   *
   * ⚠ AND BEFORE THE TRIM SOLVE, which consumes it — the trim renders the wet
   * path, so a stale offset means levelling the wrong compressor.
   */
  function refreshInputAlign() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (alignedFor === key) return // already measured for this exact timeline
    const end = totalDuration.value
    if (!(end > 0)) return
    const db = regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    alignedFor = key
    schepsInputAlignDb.value = db
    pushParam('inputAlignDb', db)
  }

  /**
   * Re-measure the wet trim and correlation for the current selection and
   * settings. Superseded calls are discarded by sequence number so a fast knob
   * drag can't have an older measurement land after a newer one.
   */
  async function refreshAutoTrim() {
    /**
     * ⚠ BEFORE THE GUARDS, NOT AFTER. Alignment is not part of the trim solve —
     * it decides how hard the embedded cell works at all — so gating it behind
     * AUTO TRIM or behind a selection left the live compressor on a stale
     * offset in both cases. It is cheap and idempotent: keyed on the timeline,
     * so repeat calls cost a string compare.
     */
    refreshInputAlign()
    if (!schepsAutoTrim.value || !state.selection || !state.currentFile) return

    const { start, end } = state.selection
    const seq = ++trimSeq
    schepsAutoTrimBusy.value = true
    try {
      const { trimDb, correlation, densityDb, ceilingDb } = await computeSchepsTrim(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== trimSeq) return // a newer measurement is already in flight
      /**
       * ⚠ THE CEILING GOES FIRST, AND THE ORDER IS THE GUARANTEE — the same
       * ordering `useLA2A` needs. These reach the live node as separate param
       * messages, so between them it holds one old value and one new one; trim
       * first would run the raised wet path against the old ceiling, or none.
       */
      schepsCeilingDb.value = ceilingDb
      pushParam('ceilingDb', ceilingDb)
      schepsWetTrimDb.value = trimDb
      schepsCorrelation.value = correlation
      schepsDensityDb.value = densityDb
      pushParam('wetTrimDb', trimDb)
      pushParam('correlation', correlation)
      pushParam('densityDb', densityDb)
    } catch (err) {
      console.error('Scheps auto trim measurement failed:', err)
    } finally {
      if (seq === trimSeq) schepsAutoTrimBusy.value = false
    }
  }

  function scheduleAutoTrim() {
    if (!schepsAutoTrim.value) return

    // Leading edge: the first move in a burst measures immediately so the
    // readout responds right away.
    if (!trimBurstActive) {
      trimBurstActive = true
      trimBurstDirty = false
      refreshAutoTrim()
    } else {
      trimBurstDirty = true
    }

    if (trimTimer !== null) clearTimeout(trimTimer)
    trimTimer = setTimeout(() => {
      trimTimer = null
      const shouldRunTrailing = trimBurstDirty
      trimBurstActive = false
      trimBurstDirty = false
      if (shouldRunTrailing) refreshAutoTrim()
    }, TRIM_DEBOUNCE_MS)
  }

  // Only the two params that change what the wet path sounds like need a
  // re-measure. Mix does not: the trim is a property of the wet path alone, and
  // the mix law already accounts for the blend. Output does not either — it is
  // a deliberate deviation applied after everything.
  function syncCharacter(v) {
    schepsCharacter.value = v
    pushParam('character', v)
    scheduleAutoTrim()
  }

  function syncSquash(v) {
    schepsSquash.value = v
    pushParam('squash', v)
    scheduleAutoTrim()
  }

  function syncMix(v) {
    schepsMix.value = v
    pushParam('mix', v)
  }

  function syncOutput(v) {
    schepsOutput.value = v
    pushParam('output', v)
  }

  function toggleAutoTrim() {
    schepsAutoTrim.value = !schepsAutoTrim.value
    if (schepsAutoTrim.value) {
      refreshAutoTrim()
      return
    }

    // Off means no wet trim at all, and a textbook equal-power blend. Leaving
    // the last measured pair in place would be worse than either: the readout
    // would claim a match that stops being true the moment anything changes.
    if (trimTimer !== null) {
      clearTimeout(trimTimer)
      trimTimer = null
    }
    trimBurstActive = false
    trimBurstDirty = false
    trimSeq++ // discard any in-flight measurement
    schepsAutoTrimBusy.value = false
    schepsWetTrimDb.value = 0
    schepsCorrelation.value = 0
    schepsDensityDb.value = 0
    pushParam('wetTrimDb', 0)
    pushParam('correlation', 0)
    pushParam('densityDb', 0)
    /**
     * ⚠ THE CEILING LEAVES WITH AUTO TOO. `currentParams()` already drops it,
     * but the LIVE node has been told about it and would keep enforcing a
     * measured ceiling against a trim the user now owns — a manual setting
     * silently held down, with nothing on the panel saying so.
     */
    schepsCeilingDb.value = null
    pushParam('ceilingDb', null)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    /**
     * ⚠ RE-MEASURED HERE EVEN THOUGH THE TRIM IS NOT. The trim is held in state
     * from the preview the user actually heard, deliberately; the alignment is
     * a property of the FILE, and the file can have been edited since the panel
     * was opened. Applying against a stale offset would render a different
     * compressor from the one auditioned.
     */
    refreshInputAlign()

    const wasPreviewing = schepsPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Scheps Parallel...')
    try {
      const buffer = await applySchepsRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'Scheps Parallel')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Scheps Parallel applied')
    } catch (err) {
      console.error('Scheps Parallel failed:', err)
      showToast('Scheps Parallel failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (schepsPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(schepsEffect.id, false)
      schepsPreview.value = false
    }
  }

  function openModal() {
    openWindow(SCHEPS_WINDOW_ID)
    // The file may have changed, or been edited, since the last measurement.
    refreshInputAlign()
  }

  function closeModal() {
    closeWindow(SCHEPS_WINDOW_ID)
  }

  return {
    schepsCharacter,
    schepsSquash,
    schepsMix,
    schepsOutput,
    schepsAutoTrim,
    schepsAutoTrimBusy,
    schepsWetTrimDb,
    schepsCorrelation,
    schepsDensityDb,
    schepsPreview,
    schepsReduction,
    schepsInputLevels,
    schepsOutputLevels,
    hasSelection,
    togglePreview,
    syncCharacter,
    syncSquash,
    syncMix,
    syncOutput,
    toggleAutoTrim,
    refreshAutoTrim,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
