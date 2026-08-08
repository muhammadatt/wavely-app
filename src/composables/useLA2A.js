import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyLA2ARegion, computeLA2AAutoMakeup, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { la2aEffect, LA2A_DEFAULTS } from '../audio/effects/la2aCompressor.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const LA2A_WINDOW_ID = 'opto-smooth'

// Singleton reactive state shared between the sidebar trigger and the LA-2A modal
const la2aMode = ref(LA2A_DEFAULTS.mode)
const la2aPeakReduction = ref(LA2A_DEFAULTS.peakReduction)
const la2aGain = ref(LA2A_DEFAULTS.gain)
const la2aTubeDrive = ref(LA2A_DEFAULTS.tubeDrive)
const la2aEmphasis = ref(LA2A_DEFAULTS.emphasis)
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
const la2aInputDb = ref(-Infinity)
const la2aOutputDb = ref(-Infinity)
const la2aInputPeakDb = ref(-Infinity)
const la2aOutputPeakDb = ref(-Infinity)
let meterId = null

// Debounce + supersede state for the auto-makeup measurement, shared across
// every useLA2A() caller so knob drags coalesce into one measurement.
// Keep this short so the Gain knob tracks Peak Reduction closely in AUTO
// mode, while still avoiding a worker spawn per pointer tick.
const AUTO_MAKEUP_DEBOUNCE_MS = 45
let makeupTimer = null
let makeupSeq = 0
let makeupBurstActive = false
let makeupBurstDirty = false

function currentParams() {
  return {
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gain: la2aGain.value,
    tubeDrive: la2aTubeDrive.value,
    emphasis: la2aEmphasis.value,
  }
}

/** Params for the measurement pass — makeup is what we're solving for. */
function measurementParams() {
  return {
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gainDb: 0,
    tubeDrive: la2aTubeDrive.value,
    emphasis: la2aEmphasis.value,
  }
}

export function useLA2A() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast } = useEditorState()
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
        const inLevels = nodes.getInputLevels()
        la2aInputDb.value = inLevels.rmsDb
        la2aInputPeakDb.value = inLevels.peakDb
        const outLevels = nodes.getOutputLevels()
        la2aOutputDb.value = outLevels.rmsDb
        la2aOutputPeakDb.value = outLevels.peakDb
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
    la2aInputDb.value = -Infinity
    la2aOutputDb.value = -Infinity
    la2aInputPeakDb.value = -Infinity
    la2aOutputPeakDb.value = -Infinity
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
    if (!la2aAutoMakeup.value || !state.selection || !state.currentFile) return

    const { start, end } = state.selection
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

  function scheduleAutoMakeup() {
    if (!la2aAutoMakeup.value) return

    // Leading edge: first move in a burst measures immediately so the Gain
    // knob responds right away.
    if (!makeupBurstActive) {
      makeupBurstActive = true
      makeupBurstDirty = false
      refreshAutoMakeup()
    } else {
      // Additional moves during the debounce window request one trailing pass
      // with the final knob value.
      makeupBurstDirty = true
    }

    if (makeupTimer !== null) clearTimeout(makeupTimer)
    makeupTimer = setTimeout(() => {
      makeupTimer = null
      const shouldRunTrailing = makeupBurstDirty
      makeupBurstActive = false
      makeupBurstDirty = false
      if (shouldRunTrailing) refreshAutoMakeup()
    }, AUTO_MAKEUP_DEBOUNCE_MS)
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
  const syncEmphasis = (v) => syncCompressionParam('emphasis', la2aEmphasis, v)

  function syncGain(v) {
    if (la2aAutoMakeup.value) return // the plugin owns the gain in auto mode
    la2aGain.value = v
    pushGain()
  }

  function toggleAutoMakeup() {
    la2aAutoMakeup.value = !la2aAutoMakeup.value
    if (la2aAutoMakeup.value) {
      refreshAutoMakeup()
    } else {
      // Hand the knob back where it stands, so switching to manual is a
      // seamless takeover rather than a jump back to 0 dB.
      if (makeupTimer !== null) {
        clearTimeout(makeupTimer)
        makeupTimer = null
      }
      makeupBurstActive = false
      makeupBurstDirty = false
      makeupSeq++ // discard any in-flight measurement
      la2aAutoMakeupBusy.value = false
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
      const bufferId = replaceRegion(start, end, buffer)
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
    la2aEmphasis,
    la2aAutoMakeup,
    la2aAutoMakeupBusy,
    la2aPreview,
    la2aReduction,
    la2aInputDb,
    la2aOutputDb,
    la2aInputPeakDb,
    la2aOutputPeakDb,
    hasSelection,
    togglePreview,
    syncMode,
    syncPeakReduction,
    syncGain,
    syncTubeDrive,
    syncEmphasis,
    toggleAutoMakeup,
    refreshAutoMakeup,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
