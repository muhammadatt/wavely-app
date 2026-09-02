import { ref } from 'vue'
import { createMeasureThrottle } from './measureThrottle.js'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyFET1176Region, computeFET1176AutoMakeup, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { fet1176Effect, FET1176_DEFAULTS } from '../audio/effects/fet1176Compressor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

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
  }
}

/** Params for the measurement pass — makeup is what we're solving for. */
function measurementParams() {
  return {
    inputDrive: fetInput.value,
    outputGainDb: 0,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpfHz: fetScHpf.value,
    mix: fetMix.value,
  }
}

export function useFET1176() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast, totalDuration} = useEditorState()
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
      if (fetAutoMakeup.value) {
        const live = nodes.getLiveMakeupDb?.()
        if (Number.isFinite(live)) {
          const next = Math.max(OUTPUT_MIN_DB, Math.min(OUTPUT_MAX_DB, live))
          // A threshold, not equality: the knob prints one decimal, and
          // repainting it on sub-hundredth wobble is churn nobody can see.
          if (Math.abs(next - fetOutput.value) > 0.02) {
            fetOutput.value = next
            pushOutput()
          }
        }
      }
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
      const makeupDb = await computeFET1176AutoMakeup(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      if (seq !== makeupSeq) return // a newer measurement is already in flight
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
   * describe audio the user has moved on from — are cleared with it. Without
   * this the makeup keeps answering for the previous selection and only drifts
   * toward the new one as it is diluted.
   */
  function resetLiveMakeup() {
    getEffectChain(getAudioContext()).effects
      .find(e => e.id === fet1176Effect.id)?.nodes?.resetMakeupTracker?.()
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
    if (fetAutoMakeup.value) await refreshAutoMakeup()

    const wasPreviewing = fetPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying FET Punch...')
    try {
      const buffer = await applyFET1176Region(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer, 'FET Punch compression')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('FET Punch compression applied')
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
  }
}
