import { ref } from 'vue'
import { createMeasureThrottle } from './measureThrottle.js'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { fet1176TuningState } from '../audio/effects/fet1176Tuning.js'
import { applyFET1176Region, computeFET1176AutoMakeup, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { fet1176Effect, FET1176_DEFAULTS } from '../audio/effects/fet1176Compressor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { INPUT_TRIM_MAX_DB } from '../audio/dsp/inputAlign.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const FET1176_WINDOW_ID = 'fet-punch'

// Singleton reactive state shared between the sidebar trigger and the modal
const fetInput = ref(FET1176_DEFAULTS.inputDrive)
const fetOutput = ref(FET1176_DEFAULTS.output)
const fetAttack = ref(FET1176_DEFAULTS.attack)
const fetRelease = ref(FET1176_DEFAULTS.release)
const fetRatio = ref(FET1176_DEFAULTS.ratio)
const fetDrive = ref(FET1176_DEFAULTS.fetDrive)
const fetScHpf = ref(FET1176_DEFAULTS.scHpf)
const fetMix = ref(FET1176_DEFAULTS.mix)

// Auto makeup: on by default, and load-bearing here in a way it isn't on the
// OptoSmooth — Input drives the audio path as well as the detector, so a
// 20-point move on that knob swings the output by tens of dB. While auto is
// on the plugin owns the Output knob: measurements are written into fetOutput
// itself, so the knob always shows the gain actually in effect.
/**
 * Input alignment — the same contract OptoSmooth's Input knob has: AUTO owns the
 * value until the user touches it.
 *
 * ⚠ FET PUNCH HAS NO THRESHOLD CONTROL EITHER, so what a knob position DOES was
 * set by the file's level, not by the knob. Measured at Input 55, ratio 4, on a
 * 3 s tone:
 *
 *     peak  -6 dBFS  13.30 dB      peak -24 dBFS   0.85 dB
 *     peak -12 dBFS   8.80 dB      peak -30 dBFS   0.00 dB
 *     peak -18 dBFS   4.31 dB
 *
 * A narrator who gain-staged with headroom got a compressor that did nothing at
 * a mid-travel setting, and a saved patch was only valid at the level it was
 * saved at. With alignment on, all five rows read 8.80 dB.
 *
 * ⚠ NOT A PRESET KEY. It describes the FILE, not the patch — the same argument
 * that keeps `ceilingDb` out of presets. Baking it into a patch is the
 * portability failure alignment exists to remove, one level up.
 */
const fetInputAuto = ref(true)
const fetInputAlignDb = ref(0)
/**
 * Which timeline the offset was measured from — `docId:revision`, or null.
 * Module-singleton state with a document that can change underneath it, so
 * freshness is keyed on identity rather than on null-ness. See `useLA2A.js`.
 */
let fetAlignedFor = null

/**
 * THE MAKEUP REFERENCE, FIXED — the same one OptoSmooth ships, and for the same
 * measured reason.
 *
 * ⚠ PEAK-REFERENCED MAKEUP RAN THE INPUT KNOB BACKWARDS. On the syllabic
 * narration fixture with one plosive at the end of a pause, the plosive
 * survives the FET's attack almost intact, so it pinned the reference for the
 * whole file and compressing harder DELIVERED LESS LEVEL: rms -20.85 dB at
 * Input 50 against -22.56 at 70 and -24.37 at 100, every one of them quieter
 * than the -19.18 source. Referenced to the 99.9th percentile the same sweep
 * holds the body at -17.90 / -17.89 / -18.28 and the ceiling holds the peak at
 * or under the source's -0.45 dBFS throughout.
 *
 * ⚠ IT IS NOT A CHOICE, DELIBERATELY. There is no material on which the peak
 * reference is the better answer — the bench keeps both, which is where a
 * comparison belongs. See `peakOfChannels` in `dsp/makeupReference.js` for what
 * the percentile gives up and `computeFET1176AutoMakeupPlan` for the ceiling
 * that puts it back.
 *
 * ⚠ AND EVERY PATCH, PRESET AND PREVIOUSLY RENDERED FILE NOW SOUNDS DIFFERENT
 * — louder at the same settings, and louder the further up the Input knob.
 */
const MAKEUP_REFERENCE = 'percentile'
/**
 * The ceiling the last measurement produced, dBFS, and its knee width.
 *
 * ⚠ MEASURED STATE, NOT A KNOB, and deliberately not in `FET1176_DEFAULTS`: it
 * is the region's own peak, so it belongs to the audio rather than to the patch
 * — a preset carrying one would apply another file's peak to this one. Exactly
 * the reasoning `inputAlignDb` is kept out of presets for.
 */
const fetCeilingDb = ref(null)
const fetCeilingKneeDb = ref(null)

const fetAutoMakeup = ref(true)
const fetAutoMakeupBusy = ref(false)

// Output knob travel — measured makeup is clamped to it so the knob position
// can never disagree with the value in effect.
const OUTPUT_MIN_DB = -36
const OUTPUT_MAX_DB = 24

const fetPreview = ref(false)
const fetReduction = ref(0)
const fetInputLevels = ref([])
const fetOutputLevels = ref([])
let meterId = null

// Supersede counter for the auto-makeup measurement, shared across every
// caller of this composable so a knob drag coalesces into one measurement.
let makeupSeq = 0

/**
 * ⚠ MODULE-LEVEL, NOT PER-CALLER. The sidebar trigger and the modal both call
 * this composable, and everything else here is a shared singleton for that
 * reason — a throttle created per call would let the two run concurrent
 * measurements, which is the coalescing this exists for, defeated. Created
 * lazily because it closes over `refreshAutoMakeup`, and every instance's
 * closure reads the same singleton state, so the first one is as good as any.
 */
let makeupThrottle = null

function currentParams() {
  return {
    inputDrive: fetInput.value,
    output: fetOutput.value,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpf: fetScHpf.value,
    mix: fetMix.value,
    inputAlignDb: fetInputAlignDb.value,
    /**
     * ⚠ ONLY WHILE AUTO OWNS THE KNOB. The ceiling is the other half of the
     * percentile makeup; once the Output knob is the user's, enforcing a
     * ceiling they never asked for would attenuate a boost they set by hand.
     */
    ceilingDb: fetAutoMakeup.value ? fetCeilingDb.value : null,
    // Leaves with the ceiling it belongs to, for the same reason.
    ceilingKneeDb: fetAutoMakeup.value ? fetCeilingKneeDb.value : null,
  }
}

/** Params for the measurement pass — makeup is what we're solving for. */
function measurementParams() {
  return {
    /**
     * ⚠⚠ THE BENCH TUNING HAS TO REACH THE SOLVE, AND IT DID NOT. These params
     * go to the measurement worker, which is a separate thread with its own
     * module state — `toKernelParams` folds the tuning in for the live worklet
     * and for offline apply, and this path bypasses it. So after changing the
     * curve, the FET position, the attack range or schedule, or the
     * ratio-threshold mode, the makeup and the ceiling knee were solved against
     * the SHIPPING kernel while preview and apply rendered the tuned one.
     */
    ...fet1176TuningState(),
    inputDrive: fetInput.value,
    outputGainDb: 0,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpfHz: fetScHpf.value,
    mix: fetMix.value,
    /**
     * \u26a0 THE OFFSET HAS TO REACH THE MAKEUP SOLVE. It decides how much reduction
     * the cell applies, so a solve run without it solves for a compressor doing
     * a different amount of work and the knob lands wrong.
     */
    inputAlignDb: fetInputAlignDb.value,
    /**
     * ⚠ THE SOLVE MUST BE BOUNDED BY THE KNOB IT LANDS ON. The plan defaults to
     * +/-36 dB; this panel clamps Output to OUTPUT_MIN_DB..OUTPUT_MAX_DB. A
     * solve landing above the knob's travel was clamped afterwards, but the
     * ceiling KNEE had already been sized for the gain the clamp threw away, so
     * the pair no longer described the audio that renders. Bound both together.
     */
    makeupMinDb: OUTPUT_MIN_DB,
    makeupMaxDb: OUTPUT_MAX_DB,
  }
}

export function useFET1176() {
  const { state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast, totalDuration} = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === fet1176Effect.id)) {
      chain.addEffect(fet1176Effect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === fet1176Effect.id)?.nodes
      /**
       * ⚠ THERE IS NO LIVE MAKEUP WRITE-BACK ANY MORE, and it is not an
       * oversight. The kernel's tracker is a running peak by construction —
       * `(P - max|a|)/max|b|` over what has played — and the shipping reference
       * is the 99.9th percentile, which is a statistic over millions of samples
       * that no pair of running extrema can express. Left in, it would have
       * driven the knob to the peak-referenced answer between measurements and
       * the offline solve would have yanked it back: on the narration fixture
       * that is a 3-6 dB fight, visible as the knob jumping on every re-measure
       * and audible as the level doing the same. OptoSmooth's write-back came
       * out for exactly this reason; the tracker itself stays, because the
       * bench still reads it.
       *
       * The cost is that the Output knob now moves on the measurement's cadence
       * (~170 ms) rather than the meter's (~21 ms). That is the honest cadence:
       * it is when the answer actually changes.
       */
      if (nodes) {
        fetReduction.value = nodes.getReduction()
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        fetInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        fetOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    fetReduction.value = 0
    fetInputLevels.value = []
    fetOutputLevels.value = []
  }

  /** Identity of the timeline currently loaded, for the freshness check. */
  function timelineKey() {
    return state.currentFile ? `${appState.activeDocumentId}:${state.revision}` : null
  }

  /**
   * Measure the file's alignment offset and push it.
   *
   * ⚠ THE WHOLE FILE, ALWAYS, IGNORING THE SELECTION — see `regionAlignDb`. A
   * per-selection offset would make this a different compressor on every
   * selection, so the same edit applied to a phrase and to the paragraph
   * containing it would not agree.
   *
   * ⚠ A MANUAL TRIM BELONGS TO THE FILE IT WAS DIALLED ON, so a different
   * document takes the knob back to AUTO rather than inheriting it. Within one
   * document the user's value stands — a new selection or an edit must never
   * walk it back, the rule the Gain knob follows under AUTO. Keyed on the
   * DOCUMENT, not the revision, so editing a file the user trimmed by hand
   * leaves their setting alone.
   */
  function refreshInputAlign() {
    if (!state.currentFile) return
    const key = timelineKey()
    const sameDoc = fetAlignedFor !== null
      && fetAlignedFor.split(':')[0] === String(appState.activeDocumentId)
    if (!fetInputAuto.value) {
      if (sameDoc) return
      fetInputAuto.value = true
    } else if (fetAlignedFor === key) {
      return
    }
    const end = totalDuration.value
    if (!(end > 0)) return
    const db = regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    fetAlignedFor = key
    fetInputAlignDb.value = db
    pushParam('inputAlignDb', db)
  }

  /**
   * The user moved the Input trim: take the knob over from the measurement.
   *
   * ⚠ IT RE-SOLVES THE MAKEUP, because this is a compression change — exactly
   * as an Input knob move is.
   */
  function syncInputAlign(v) {
    const clamped = Math.max(-INPUT_TRIM_MAX_DB, Math.min(INPUT_TRIM_MAX_DB, v))
    fetInputAuto.value = false
    fetAlignedFor = timelineKey()
    fetInputAlignDb.value = clamped
    pushParam('inputAlignDb', clamped)
    resetLiveMakeup()
    scheduleAutoMakeup()
  }

  /** Hand the trim back to the measurement, re-measuring immediately. */
  function enableInputAuto() {
    fetInputAuto.value = true
    fetAlignedFor = null
    refreshInputAlign()
    resetLiveMakeup()
    scheduleAutoMakeup()
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(fet1176Effect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    fetPreview.value = !fetPreview.value
    chain.setEnabled(fet1176Effect.id, fetPreview.value)

    if (fetPreview.value) {
      // Before pushAllParams, not after: it pushes `currentParams()`, so a stale
      // or unmeasured offset would be what preview starts with.
      refreshInputAlign()
      pushAllParams(chain)
      startMeters(chain)
      refreshAutoMakeup()
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!fetPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(fet1176Effect.id, name, value)
  }

  function pushOutput() {
    pushParam('output', fetOutput.value)
  }

  /**
   * Re-measure the auto-makeup for the current selection and settings and
   * drive the Output knob to it. Superseded calls are discarded by sequence
   * number so a fast knob drag can't have an older measurement land after
   * a newer one.
   */
  async function refreshAutoMakeup() {
    if (!fetAutoMakeup.value || !state.currentFile) return

    /**
     * ⚠ NO SELECTION MEANS THE WHOLE FILE, NOT "DON'T MEASURE".
     *
     * This used to bail without a selection, which left the knob at 0 dB while
     * the AUTO lamp stayed lit — so opening the plugin and pressing play with
     * nothing selected gave a compressed signal with the makeup silently
     * negated, under a panel claiming it was applied. Reported exactly that
     * way.
     *
     * The whole file is the right span because it is what preview PLAYS with no
     * selection. Apply still requires a selection; this is about what you hear.
     */
    const start = state.selection ? state.selection.start : 0
    const end = state.selection ? state.selection.end : totalDuration.value
    if (!(end > start)) return
    const seq = ++makeupSeq
    fetAutoMakeupBusy.value = true
    try {
      const { makeupDb, ceilingDb, ceilingKneeDb } = await computeFET1176AutoMakeup(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
        MAKEUP_REFERENCE,
      )
      if (seq !== makeupSeq) return // a newer measurement is already in flight
      /**
       * ⚠ THE CEILING GOES FIRST, AND THE ORDER IS THE GUARANTEE. Each reaches
       * the live node as its own param message, so between them the node holds
       * one old value and one new one. Gain-then-ceiling would leave the raised
       * makeup running for that gap with the old ceiling — or none — which is
       * exactly the overshoot the pairing exists to prevent, audible as a blip
       * on every re-measure during a drag.
       */
      fetCeilingDb.value = ceilingDb
      pushParam('ceilingDb', ceilingDb)
      // With the ceiling, ahead of the gain, and for the same reason: the knee
      // is how hard that ceiling holds, so it must not lag the makeup either.
      fetCeilingKneeDb.value = ceilingKneeDb
      pushParam('ceilingKneeDb', ceilingKneeDb)
      fetOutput.value = Math.max(OUTPUT_MIN_DB, Math.min(OUTPUT_MAX_DB, makeupDb))
      pushOutput()
    } catch (err) {
      console.error('FET Punch auto makeup measurement failed:', err)
    } finally {
      if (seq === makeupSeq) fetAutoMakeupBusy.value = false
    }
  }

  /**
   * Ask for a re-measure. Coalesced by createMeasureThrottle — see there for
   * why this is a throttle and not the debounce it replaced.
   */
  if (!makeupThrottle) makeupThrottle = createMeasureThrottle(refreshAutoMakeup)
  /**
   * Pick up a bench-tuning change on the live node.
   *
   * ⚠ AND RE-MEASURE, because the curve and its position both change the
   * RENDER, and the auto-makeup is solved from the render. Leaving the makeup
   * where it was would show the previous curve's gain against the new one's
   * peaks — which on the `tanh`/MEASURED A/B is several dB and would read as
   * the curves differing in level rather than in colour.
   */
  function refreshKernelTuning() {
    getEffectChain(getAudioContext()).effects
      .find(e => e.id === fet1176Effect.id)?.nodes?.refreshKernelParams?.()
    scheduleAutoMakeup()
  }

  function scheduleAutoMakeup() {
    if (!fetAutoMakeup.value) return
    makeupThrottle.schedule()
  }

  // Params that change how much the compressor reduces (and so how much
  // makeup is needed) trigger a re-measure; the manual trim does not.
  function syncCompressionParam(name, refVar, value) {
    refVar.value = value
    pushParam(name, value)
    /**
     * ⚠ THE LIVE TRACKER'S EXTREMA DESCRIBE THE OLD SETTINGS, so a compression
     * change invalidates them exactly as a new region does — the tracked signal
     * is post-gain-reduction, and these are the knobs that set it.
     *
     * Without this the two writers FIGHT over the knob, visibly: measured on a
     * drag, the offline pass wrote 14.4 and the stale tracker pulled it back to
     * 11.5, then 15.1 and back to 11.5, on every step. Cleared, the offline
     * measurement supplies the value immediately and the tracker refines it
     * from the new settings instead of arguing for the old ones.
     */
    resetLiveMakeup()
    scheduleAutoMakeup()
  }

  const syncInput = (v) => syncCompressionParam('inputDrive', fetInput, v)
  const syncAttack = (v) => syncCompressionParam('attack', fetAttack, v)
  const syncRelease = (v) => syncCompressionParam('release', fetRelease, v)
  const syncRatio = (v) => syncCompressionParam('ratio', fetRatio, v)
  const syncDrive = (v) => syncCompressionParam('fetDrive', fetDrive, v)
  const syncScHpf = (v) => syncCompressionParam('scHpf', fetScHpf, v)
  const syncMix = (v) => syncCompressionParam('mix', fetMix, v)

  /**
   * Touch-to-take-over: dragging the knob while AUTO is on switches AUTO off
   * and accepts the value, rather than silently discarding it.
   *
   * Discarding it is what shipped, and it reads as the knob being broken. It
   * cost a real comparison: an "OptoSmooth at 75 with no makeup gain" export
   * turned out to carry 9.45 dB, because setting the knob to 0 never took and
   * nothing said so. AUTO still owns the value until the moment the user
   * disagrees with it, which is the point at which they have earned it.
   */
  function syncOutput(v) {
    if (fetAutoMakeup.value) disableAutoMakeup()
    fetOutput.value = v
    pushOutput()
  }

  /**
   * Leave AUTO, keeping the knob exactly where it stands, so going manual is a
   * seamless takeover rather than a jump back to 0 dB. Any in-flight
   * measurement is discarded by sequence number so it cannot land afterwards
   * and move a knob the user now owns.
   */
  function disableAutoMakeup() {
    fetAutoMakeup.value = false
    makeupThrottle?.cancel()
    makeupSeq++
    fetAutoMakeupBusy.value = false
    /**
     * ⚠ THE CEILING LEAVES WITH AUTO. `currentParams()` already drops it while
     * AUTO is off, but the LIVE node has been told about it and would keep
     * enforcing it against a gain the user now owns — a manual boost silently
     * held down by the last measurement's ceiling, with nothing on the panel
     * saying so.
     */
    fetCeilingDb.value = null
    pushParam('ceilingDb', null)
    fetCeilingKneeDb.value = null
    pushParam('ceilingKneeDb', null)
  }

  function toggleAutoMakeup() {
    if (fetAutoMakeup.value) {
      disableAutoMakeup()
    } else {
      fetAutoMakeup.value = true
      refreshAutoMakeup()
    }
  }

  /**
   * A new region is new material, so the live tracker's running extrema — which
   * describe audio the user has moved on from — are cleared with it.
   *
   * ⚠ IT NO LONGER MOVES THE KNOB, and it is still right to call. The tracker
   * stopped driving Output when the reference became the percentile (see the
   * meter loop), so this is now housekeeping on a reading the bench takes —
   * but a tracker carrying the previous selection's extrema is a wrong reading
   * whoever is looking at it.
   */
  function resetLiveMakeup() {
    getEffectChain(getAudioContext()).effects
      .find(e => e.id === fet1176Effect.id)?.nodes?.resetMakeupTracker?.()
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    /**
     * ⚠ RE-MEASURE BEFORE APPLYING, because the knob may be answering for a
     * DIFFERENT SPAN. With no selection, preview measures the whole file; apply
     * always has one, and the makeup and the ceiling are both properties of the
     * region they were measured over — committing the file's answer to a
     * selection would put the output above that selection's own peak. The
     * offline solve answers for the region being written, every time.
     */
    /**
     * ⚠ BEFORE THE MAKEUP SOLVE, AND BEFORE apply — not only on preview. Apply
     * is reachable without ever previewing, and an unmeasured offset there
     * would render the raw level-dependent compressor while preview rendered
     * the aligned one. The solve also has to see it: the offset decides how
     * much reduction the cell applies, so a makeup solved against a stale one
     * is solved for a compressor doing a different amount of work.
     */
    refreshInputAlign()
    if (fetAutoMakeup.value) await refreshAutoMakeup()

    const wasPreviewing = fetPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying FET Punch...')
    try {
      /**
       * ⚠ THE PEAK RESTORE HAPPENS INSIDE apply AND IS REPORTED, NOT SILENT.
       * The makeup is percentile-referenced, so the render's peak lands under
       * the region's own — by 1.9 dB at light settings and under 0.1 dB once
       * the ceiling is working. `applyFET1176Region` puts it back on the
       * ceiling and hands back what it added; saying so is the difference
       * between a number the user can check and gain that appeared from
       * nowhere. See `peakRestoreTrimDb`.
       */
      const { buffer, trimDb } = await applyFET1176Region(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer, 'FET Punch compression')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast(Math.abs(trimDb) >= 0.05
        ? `FET Punch applied — peak restored ${trimDb >= 0 ? '+' : ''}${trimDb.toFixed(2)} dB`
        : 'FET Punch compression applied')
    } catch (err) {
      console.error('FET Punch failed:', err)
      showToast('FET Punch compression failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (fetPreview.value) {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      chain.setEnabled(fet1176Effect.id, false)
      fetPreview.value = false
    }
  }

  // Open/close delegate to the window manager, which owns the open set and the
  // stacking order. Kept on the composable so call sites don't need to know the
  // registry id.
  function openModal() {
    openWindow(FET1176_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(FET1176_WINDOW_ID)
  }

  return {
    fetInputAlignDb,
    fetInputAuto,
    syncInputAlign,
    enableInputAuto,
    refreshInputAlign,
    fetInput,
    fetOutput,
    fetAttack,
    fetRelease,
    fetRatio,
    fetDrive,
    fetScHpf,
    fetMix,
    fetAutoMakeup,
    fetAutoMakeupBusy,
    fetPreview,
    fetReduction,
    fetInputLevels,
    fetOutputLevels,
    hasSelection,
    togglePreview,
    syncInput,
    syncOutput,
    syncAttack,
    syncRelease,
    syncRatio,
    syncDrive,
    syncScHpf,
    syncMix,
    toggleAutoMakeup,
    refreshAutoMakeup,
    resetLiveMakeup,
    apply,
    teardown,
    openModal,
    closeModal,
    refreshKernelTuning,
  }
}
