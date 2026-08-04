import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyResonanceRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { resonanceEffect, RESONANCE_DEFAULTS } from '../audio/effects/resonance.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const RESONANCE_WINDOW_ID = 'resonance-suppressor'

// Singleton reactive state shared between the sidebar trigger and the modal.
const resDepth = ref(RESONANCE_DEFAULTS.depth)
const resSharpness = ref(RESONANCE_DEFAULTS.sharpness)
const resSelectivity = ref(RESONANCE_DEFAULTS.selectivity)
const resAttack = ref(RESONANCE_DEFAULTS.attack)
const resRelease = ref(RESONANCE_DEFAULTS.release)
const resMaxReduction = ref(RESONANCE_DEFAULTS.maxReduction)
const resFreqFloor = ref(RESONANCE_DEFAULTS.freqFloor)
const resFreqCeil = ref(RESONANCE_DEFAULTS.freqCeil)
const resMode = ref(RESONANCE_DEFAULTS.mode)
const resPreserveHarmonics = ref(RESONANCE_DEFAULTS.preserveHarmonics)
const resPitchRange = ref(RESONANCE_DEFAULTS.pitchRange)

const resPreview = ref(false)
const resReduction = ref(0)
const resInputDb = ref(-Infinity)
const resOutputDb = ref(-Infinity)
let meterId = null

function currentParams() {
  return {
    depth: resDepth.value,
    sharpness: resSharpness.value,
    selectivity: resSelectivity.value,
    attack: resAttack.value,
    release: resRelease.value,
    maxReduction: resMaxReduction.value,
    freqFloor: resFreqFloor.value,
    freqCeil: resFreqCeil.value,
    mode: resMode.value,
    preserveHarmonics: resPreserveHarmonics.value,
    pitchRange: resPitchRange.value,
  }
}

export function useResonance() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === resonanceEffect.id)) {
      chain.addEffect(resonanceEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === resonanceEffect.id)?.nodes
      if (nodes) {
        resReduction.value = nodes.getReduction()
        resInputDb.value = nodes.getInputLevelDb()
        resOutputDb.value = nodes.getOutputLevelDb()
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
    resReduction.value = 0
    resInputDb.value = -Infinity
    resOutputDb.value = -Infinity
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(resonanceEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    resPreview.value = !resPreview.value
    chain.setEnabled(resonanceEffect.id, resPreview.value)

    if (resPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!resPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(resonanceEffect.id, name, value)
  }

  function syncParam(name, refVar, value) {
    refVar.value = value
    pushParam(name, value)
  }

  const syncDepth = v => syncParam('depth', resDepth, v)
  const syncSharpness = v => syncParam('sharpness', resSharpness, v)
  const syncSelectivity = v => syncParam('selectivity', resSelectivity, v)
  const syncAttack = v => syncParam('attack', resAttack, v)
  const syncRelease = v => syncParam('release', resRelease, v)
  const syncMaxReduction = v => syncParam('maxReduction', resMaxReduction, v)
  const syncFreqFloor = v => syncParam('freqFloor', resFreqFloor, v)
  const syncFreqCeil = v => syncParam('freqCeil', resFreqCeil, v)
  const syncMode = v => syncParam('mode', resMode, v)
  const syncPitchRange = v => syncParam('pitchRange', resPitchRange, v)

  function togglePreserveHarmonics() {
    syncParam('preserveHarmonics', resPreserveHarmonics, !resPreserveHarmonics.value)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = resPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Suppressing resonances...')
    try {
      const buffer = await applyResonanceRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Resonance suppression applied')
    } catch (err) {
      console.error('Resonance suppression failed:', err)
      showToast('Resonance suppression failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (resPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(resonanceEffect.id, false)
      resPreview.value = false
    }
  }

  function openModal() {
    openWindow(RESONANCE_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(RESONANCE_WINDOW_ID)
  }

  return {
    resDepth,
    resSharpness,
    resSelectivity,
    resAttack,
    resRelease,
    resMaxReduction,
    resFreqFloor,
    resFreqCeil,
    resMode,
    resPreserveHarmonics,
    resPitchRange,
    resPreview,
    resReduction,
    resInputDb,
    resOutputDb,
    hasSelection,
    togglePreview,
    syncDepth,
    syncSharpness,
    syncSelectivity,
    syncAttack,
    syncRelease,
    syncMaxReduction,
    syncFreqFloor,
    syncFreqCeil,
    syncMode,
    syncPitchRange,
    togglePreserveHarmonics,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
