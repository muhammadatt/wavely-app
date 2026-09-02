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
const la2aTubeDrive = ref(LA2A_DEFAULTS.tubeDrive)
const la2aR37 = ref(LA2A_DEFAULTS.r37)
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
    tubeDrive: la2aTubeDrive.value,
    r37: la2aR37.value,
  }
}

/** Params for the measurement pass — makeup is what we're solving for. */
function measurementParams() {
  return {
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gainDb: 0,
    tubeDrive: la2aTubeDrive.value,
    r37: la2aR37.value,
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
      const makeupDb = await computeLA2AAutoMakeup(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      if (seq !== makeupSeq) return // a newer measurement is already in flight
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
    scheduleAutoMakeup()
  }

  const syncMode = (v) => syncCompressionParam('mode', la2aMode, v)
  const syncPeakReduction = (v) => syncCompressionParam('peakReduction', la2aPeakReduction, v)
  const syncTubeDrive = (v) => syncCompressionParam('tubeDrive', la2aTubeDrive, v)
  const syncR37 = (v) => syncCompressionParam('r37', la2aR37, v)

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
  }

  function toggleAutoMakeup() {
    if (la2aAutoMakeup.value) {
      disableAutoMakeup()
    } else {
      la2aAutoMakeup.value = true
      refreshAutoMakeup()
    }
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

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
    la2aTubeDrive,
    la2aR37,
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
    syncTubeDrive,
    syncR37,
    toggleAutoMakeup,
    refreshAutoMakeup,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
