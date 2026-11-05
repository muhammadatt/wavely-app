import { computed, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin, settingsKeyOf } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import {
  analyzeHumRegion,
  applyHumNotchRegion,
  computePeakCache,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { humNotchEffect as soloHumNotchEffect, HUM_NOTCH_DEFAULTS } from '../audio/effects/humNotch.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HUM_REMOVER_WINDOW_ID = 'hum-remover'

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own state, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const humNotchEffect = effectForCopy(soloHumNotchEffect, copy)
  const windowId = idForCopy(HUM_REMOVER_WINDOW_ID, copy)

  // Reactive state shared by every caller of this copy.
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
  const humInputLevels = ref([])
  const humOutputLevels = ref([])
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

  function useHumRemover() {
    const {
      state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast,
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
          // Only meter channels the source really has: the splitter is
          // discrete, so asking for stereo on a mono file adds a dead bar.
          const chCount = state.currentFile?.channels ?? 1
          humInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          humOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
      humInputLevels.value = []
      humOutputLevels.value = []
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

    /** Render [start, end) of `segments` with the current settings, uncommitted. */
    function renderRegion(segments, start, end) {
      return applyHumNotchRegion(
        segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return
      const { start, end } = state.selection
      // Pinned to the document Apply was pressed on: tabs stay usable while it
      // renders, and `state` follows the active one (pinActiveDocument).
      const pin = pinActiveDocument('Hum Remover')

      const wasPreviewing = humPreview.value
      if (wasPreviewing) togglePreview()

      startProcessing('Removing hum...', pin.docId)
      try {
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'hum removal', pin.docId)
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast('Hum removed')
        // The audio just changed, so the measurement no longer describes it.
        clearAnalysis()
      } catch (err) {
        console.error('Hum removal failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'Hum removal failed')
      } finally {
        endProcessing(pin.docId)
      }
    }

    function teardown() {
      stopMeters()
    }

    registerChainPlugin({
      id: humNotchEffect.id,
      windowId,
      label: 'Hum Remover',
      settingsKey: () => settingsKeyOf(currentParams()),
      dispose: life.dispose,
      isActive: () => humPreview.value,
      setActive: (on) => { if (humPreview.value !== on) togglePreview() },
      render: renderRegion,
      resume: () => startMeters(initChain()),
      suspend: teardown,
      afterApply: () => clearAnalysis(),
    })

    function openModal() {
      openWindow(windowId)
    }

    function closeModal() {
      closeWindow(windowId)
    }

    return {
      humFundamental,
      humQ,
      humDepth,
      humHarmonics,
      humAnalysis,
      humAnalyzing,
      humPreview,
      humInputLevels,
      humOutputLevels,
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

  return useHumRemover
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function useHumRemover() {
  return copies()()
}
