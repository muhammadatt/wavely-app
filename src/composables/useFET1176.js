import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyFET1176Region, computeFET1176AutoMakeup, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { fet1176Effect, FET1176_DEFAULTS } from '../audio/effects/fet1176Compressor.js'

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
const fetInputDb = ref(-Infinity)
const fetOutputDb = ref(-Infinity)
let meterId = null

// Debounce + supersede state for the auto-makeup measurement, shared across
// every useFET1176() caller so knob drags coalesce into one measurement.
const AUTO_MAKEUP_DEBOUNCE_MS = 45
let makeupTimer = null
let makeupSeq = 0
let makeupBurstActive = false
let makeupBurstDirty = false

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
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast } = useEditorState()

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
      if (nodes) {
        fetReduction.value = nodes.getReduction()
        fetInputDb.value = nodes.getInputLevelDb()
        fetOutputDb.value = nodes.getOutputLevelDb()
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
    fetInputDb.value = -Infinity
    fetOutputDb.value = -Infinity
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
    if (!fetAutoMakeup.value || !state.selection || !state.currentFile) return

    const { start, end } = state.selection
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

  function scheduleAutoMakeup() {
    if (!fetAutoMakeup.value) return

    // Leading edge: first move in a burst measures immediately so the Output
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

  const syncInput = (v) => syncCompressionParam('inputDrive', fetInput, v)
  const syncAttack = (v) => syncCompressionParam('attack', fetAttack, v)
  const syncRelease = (v) => syncCompressionParam('release', fetRelease, v)
  const syncRatio = (v) => syncCompressionParam('ratio', fetRatio, v)
  const syncDrive = (v) => syncCompressionParam('fetDrive', fetDrive, v)
  const syncScHpf = (v) => syncCompressionParam('scHpf', fetScHpf, v)
  const syncMix = (v) => syncCompressionParam('mix', fetMix, v)

  function syncOutput(v) {
    if (fetAutoMakeup.value) return // the plugin owns the output in auto mode
    fetOutput.value = v
    pushOutput()
  }

  function toggleAutoMakeup() {
    fetAutoMakeup.value = !fetAutoMakeup.value
    if (fetAutoMakeup.value) {
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
      fetAutoMakeupBusy.value = false
    }
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = fetPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying FET Punch...')
    try {
      const buffer = await applyFET1176Region(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer)
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

  function openModal() {
    state.fet1176ModalOpen = true
  }

  function closeModal() {
    state.fet1176ModalOpen = false
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
    fetInputDb,
    fetOutputDb,
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
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
