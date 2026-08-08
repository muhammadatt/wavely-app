import { computed, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  analyzeHumRegion,
  applyHumNotchRegion,
  computePeakCache,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { humNotchEffect, HUM_NOTCH_DEFAULTS } from '../audio/effects/humNotch.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HUM_REMOVER_WINDOW_ID = 'hum-remover'

// Singleton reactive state shared between the sidebar trigger and the modal.
const humFundamental = ref(60) // 50 Hz (EU) or 60 Hz (US/JP)
const humQ = ref(HUM_NOTCH_DEFAULTS.q)
const humDepth = ref(HUM_NOTCH_DEFAULTS.depth)

/**
 * One entry per harmonic from the last analysis, each with its measurement and
 * an `enabled` flag. This is the replacement for the server's F0 veto: rather
 * than silently dropping a candidate that sits on the speaker's pitch, the
 * measurement is shown and the choice is the user's.
 */
const humHarmonics = ref([])
const humAnalysis = ref(null) // full detectHum() result, or null
const humAnalyzing = ref(false)

/**
 * Identifies the audio the current analysis was run against. Any edit mints a
 * new buffer id, so a stale result is easy to spot — notching frequencies
 * measured from audio that has since been replaced would be quietly wrong.
 */
const analyzedKey = ref(null)

const humPreview = ref(false)
const humInputDb = ref(-Infinity)
const humOutputDb = ref(-Infinity)
const humInputPeakDb = ref(-Infinity)
const humOutputPeakDb = ref(-Infinity)
let meterId = null

/** Frequencies the user currently has ticked. */
function enabledFrequencies() {
  return humHarmonics.value.filter(h => h.enabled).map(h => h.frequency)
}

function currentParams() {
  return {
    frequencies: enabledFrequencies(),
    q: humQ.value,
    depth: humDepth.value,
  }
}

export function useHumRemover() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  /** Key describing the exact audio a result was measured from. */
  function selectionKey() {
    if (!state.selection || !state.currentFile) return null
    const { start, end } = state.selection
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${start.toFixed(6)}:${end.toFixed(6)}:${ids}`
  }

  /** True when the analysis no longer describes the current selection. */
  const isStale = computed(
    () => humAnalysis.value !== null && analyzedKey.value !== selectionKey(),
  )

  const hasEnabledNotches = computed(() => humHarmonics.value.some(h => h.enabled))

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === humNotchEffect.id)) {
      chain.addEffect(humNotchEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === humNotchEffect.id)?.nodes
      if (nodes) {
        const inLevels = nodes.getInputLevels()
        humInputDb.value = inLevels.rmsDb
        humInputPeakDb.value = inLevels.peakDb
        const outLevels = nodes.getOutputLevels()
        humOutputDb.value = outLevels.rmsDb
        humOutputPeakDb.value = outLevels.peakDb
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
    humInputDb.value = -Infinity
    humOutputDb.value = -Infinity
    humInputPeakDb.value = -Infinity
    humOutputPeakDb.value = -Infinity
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(humNotchEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    humPreview.value = !humPreview.value
    chain.setEnabled(humNotchEffect.id, humPreview.value)

    if (humPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!humPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(humNotchEffect.id, name, value)
  }

  function pushFrequencies() {
    pushParam('frequencies', enabledFrequencies())
  }

  function syncQ(v) {
    humQ.value = v
    pushParam('q', v)
  }

  function syncDepth(v) {
    humDepth.value = v
    pushParam('depth', v)
  }

  /** Tick or untick one harmonic. */
  function toggleHarmonic(frequency) {
    const h = humHarmonics.value.find(x => x.frequency === frequency)
    if (!h) return
    h.enabled = !h.enabled
    pushFrequencies()
  }

  /**
   * Switch mains frequency. The previous analysis was measured against the old
   * harmonic series, so it is discarded rather than left to look current.
   */
  function setFundamental(hz) {
    if (humFundamental.value === hz) return
    humFundamental.value = hz
    clearAnalysis()
  }

  function clearAnalysis() {
    humAnalysis.value = null
    humHarmonics.value = []
    analyzedKey.value = null
    pushFrequencies()
  }

  /** Run detection over the current selection. */
  async function analyze() {
    if (!state.selection || !state.currentFile) return
    const { start, end } = state.selection

    humAnalyzing.value = true
    try {
      const result = await analyzeHumRegion(
        state.segments, start, end,
        state.currentFile.sampleRate, state.currentFile.channels,
        { fundamental: humFundamental.value },
      )

      humAnalysis.value = result
      analyzedKey.value = selectionKey()
      // Pre-tick what the detector recommends — flagged, minus anything the
      // pitch check attributed to a sustained source in the recording. Every
      // harmonic is still listed with its measurement so the user can override
      // either way.
      humHarmonics.value = result.detectionDetail.map(d => ({
        ...d,
        enabled: d.flagged && !d.matchesPitchedSource,
      }))
      pushFrequencies()

      if (result.tooShort) {
        showToast('Selection too short to detect hum reliably')
      } else if (!result.triggered) {
        const vetoed = result.detectionDetail.filter(d => d.flagged && d.matchesPitchedSource)
        showToast(
          vetoed.length > 0
            ? 'No hum found — that energy belongs to the recording itself'
            : 'No mains hum detected',
        )
      } else {
        const n = result.recommendedHarmonics.length
        showToast(`Hum detected on ${n} harmonic${n === 1 ? '' : 's'}`)
      }
    } catch (err) {
      console.error('Hum analysis failed:', err)
      showToast('Hum analysis failed')
    } finally {
      humAnalyzing.value = false
    }
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = humPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Removing hum...')
    try {
      const buffer = await applyHumNotchRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Hum removed')
      // The audio just changed, so the measurement no longer describes it.
      clearAnalysis()
    } catch (err) {
      console.error('Hum removal failed:', err)
      showToast('Hum removal failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (humPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(humNotchEffect.id, false)
      humPreview.value = false
    }
  }

  function openModal() {
    openWindow(HUM_REMOVER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(HUM_REMOVER_WINDOW_ID)
  }

  return {
    humFundamental,
    humQ,
    humDepth,
    humHarmonics,
    humAnalysis,
    humAnalyzing,
    humPreview,
    humInputDb,
    humOutputDb,
    humInputPeakDb,
    humOutputPeakDb,
    isStale,
    hasEnabledNotches,
    hasSelection,
    togglePreview,
    analyze,
    clearAnalysis,
    toggleHarmonic,
    setFundamental,
    syncQ,
    syncDepth,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
