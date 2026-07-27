import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyLA2ARegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { la2aEffect, LA2A_DEFAULTS } from '../audio/effects/la2aCompressor.js'

// Singleton reactive state shared between the sidebar trigger and the LA-2A modal
const la2aMode = ref(LA2A_DEFAULTS.mode)
const la2aPeakReduction = ref(LA2A_DEFAULTS.peakReduction)
const la2aGain = ref(LA2A_DEFAULTS.gain)
const la2aTubeDrive = ref(LA2A_DEFAULTS.tubeDrive)
const la2aEmphasis = ref(LA2A_DEFAULTS.emphasis)
const la2aPreview = ref(false)
const la2aReduction = ref(0)
const la2aInputDb = ref(-Infinity)
const la2aOutputDb = ref(-Infinity)
let meterId = null

function currentParams() {
  return {
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gain: la2aGain.value,
    tubeDrive: la2aTubeDrive.value,
    emphasis: la2aEmphasis.value,
  }
}

export function useLA2A() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast } = useEditorState()

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
        la2aInputDb.value = nodes.getInputLevelDb()
        la2aOutputDb.value = nodes.getOutputLevelDb()
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
    } else {
      stopMeters()
    }
  }

  function syncParam(name, refVar, value) {
    refVar.value = value
    if (!la2aPreview.value) return
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    chain.updateParam(la2aEffect.id, name, value)
  }

  const syncMode = (v) => syncParam('mode', la2aMode, v)
  const syncPeakReduction = (v) => syncParam('peakReduction', la2aPeakReduction, v)
  const syncGain = (v) => syncParam('gain', la2aGain, v)
  const syncTubeDrive = (v) => syncParam('tubeDrive', la2aTubeDrive, v)
  const syncEmphasis = (v) => syncParam('emphasis', la2aEmphasis, v)

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = la2aPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying LA-2A...')
    try {
      const ctx = getAudioContext()
      const buffer = await applyLA2ARegion(
        state.segments, start, end,
        currentParams(),
        ctx, state.currentFile.sampleRate, state.currentFile.channels
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

  function openModal() {
    state.la2aModalOpen = true
  }

  function closeModal() {
    state.la2aModalOpen = false
  }

  return {
    la2aMode,
    la2aPeakReduction,
    la2aGain,
    la2aTubeDrive,
    la2aEmphasis,
    la2aPreview,
    la2aReduction,
    la2aInputDb,
    la2aOutputDb,
    hasSelection,
    togglePreview,
    syncMode,
    syncPeakReduction,
    syncGain,
    syncTubeDrive,
    syncEmphasis,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
