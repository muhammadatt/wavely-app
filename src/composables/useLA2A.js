import { ref } from 'vue'
import { createMeasureThrottle } from './measureThrottle.js'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyLA2ARegion, computeLA2AAutoMakeup, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { la2aEffect, LA2A_DEFAULTS } from '../audio/effects/la2aCompressor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const LA2A_WINDOW_ID = 'opto-smooth'

// Singleton reactive state shared between the sidebar trigger and the LA-2A modal
const la2aMode = ref(LA2A_DEFAULTS.mode)
const la2aPeakReduction = ref(LA2A_DEFAULTS.peakReduction)
const la2aGain = ref(LA2A_DEFAULTS.gain)
const la2aR37 = ref(LA2A_DEFAULTS.r37)
const la2aLookahead = ref(LA2A_DEFAULTS.lookahead)
const la2aMakeupReference = ref(LA2A_DEFAULTS.makeupReference)
/**
 * The ceiling the last measurement produced, dBFS, or null.
 *
 * ⚠ MEASURED STATE, NOT A KNOB, and it is deliberately not in `LA2A_DEFAULTS`.
 * It is the region's own peak, so it belongs to the audio rather than to the
 * patch — a preset carrying one would apply another file's peak to this one.
 * It rides in `currentParams()` so preview and apply cannot disagree about it,
 * and the preset normaliser's key whitelist keeps it out of stored presets.
 */
const la2aCeilingDb = ref(null)
// Auto makeup: on by default so spot compression is level-neutral — an
// unmatched makeup on a selection leaves an audible step at the selection
// boundary and perturbs the levels the mastering chain later measures.
// While on, the plugin owns the Gain knob: measurements are written into
// la2aGain itself, so the knob always shows the gain actually in effect.
const la2aAutoMakeup = ref(true)
const la2aAutoMakeupBusy = ref(false)

// Gain knob travel — measured makeup is clamped to it so the knob position
// can never disagree with the value in effect.
const GAIN_MIN_DB = -12
const GAIN_MAX_DB = 24
const la2aPreview = ref(false)
const la2aReduction = ref(0)
const la2aInputLevels = ref([])
const la2aOutputLevels = ref([])
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
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gain: la2aGain.value,
    r37: la2aR37.value,
    lookahead: la2aLookahead.value,
    makeupReference: la2aMakeupReference.value,
    /**
     * ⚠ ONLY WHILE AUTO OWNS THE KNOB. The ceiling is the other half of the
     * percentile solve; with AUTO off there is no solve, the gain is the
     * user's, and enforcing a ceiling they never asked for would attenuate
     * their own setting. Dropping it here is what makes "turn AUTO off" a
     * complete escape from the pairing rather than half of one.
     */
    ceilingDb: la2aAutoMakeup.value ? la2aCeilingDb.value : null,
  }
}

/** Params for the measurement pass — makeup is what we're solving for. */
function measurementParams() {
  return {
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gainDb: 0,
    r37: la2aR37.value,
    /**
     * ⚠ LOOKAHEAD BELONGS IN THE MEASUREMENT, and it is the whole point of the
     * control. It is what moves the peak the makeup is referenced to — leaving
     * it out would solve the makeup for a compressor the user is not listening
     * to, and hand back exactly the number the control exists to change.
     */
    lookaheadMs: la2aLookahead.value,
  }
}

