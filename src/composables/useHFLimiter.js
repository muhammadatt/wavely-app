import { reactive, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applyHFLimiterRegion, computePeakCache,
} from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain } from '../audio/effectChain.js'
import { hfLimiterEffect, HF_LIMITER_DEFAULTS } from '../audio/effects/hfLimiter.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_LIMITER_WINDOW_ID = 'hf-limiter'

// Singleton reactive state shared between the sidebar trigger and the modal.
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

export function useHFLimiter() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
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
   * the rule OptoSmooth's input alignment and the HF Softener's level offset
   * already follow, so all three read one number for one file. Measured per
   * selection, a phrase and the paragraph around it would get different
   * thresholds and the same edit applied twice would disagree with itself.
   */
  function refreshLevel() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (levelMeasuredFor === key) return
    const end = totalDuration.value
    if (!(end > 0)) return
    const gated = ALIGN_TARGET_DBFS - regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
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

  function toggleDelta() {
    if (!hflPreview.value) return
    hflDelta.value = !hflDelta.value
    nodesOf(getEffectChain(getAudioContext()))?.setListen(hflDelta.value ? 'delta' : 'off')
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = hflPreview.value
    if (wasPreviewing) togglePreview()
    refreshLevel()

    startProcessing('Applying HF Limiter...')
    try {
      const buffer = await applyHFLimiterRegion(
        state.segments, start, end,
        { ...hflParams },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'HF Limiter')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('HF Limiter applied')
    } catch (err) {
      console.error('HF Limiter failed:', err)
      showToast('HF Limiter failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    // Delta is a monitoring aid; never leave the chain auditioning it after
    // the window closes.
    hflDelta.value = false
    if (hflPreview.value) {
      const chain = getEffectChain(getAudioContext())
      nodesOf(chain)?.setListen('off')
      chain.setEnabled(hfLimiterEffect.id, false)
      hflPreview.value = false
    }
  }

  function openModal() {
    openWindow(HF_LIMITER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(HF_LIMITER_WINDOW_ID)
  }

  return {
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
    toggleDelta,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
