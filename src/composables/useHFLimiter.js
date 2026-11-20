import { reactive, ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import {
  applyHFLimiterRegion, computePeakCache,
} from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { shelfResponseDb } from '../audio/dsp/hfLimit.js'
import {
  FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TRANSIENT_MAX_DB,
} from '../audio/hfLimiterParams.js'
import { HF_LIMITER_OUTPUT_MIN_DB, HF_LIMITER_OUTPUT_MAX_DB } from '../audio/pluginPresets/hfLimiter.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { hfLimiterEffect as soloHfLimiterEffect, HF_LIMITER_DEFAULTS } from '../audio/effects/hfLimiter.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

/** Each typed / dragged param's travel and step — the knobs' own. */
export const HF_LIMITER_TRAVEL = {
  threshold: { lo: THRESHOLD_MIN_DB, hi: THRESHOLD_MAX_DB, step: 0.5 },
  freq: { lo: FREQ_MIN_HZ, hi: FREQ_MAX_HZ, step: 10 },
  range: { lo: 0, hi: RANGE_MAX_DB, step: 0.5 },
  transient: { lo: 0, hi: TRANSIENT_MAX_DB, step: 0.5 },
  release: { lo: RELEASE_MIN_MS, hi: RELEASE_MAX_MS, step: 1 },
  output: { lo: HF_LIMITER_OUTPUT_MIN_DB, hi: HF_LIMITER_OUTPUT_MAX_DB, step: 0.1 },
}

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_LIMITER_WINDOW_ID = 'hf-limiter'

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own state, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const hfLimiterEffect = effectForCopy(soloHfLimiterEffect, copy)
  const windowId = idForCopy(HF_LIMITER_WINDOW_ID, copy)

  // Reactive state shared by every caller of this copy.
  // `voiceLevelDb` is in here because the kernel needs it, but it is measured,
  // never set from the panel.
  const hflParams = reactive({ ...HF_LIMITER_DEFAULTS })
  const hflPreview = ref(false)
  // DELTA monitor: hear only what is being removed. Never part of the params
  // the apply path renders with.
  const hflDelta = ref(false)
  const hflReduction = ref(0)
  const hflTransient = ref(0)
  const hflInputLevels = ref([])
  const hflOutputLevels = ref([])
  let meterId = null
  let levelMeasuredFor = null
  const MEASURED = new Set(['voiceLevelDb'])

  function useHFLimiter() {
    const {
      state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast, totalDuration,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    function initChain() {
      const chain = getEffectChain(getAudioContext())
      if (!chain.effects.find(e => e.id === hfLimiterEffect.id)) chain.addEffect(hfLimiterEffect)
      return chain
    }

    function nodesOf(chain) {
      return chain.effects.find(e => e.id === hfLimiterEffect.id)?.nodes
    }

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const nodes = nodesOf(chain)
        if (nodes) {
          const chCount = state.currentFile?.channels ?? 1
          hflInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          hflOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
          hflReduction.value = nodes.getReduction()
          hflTransient.value = nodes.getTransient()
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
      hflInputLevels.value = []
      hflOutputLevels.value = []
      hflReduction.value = 0
      hflTransient.value = 0
    }

    function pushParam(name, value) {
      if (!hflPreview.value) return
      getEffectChain(getAudioContext()).updateParam(hfLimiterEffect.id, name, value)
    }

    /**
     * Measure the file's voice level and move the threshold with it, so a
     * Threshold setting means the same thing on a quiet recording and a hot one.
     *
     * ⚠ THE WHOLE FILE, NEVER THE SELECTION, and the same gated-RMS statistic —
     * the rule OptoSmooth's input alignment and the De-Esser's level offset
     * already follow, so all three read one number for one file. Measured per
     * selection, a phrase and the paragraph around it would get different
     * thresholds and the same edit applied twice would disagree with itself.
     */
    function refreshLevel(segments = state.segments) {
      if (!state.currentFile) return
      // `segments` is the document's timeline, or — during a chain apply — the
      // chain's running result, which is no revision of the document: always
      // measured, and recorded under a key no real revision matches.
      const own = segments === state.segments
      const key = own ? `${appState.activeDocumentId}:${state.revision}` : `${appState.activeDocumentId}:chain`
      if (own && levelMeasuredFor === key) return
      const end = totalDuration.value
      if (!(end > 0)) return
      const gated = ALIGN_TARGET_DBFS - regionAlignDb(
        segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
      )
      levelMeasuredFor = key
      hflParams.voiceLevelDb = gated
      pushParam('voiceLevelDb', gated)
    }

    function togglePreview() {
      const chain = initChain()
      hflPreview.value = !hflPreview.value
      chain.setEnabled(hfLimiterEffect.id, hflPreview.value)
      if (hflPreview.value) {
        refreshLevel()
        for (const [name, value] of Object.entries(hflParams)) {
          chain.updateParam(hfLimiterEffect.id, name, value)
        }
        nodesOf(chain)?.setListen(hflDelta.value ? 'delta' : 'off')
        startMeters(chain)
      } else {
        // Bypassed, there is nothing to hear in the delta.
        hflDelta.value = false
        stopMeters()
      }
    }

    /** Set one user-facing param. */
    function syncParam(name, value) {
      if (!(name in hflParams) || MEASURED.has(name)) return
      hflParams[name] = value
      pushParam(name, value)
    }

    /**
     * Set a param from a typed value or a drag: snapped to its control's step
     * and clamped to its travel (an LCD or the curve's node has no range of its
     * own). Unchanged values are not re-sent.
     */
    function setParamWithin(name, value) {
      const t = HF_LIMITER_TRAVEL[name]
      if (!t || !Number.isFinite(value)) return
      const v = Math.max(t.lo, Math.min(t.hi, Math.round(value / t.step) * t.step))
      if (v !== hflParams[name]) syncParam(name, v)
    }

    /** A preset's controls, through the same path a knob turn takes. */
    function applyParams(p) {
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined && hflParams[k] !== v) syncParam(k, v)
      }
    }

    function toggleDelta() {
      if (!hflPreview.value) return
      hflDelta.value = !hflDelta.value
      nodesOf(getEffectChain(getAudioContext()))?.setListen(hflDelta.value ? 'delta' : 'off')
    }

    /** What apply re-measures first, so it renders with exact rather than live values. */
    async function prepareApply(segments = state.segments) {
      refreshLevel(segments)
    }

    /** Render [start, end) of `segments` with the current settings, uncommitted. */
    function renderRegion(segments, start, end) {
      return applyHFLimiterRegion(
        segments, start, end,
        { ...hflParams },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return false
      const { start, end } = state.selection
      // Pinned to the document Apply was pressed on: tabs stay usable while it
      // renders, and `state` follows the active one (pinActiveDocument).
      const pin = pinActiveDocument('Hi-Freq Limiter')

      const wasPreviewing = hflPreview.value
      if (wasPreviewing) togglePreview()
      await prepareApply()

      startProcessing('Applying Hi-Freq Limiter...', pin.docId)
      try {
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'Hi-Freq Limiter', pin.docId, pin.selection)
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast('Hi-Freq Limiter applied')
        return true
      } catch (err) {
        console.error('Hi-Freq Limiter failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'Hi-Freq Limiter failed')
        // The window stays open on a failure: hand back the preview it had.
        if (wasPreviewing && !hflPreview.value) togglePreview()
        return false
      } finally {
        endProcessing(pin.docId)
      }
    }

    function teardown() {
      stopMeters()
      // Delta is a monitoring aid; never leave the chain auditioning it after
      // the window closes.
      hflDelta.value = false
      const chain = getEffectChainIfExists()
      if (chain) nodesOf(chain)?.setListen('off')
    }

    registerChainPlugin({
      id: hfLimiterEffect.id,
      windowId,
      label: 'Hi-Freq Limiter',
      dispose: life.dispose,
      isActive: () => hflPreview.value,
      setActive: (on) => { if (hflPreview.value !== on) togglePreview() },
      render: async (segments, start, end) => {
        await prepareApply(segments)
        return renderRegion(segments, start, end)
      },
      resume: () => startMeters(initChain()),
      suspend: teardown,
    })

    function openModal() {
      openWindow(windowId)
    }

    function closeModal() {
      closeWindow(windowId)
    }

    /**
     * The shelf's frequency response at `freqs`, dB, with its cut band at
     * linear gain `gain` (1 = no cut), at the current Freq and shape and the
     * file's rate (44.1 kHz before a file is loaded) — what the panel draws:
     * the live cut, the Range floor and the node on it.
     */
    function responseDb(freqs, gain) {
      const sr = state.currentFile?.sampleRate ?? 44100
      return shelfResponseDb(sr, hflParams.freq, gain, freqs, hflParams.shape)
    }

    return {
      responseDb,
      setParamWithin,
      hflParams,
      hflPreview,
      hflDelta,
      hflReduction,
      hflTransient,
      hflInputLevels,
      hflOutputLevels,
      hasSelection,
      togglePreview,
      syncParam,
      applyParams,
      toggleDelta,
      apply,
      teardown,
      openModal,
      closeModal,
    }
  }

  return useHFLimiter
})

/** The copy the calling window edits (the solo copy outside a plugin window), or `copy` when named. */
export function useHFLimiter(copy) {
  return copies(copy)()
}

/** The copies of this plugin built so far, without building any (see perFilePluginSettings.js). */
useHFLimiter.builtCopies = () => copies.built()