export function useLA2A() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast, totalDuration} = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === la2aEffect.id)) {
      chain.addEffect(la2aEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === la2aEffect.id)?.nodes
      /**
       * LIVE AUTO MAKEUP — read off the worklet on the meter's own cadence.
       *
       * The kernel maintains it from running extrema at O(1) per sample, so it
       * needs no worker, no region render and no selection, and it lands within
       * one meter interval (~21 ms) rather than a measurement (~170 ms).
       *
       * ⚠ THIS IS THE PREVIEW VALUE ONLY. It knows only what has PLAYED, so it
       * is history-dependent — measured on real narration it can sit ~0.9 dB
       * high before the loudest moment arrives. `apply()` re-measures offline
       * for exactly that reason; see the note there.
       *
       * ⚠ ONLY WHILE AUTO OWNS THE KNOB. Once the user has taken over, writing
       * a tracked value into it would be the panel overruling them.
       */
      /**
       * ⚠ AND ONLY UNDER THE PEAK REFERENCE, WHICH IS THE ONE IT CAN ANSWER
       * FOR. `liveAutoMakeupDb` is peak-referenced by construction — it inverts
       * the tube shaper at the TARGET PEAK using running extrema, which is what
       * makes it O(1) per sample and what makes it agree with the offline peak
       * solve to hundredths. It has no way to express a percentile: a running
       * quantile is not two extrema.
       *
       * Left ungated it does not merely disagree, it OVERWRITES. This runs on
       * every meter tick (~21 ms), so under BODY the offline solve's value
       * survived for one frame and was then replaced by the peak-referenced one
       * for the rest of playback — measured on narration at Peak Reduction 60,
       * the tracker says 4.20 dB against the percentile solve's 8.66, so
       * preview played 4.46 dB QUIETER than the same settings applied. Reported
       * exactly that way, as makeup gain missing from playback.
       *
       * So under BODY the knob is owned by the offline solve alone. It still
       * tracks — `scheduleAutoMakeup` re-measures on every compression change —
       * just at measurement cadence rather than meter cadence, which is where
       * this knob sat before the tracker existed. Better a knob that updates in
       * ~170 ms and is right than one that updates in ~21 ms and is 4 dB wrong.
       */
      if (la2aAutoMakeup.value && la2aMakeupReference.value === 'peak') {
        const live = nodes.getLiveMakeupDb?.()
        if (Number.isFinite(live)) {
          const next = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, live))
          // A threshold, not equality: the knob prints one decimal, and
          // repainting it on sub-hundredth wobble is churn nobody can see.
          if (Math.abs(next - la2aGain.value) > 0.02) {
            la2aGain.value = next
            pushGain()
          }
        }
      }
      if (nodes) {
        la2aReduction.value = nodes.getReduction()
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        la2aInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        la2aOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    la2aReduction.value = 0
    la2aInputLevels.value = []
    la2aOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(la2aEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    la2aPreview.value = !la2aPreview.value
    chain.setEnabled(la2aEffect.id, la2aPreview.value)

    if (la2aPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
      refreshAutoMakeup()
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!la2aPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(la2aEffect.id, name, value)
  }

  function pushGain() {
    pushParam('gain', la2aGain.value)
  }

  /**
   * Re-measure the auto-makeup for the current selection and settings and
   * drive the Gain knob to it. Superseded calls are discarded by sequence
   * number so a fast knob drag can't have an older measurement land after
   * a newer one.
   */
  async function refreshAutoMakeup() {
    if (!la2aAutoMakeup.value || !state.currentFile) return

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
    la2aAutoMakeupBusy.value = true
    try {
      const { makeupDb, ceilingDb } = await computeLA2AAutoMakeup(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
        la2aMakeupReference.value,
      )
      if (seq !== makeupSeq) return // a newer measurement is already in flight
      /**
       * ⚠ THE CEILING GOES FIRST, AND THE ORDER IS THE GUARANTEE. Both reach
       * the live node as separate param messages, so between them the node
       * holds one old value and one new one. Gain-then-ceiling would leave the
       * raised makeup running for that gap with the old ceiling — or none —
       * which is exactly the overshoot the pairing exists to prevent, audible
       * as a blip on every re-measure during a drag.
       */
      la2aCeilingDb.value = ceilingDb
      pushParam('ceilingDb', ceilingDb)
      la2aGain.value = Math.max(GAIN_MIN_DB, Math.min(GAIN_MAX_DB, makeupDb))
      pushGain()
    } catch (err) {
      console.error('LA-2A auto makeup measurement failed:', err)
    } finally {
      if (seq === makeupSeq) la2aAutoMakeupBusy.value = false
    }
  }

  /**
   * Ask for a re-measure. Coalesced by createMeasureThrottle — see there for
   * why this is a throttle and not the debounce it replaced.
   */
  if (!makeupThrottle) makeupThrottle = createMeasureThrottle(refreshAutoMakeup)
  function scheduleAutoMakeup() {
    if (!la2aAutoMakeup.value) return
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

  const syncMode = (v) => syncCompressionParam('mode', la2aMode, v)
  const syncPeakReduction = (v) => syncCompressionParam('peakReduction', la2aPeakReduction, v)
  const syncR37 = (v) => syncCompressionParam('r37', la2aR37, v)
  // A compression param, not a trim: it changes which peak survives, so the
  // makeup has to be re-solved and the live tracker's extrema are stale.
  const syncLookahead = (v) => syncCompressionParam('lookahead', la2aLookahead, v)

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
  function syncGain(v) {
    if (la2aAutoMakeup.value) disableAutoMakeup()
    la2aGain.value = v
    pushGain()
  }

  /**
   * The bench tuning changed. It is not a patch param — it lives in module
   * state and is folded in by `toKernelParams` — so there is nothing to set;
   * the live node just has to re-read it.
   *
   * Treated as a compression change for makeup purposes, because it is one:
   * the valve constants move where the peak lands, and the cell constants move
   * how much reduction is applied. The tracker's extrema describe the old
   * settings exactly as they do after a Peak Reduction move.
   */
  /**
   * Switch which statistic the solve references.
   *
   * A measurement change, not a sound change, so nothing is pushed to the node
   * directly — the re-measure writes both the gain and the ceiling, in that
   * order, through `refreshAutoMakeup`. Immediate rather than throttled: this
   * is a click, not a drag, and it moves the makeup by dBs.
   */
  function syncMakeupReference(v) {
    if (v === la2aMakeupReference.value) return
    la2aMakeupReference.value = v
    if (v !== 'percentile') {
      la2aCeilingDb.value = null
      pushParam('ceilingDb', null)
    }
    resetLiveMakeup()
    refreshAutoMakeup()
  }

  function refreshKernelTuning() {
    getEffectChain(getAudioContext()).effects
      .find(e => e.id === la2aEffect.id)?.nodes?.refreshKernelParams?.()
    resetLiveMakeup()
    scheduleAutoMakeup()
  }

  /**
   * Leave AUTO, keeping the knob exactly where it stands, so going manual is a
   * seamless takeover rather than a jump back to 0 dB. Any in-flight
   * measurement is discarded by sequence number so it cannot land afterwards
   * and move a knob the user now owns.
   */
  function disableAutoMakeup() {
    la2aAutoMakeup.value = false
    makeupThrottle?.cancel()
    makeupSeq++
    la2aAutoMakeupBusy.value = false
    /**
     * ⚠ THE CEILING LEAVES WITH AUTO. `currentParams()` already drops it while
     * AUTO is off, but the LIVE node has been told about it and would keep
     * enforcing it against a gain the user now owns — a manual boost silently
     * held down by the last measurement's ceiling, with nothing on the panel
     * saying so.
     */
    la2aCeilingDb.value = null
    pushParam('ceilingDb', null)
  }

  function toggleAutoMakeup() {
    if (la2aAutoMakeup.value) {
      disableAutoMakeup()
    } else {
      la2aAutoMakeup.value = true
      refreshAutoMakeup()
    }
  }

  /**
   * A new region is new material, so the live tracker's running extrema — which
   * describe audio the user has moved on from — are cleared with it. Without
   * this the makeup keeps answering for the previous selection and only drifts
   * toward the new one as it is diluted.
   */
  function resetLiveMakeup() {
    getEffectChain(getAudioContext()).effects
      .find(e => e.id === la2aEffect.id)?.nodes?.resetMakeupTracker?.()
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    /**
     * ⚠ RE-MEASURE BEFORE APPLYING, because the knob may be holding a LIVE
     * value and a live value is history-dependent — a function of what has
     * played. Committing it would mean the same selection and settings render
     * differently depending on where and how long you pressed play, and a
     * makeup measured before the loudest moment arrived would put the output
     * above the source's peak. The offline solve answers for the whole region
     * every time.
     */
    if (la2aAutoMakeup.value) await refreshAutoMakeup()

    const wasPreviewing = la2aPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying LA-2A...')
    try {
      const buffer = await applyLA2ARegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer, 'LA-2A compression')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('LA-2A compression applied')
    } catch (err) {
      console.error('LA-2A failed:', err)
      showToast('LA-2A compression failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (la2aPreview.value) {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      chain.setEnabled(la2aEffect.id, false)
      la2aPreview.value = false
    }
  }

  // Open/close delegate to the window manager, which owns the open set and the
  // stacking order. Kept on the composable so call sites don't need to know the
  // registry id.
  function openModal() {
    openWindow(LA2A_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(LA2A_WINDOW_ID)
  }

  return {
    la2aMode,
    la2aPeakReduction,
    la2aGain,
    la2aR37,
    la2aLookahead,
    la2aMakeupReference,
    la2aCeilingDb,
    la2aAutoMakeup,
    la2aAutoMakeupBusy,
    la2aPreview,
    la2aReduction,
    la2aInputLevels,
    la2aOutputLevels,
    hasSelection,
    togglePreview,
    syncMode,
    syncPeakReduction,
    syncGain,
    syncR37,
    syncLookahead,
    syncMakeupReference,
    toggleAutoMakeup,
    refreshAutoMakeup,
    resetLiveMakeup,
    refreshKernelTuning,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
