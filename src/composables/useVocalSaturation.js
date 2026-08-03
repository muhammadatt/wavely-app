import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyVocalSatRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { vocalSatEffect, VOCAL_SAT_DEFAULTS } from '../audio/effects/vocalSat.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const VOCAL_SAT_WINDOW_ID = 'vocal-saturation'

// Singleton reactive state shared between the sidebar trigger and the modal.
const vsDrive = ref(VOCAL_SAT_DEFAULTS.drive)
const vsWetDry = ref(VOCAL_SAT_DEFAULTS.wetDry)
const vsBias = ref(VOCAL_SAT_DEFAULTS.bias)
const vsSoftness = ref(VOCAL_SAT_DEFAULTS.softness)
const vsLowCrossover = ref(VOCAL_SAT_DEFAULTS.lowCrossover)
const vsMidCrossover = ref(VOCAL_SAT_DEFAULTS.midCrossover)
const vsLowDriveMult = ref(VOCAL_SAT_DEFAULTS.lowDriveMult)
const vsMidDriveMult = ref(VOCAL_SAT_DEFAULTS.midDriveMult)
const vsHighDriveMult = ref(VOCAL_SAT_DEFAULTS.highDriveMult)

const vsPreview = ref(false)
const vsInputDb = ref(-Infinity)
const vsOutputDb = ref(-Infinity)
let meterId = null

function currentParams() {
  return {
    drive: vsDrive.value,
    wetDry: vsWetDry.value,
    bias: vsBias.value,
    softness: vsSoftness.value,
    lowCrossover: vsLowCrossover.value,
    midCrossover: vsMidCrossover.value,
    lowDriveMult: vsLowDriveMult.value,
    midDriveMult: vsMidDriveMult.value,
    highDriveMult: vsHighDriveMult.value,
  }
}

export function useVocalSaturation() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === vocalSatEffect.id)) {
      chain.addEffect(vocalSatEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === vocalSatEffect.id)?.nodes
      if (nodes) {
        vsInputDb.value = nodes.getInputLevelDb()
        vsOutputDb.value = nodes.getOutputLevelDb()
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
    vsInputDb.value = -Infinity
    vsOutputDb.value = -Infinity
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(vocalSatEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    vsPreview.value = !vsPreview.value
    chain.setEnabled(vocalSatEffect.id, vsPreview.value)

    if (vsPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!vsPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(vocalSatEffect.id, name, value)
  }

  function syncParam(name, refVar, value) {
    refVar.value = value
    pushParam(name, value)
  }

  const syncDrive = v => syncParam('drive', vsDrive, v)
  const syncWetDry = v => syncParam('wetDry', vsWetDry, v)
  const syncBias = v => syncParam('bias', vsBias, v)
  const syncSoftness = v => syncParam('softness', vsSoftness, v)
  const syncLowCrossover = v => syncParam('lowCrossover', vsLowCrossover, v)
  const syncMidCrossover = v => syncParam('midCrossover', vsMidCrossover, v)
  const syncLowDriveMult = v => syncParam('lowDriveMult', vsLowDriveMult, v)
  const syncMidDriveMult = v => syncParam('midDriveMult', vsMidDriveMult, v)
  const syncHighDriveMult = v => syncParam('highDriveMult', vsHighDriveMult, v)

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = vsPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Saturating...')
    try {
      const buffer = await applyVocalSatRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Vocal saturation applied')
    } catch (err) {
      console.error('Vocal saturation failed:', err)
      showToast('Vocal saturation failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (vsPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(vocalSatEffect.id, false)
      vsPreview.value = false
    }
  }

  function openModal() {
    openWindow(VOCAL_SAT_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(VOCAL_SAT_WINDOW_ID)
  }

  return {
    vsDrive,
    vsWetDry,
    vsBias,
    vsSoftness,
    vsLowCrossover,
    vsMidCrossover,
    vsLowDriveMult,
    vsMidDriveMult,
    vsHighDriveMult,
    vsPreview,
    vsInputDb,
    vsOutputDb,
    hasSelection,
    togglePreview,
    syncDrive,
    syncWetDry,
    syncBias,
    syncSoftness,
    syncLowCrossover,
    syncMidCrossover,
    syncLowDriveMult,
    syncMidDriveMult,
    syncHighDriveMult,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
