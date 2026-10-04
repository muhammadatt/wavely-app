import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applySaturationBenchRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import {
  saturationBenchEffect, SAT_BENCH_LAYER_PRESETS,
} from '../audio/effects/saturationBench.js'
import {
  measureBandSpectrum, bandRefPeakDb, voicingOffsetDb,
} from '../audio/saturationBenchAnalysis.js'
import { SAT_DEFAULT_REF_PEAK_DB } from '../audio/saturationBenchProcessor.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const SATURATION_BENCH_WINDOW_ID = 'saturation-bench'

// Singleton reactive state shared between the sidebar trigger and the modal.
const sbLayers = ref(SAT_BENCH_LAYER_PRESETS.map(l => ({ ...l })))
const sbPreview = ref(false)
const sbDelta = ref(false)
const sbInputLevels = ref([])
const sbOutputLevels = ref([])
// The file's gated long-term spectrum: what every layer's drive is calibrated
// against. A property of the audio, measured, never a user setting.
const sbSpectrum = ref(null)
let measuredFor = null
let meterId = null

const sbRefPeaks = computed(() => sbLayers.value.map(l =>
  sbSpectrum.value ? bandRefPeakDb(sbSpectrum.value, l.loHz, l.hiHz) : SAT_DEFAULT_REF_PEAK_DB))
const sbLevelOffset = computed(() => voicingOffsetDb(sbSpectrum.value))

function currentParams() {
  return {
    layers: sbLayers.value.map(l => ({ ...l })),
    refPeaks: [...sbRefPeaks.value],
    levelOffset: sbLevelOffset.value,
  }
}

export function useSaturationBench() {
  const {
    state, appState, totalDuration, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === saturationBenchEffect.id)) {
      chain.addEffect(saturationBenchEffect)
    }
    return chain
  }

  /**
   * Measure the whole file's gated spectrum, once per edit. Whole file, not
   * the selection: the calibration is a property of the recording, and a
   * selection-sized measurement would re-voice every layer as the selection
   * moved.
   */
  function refreshSpectrum() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (measuredFor === key) return
    const end = totalDuration.value
    if (!(end > 0)) return
    measuredFor = key
    sbSpectrum.value = measureBandSpectrum(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    pushAll()
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === saturationBenchEffect.id)?.nodes
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        sbInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        sbOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    sbInputLevels.value = []
    sbOutputLevels.value = []
  }

  function pushAll() {
    if (!sbPreview.value) return
    const chain = getEffectChain(getAudioContext())
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(saturationBenchEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    sbPreview.value = !sbPreview.value
    chain.setEnabled(saturationBenchEffect.id, sbPreview.value)
    if (sbPreview.value) {
      refreshSpectrum()
      pushAll()
      chain.updateParam(saturationBenchEffect.id, 'delta', sbDelta.value)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function toggleDelta() {
    sbDelta.value = !sbDelta.value
    if (!sbPreview.value) return
    getEffectChain(getAudioContext()).updateParam(saturationBenchEffect.id, 'delta', sbDelta.value)
  }

  /** Set one field of one layer. Band edges re-derive that layer's calibration. */
  function syncLayer(k, field, value) {
    const next = sbLayers.value.map(l => ({ ...l }))
    next[k][field] = value
    sbLayers.value = next
    pushAll()
  }

  /** Set several fields of one layer at once (the emphasis quick buttons). */
  function syncLayerFields(k, fields) {
    const next = sbLayers.value.map(l => ({ ...l }))
    Object.assign(next[k], fields)
    sbLayers.value = next
    pushAll()
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = sbPreview.value
    if (wasPreviewing) togglePreview()
    refreshSpectrum()

    startProcessing('Applying Saturation Bench...')
    try {
      const buffer = await applySaturationBenchRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'Saturation Bench')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Saturation Bench applied')
    } catch (err) {
      console.error('Saturation Bench failed:', err)
      showToast('Saturation Bench failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (sbPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.updateParam(saturationBenchEffect.id, 'delta', false)
      chain.setEnabled(saturationBenchEffect.id, false)
      sbPreview.value = false
    }
    sbDelta.value = false
  }

  function resetLayers() {
    sbLayers.value = SAT_BENCH_LAYER_PRESETS.map(l => ({ ...l }))
    pushAll()
  }

  function openModal() {
    openWindow(SATURATION_BENCH_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(SATURATION_BENCH_WINDOW_ID)
  }

  return {
    sbLayers,
    sbPreview,
    sbDelta,
    sbRefPeaks,
    sbSpectrum,
    sbInputLevels,
    sbOutputLevels,
    hasSelection,
    togglePreview,
    toggleDelta,
    syncLayer,
    syncLayerFields,
    resetLayers,
    refreshSpectrum,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
