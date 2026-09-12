import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { computeAutoLevelAnalysis, applyGainEnvelopeRegion, computePeakCache }
  from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { autoLevelEffect } from '../audio/effects/autoLevel.js'
import { renderAutoLevelGainDb, AUTO_LEVEL_DEFAULTS } from '../audio/dsp/autoLevel.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const AUTO_LEVEL_WINDOW_ID = 'auto-level'

/**
 * ⚠ THERE IS AN EXPLICIT ANALYSE STEP, AND IT IS NOT A UI PREFERENCE. Clip
 * detection walks every sample several times — a K-weighting cascade per
 * channel, a block-energy prefix sum, and a frame-RMS pass — over the WHOLE
 * timeline rather than a capped window. Measured: 90 ms for a minute, 0.6 s for
 * ten, 3.2 s for an hour. An hour-long chapter is what the beachhead audience
 * uploads, so re-running it on every knob move is not available; the de-esser
 * has an explicit Analyse for exactly the same reason.
 *
 * ⚠ WHICH MEANS EVERY CONFIG CONTROL INVALIDATES THE ANALYSIS. The gain solve is
 * cheap and the detection is not, so in principle the two could be split and the
 * knobs made live against a frozen detection — the de-esser does precisely that
 * with its decision and detection halves. `analyzeAutoLevel` does both in one
 * pass today; splitting it is a known follow-up, not an oversight.
 */
const config = ref({ ...AUTO_LEVEL_DEFAULTS })

const analysis = ref(null)
/** Which timeline the analysis describes — `docId:revision`, or null. */
const analyzedFor = ref(null)
const analyzing = ref(false)

const preview = ref(false)
const gainDb = ref(0)
const inputLevels = ref([])
const outputLevels = ref([])
let meterId = null

