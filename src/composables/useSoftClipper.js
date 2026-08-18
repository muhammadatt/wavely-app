import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applySoftClipperRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { softClipperEffect, SOFT_CLIPPER_DEFAULTS } from '../audio/effects/softClipper.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SOFT_CLIPPER_WINDOW_ID = 'soft-clipper'

// Singleton reactive state shared between the sidebar trigger and the modal —
// same pattern as useFET1176.js / useLA2A.js.
const headroomDb = ref(SOFT_CLIPPER_DEFAULTS.headroomDb)
const emphasisDb = ref(SOFT_CLIPPER_DEFAULTS.emphasisDb)
const outputTrimDb = ref(SOFT_CLIPPER_DEFAULTS.outputTrimDb)
const thresholdMode = ref(SOFT_CLIPPER_DEFAULTS.thresholdMode)
const fixedThresholdDb = ref(SOFT_CLIPPER_DEFAULTS.fixedThresholdDb)

const clipperPreview = ref(false)
const clipperReduction = ref(0)
const clipperInputLevels = ref([])
const clipperOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    headroomDb: headroomDb.value,
    emphasisDb: emphasisDb.value,
    outputTrimDb: outputTrimDb.value,
    thresholdMode: thresholdMode.value,
    fixedThresholdDb: fixedThresholdDb.value,
  }
}

export function useSoftClipper() {
  const { state, getAudioContext, hasSelection, replaceRegion, setPeakCache, startProcessing, endProcessing, showToast } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === softClipperEffect.id)) {
      chain.addEffect(softClipperEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === softClipperEffect.id)?.nodes
      if (nodes) {
        clipperReduction.value = nodes.getReduction()
        const chCount = state.currentFile?.channels ?? 1
        clipperInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        clipperOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    clipperReduction.value = 0
    clipperInputLevels.value = []
    clipperOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(softClipperEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    clipperPreview.value = !clipperPreview.value
    chain.setEnabled(softClipperEffect.id, clipperPreview.value)

    if (clipperPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!clipperPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(softClipperEffect.id, name, value)
  }

  const syncHeadroom = (v) => { headroomDb.value = v; pushParam('headroomDb', v) }
  const syncEmphasis = (v) => { emphasisDb.value = v; pushParam('emphasisDb', v) }
  const syncOutputTrim = (v) => { outputTrimDb.value = v; pushParam('outputTrimDb', v) }
  const syncFixedThreshold = (v) => { fixedThresholdDb.value = v; pushParam('fixedThresholdDb', v) }

  function setThresholdMode(mode) {
    thresholdMode.value = mode
    pushParam('thresholdMode', mode)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = clipperPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Soft Clipper...')
    try {
      const buffer = await applySoftClipperRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Soft Clipper applied')
    } catch (err) {
      console.error('Soft Clipper failed:', err)
      showToast('Soft Clipper failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (clipperPreview.value) {
      const ctx = getAudioContext()
      const chain = getEffectChain(ctx)
      chain.setEnabled(softClipperEffect.id, false)
      clipperPreview.value = false
    }
  }

  function openModal() {
    openWindow(SOFT_CLIPPER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(SOFT_CLIPPER_WINDOW_ID)
  }

  return {
    headroomDb,
    emphasisDb,
    outputTrimDb,
    thresholdMode,
    fixedThresholdDb,
    clipperPreview,
    clipperReduction,
    clipperInputLevels,
    clipperOutputLevels,
    hasSelection,
    togglePreview,
    syncHeadroom,
    syncEmphasis,
    syncOutputTrim,
    syncFixedThreshold,
    setThresholdMode,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