export function useAutoLevel() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  /**
   * Identity of the timeline currently loaded.
   *
   * ⚠ KEYED ON DOCUMENT AND REVISION, not merely null-checked. This state is a
   * module singleton and the document under it can change: `setActiveDocument`
   * swaps the active id without touching plugin state, so with this panel left
   * open an analysis from the previous file would otherwise describe the new
   * one. The revision is in the key too, because an edit changes which samples
   * the clip offsets point at — cutting a paragraph moves everything after it.
   */
  function timelineKey() {
    return state.currentFile ? `${appState.activeDocumentId}:${state.revision}` : null
  }

  const isStale = computed(
    () => analysis.value !== null && analyzedFor.value !== timelineKey(),
  )
  const hasAnalysis = computed(() => analysis.value?.applied === true)
  const envelopeValid = computed(() => hasAnalysis.value && !isStale.value)

  /** What the analysis decided, for the panel to show rather than imply. */
  const summary = computed(() => {
    const a = analysis.value
    if (!a) return null
    if (!a.applied) return { applied: false, reason: a.skippedReason }
    return {
      applied: true,
      clips: a.clips.length,
      splits: a.subphraseSplits,
      merges: a.merges,
      noiseFloorDbfs: a.noiseFloorDbfs,
      clipStdDb: a.clipStdDb,
      maxUpDbEffective: a.maxUpDbEffective,
      /** True when the noise floor, not the config, is what caps the lift. */
      noiseFloorCapped: a.maxUpDbEffective < config.value.maxUpDb - 1e-9,
      maxGainDb: a.gainsDb.length ? Math.max(...a.gainsDb) : 0,
      minGainDb: a.gainsDb.length ? Math.min(...a.gainsDb) : 0,
    }
  })

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === autoLevelEffect.id)) {
      chain.addEffect(autoLevelEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === autoLevelEffect.id)?.nodes
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        inputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        outputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
        /**
         * ⚠ NOT DAMPED THE WAY A GAIN-REDUCTION METER IS. The other plugins hold
         * a peak and release it slowly because their reduction is transient — a
         * syllable long. This gain is piecewise CONSTANT for seconds at a time,
         * so a release curve would only make the readout lag the clip it is
         * describing. It is shown as it is.
         */
        gainDb.value = nodes.getGainDb()
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
    inputLevels.value = []
    outputLevels.value = []
    gainDb.value = 0
  }

  /**
   * The span the envelope is built over: the selection, or the whole file when
   * there is none.
   *
   * ⚠ NO SELECTION MEANS THE WHOLE FILE, NOT "NOTHING". That is what preview
   * PLAYS with nothing selected, and a plugin that sat silent in that case would
   * be a panel claiming to be on while doing nothing — the defect
   * `refreshAutoMakeup` records fixing for the same reason.
   */
  function previewSpan() {
    const start = state.selection ? state.selection.start : 0
    const end = state.selection ? state.selection.end : totalDuration.value
    return end > start ? { start, end } : null
  }

  /**
   * Deviation-from-unity envelope for a span, or null.
   *
   * ⚠ REGION-SCOPED BUFFER, WHOLE-FILE ANALYSIS. `renderAutoLevelGainDb` takes
   * an ABSOLUTE start sample, so the clip plan is read at the right place
   * without ever materialising an envelope for the whole timeline — which would
   * be 635 MB of Float32 for an hour-long chapter.
   */
  function buildEnvelope(span) {
    if (!envelopeValid.value || !span || !state.currentFile) return null
    const sr = state.currentFile.sampleRate
    const startSample = Math.round(span.start * sr)
    const numSamples = Math.round((span.end - span.start) * sr)
    if (numSamples <= 0) return null

    const db = renderAutoLevelGainDb(analysis.value, startSample, numSamples)
    const deviation = new Float32Array(numSamples)
    for (let i = 0; i < numSamples; i++) deviation[i] = Math.pow(10, db[i] / 20) - 1
    return { deviation, startSec: span.start }
  }

  function pushEnvelope() {
    if (!preview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(autoLevelEffect.id, 'envelope', buildEnvelope(previewSpan()))
  }

  function togglePreview() {
    const chain = initChain()
    preview.value = !preview.value
    chain.setEnabled(autoLevelEffect.id, preview.value)

    if (preview.value) {
      chain.updateParam(autoLevelEffect.id, 'envelope', buildEnvelope(previewSpan()))
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  /** Every config control routes through here. */
  function syncConfig(name, value) {
    config.value = { ...config.value, [name]: value }
    /**
     * ⚠ THE ANALYSIS IS DROPPED, NOT KEPT AND RE-SOLVED. Every one of these
     * feeds the clip solve, and three of them (the target mode and window, the
     * noise-floor target) change which clips exist or what they are compared
     * against. Keeping a stale plan on screen while the knobs say otherwise is
     * the failure mode this avoids; the panel asks for Analyse again.
     */
    analysis.value = null
    analyzedFor.value = null
    pushEnvelope()
  }

  function clearAnalysis() {
    analysis.value = null
    analyzedFor.value = null
    pushEnvelope()
  }

  /** Measure the WHOLE timeline and build the clip plan. */
  async function analyze() {
    if (!state.currentFile) return
    const end = totalDuration.value
    if (!(end > 0)) return

    analyzing.value = true
    try {
      const result = await computeAutoLevelAnalysis(
        state.segments, end, state.currentFile.sampleRate, state.currentFile.channels,
        { ...config.value },
      )
      analysis.value = result
      analyzedFor.value = timelineKey()
      pushEnvelope()
      if (!result.applied) {
        showToast(result.skippedReason === 'file_already_leveled'
          ? 'Auto Level: this file is already level'
          : `Auto Level: nothing to do (${result.skippedReason})`)
      }
    } catch (err) {
      console.error('Auto Level analysis failed:', err)
      showToast('Auto Level analysis failed')
    } finally {
      analyzing.value = false
    }
  }

  async function apply() {
    if (!state.selection || !envelopeValid.value) return
    const { start, end } = state.selection
    const envelope = buildEnvelope({ start, end })
    if (!envelope) return

    const wasPreviewing = preview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Auto Level...')
    try {
      const buffer = applyGainEnvelopeRegion(
        state.segments, start, end, envelope.deviation,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'Auto Level')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Auto Level applied')
    } catch (err) {
      console.error('Auto Level apply failed:', err)
      showToast('Auto Level apply failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    if (preview.value) togglePreview()
  }

  function openModal() {
    openWindow(AUTO_LEVEL_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(AUTO_LEVEL_WINDOW_ID)
  }

  return {
    config,
    analysis,
    analyzing,
    preview,
    gainDb,
    inputLevels,
    outputLevels,
    isStale,
    hasAnalysis,
    envelopeValid,
    summary,
    hasSelection,
    analyze,
    clearAnalysis,
    syncConfig,
    togglePreview,
    pushEnvelope,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
