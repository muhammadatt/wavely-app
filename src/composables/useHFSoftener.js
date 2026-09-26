import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyHFSoftenerRegion, computePeakCache } from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { levelOffsetDbFor } from '../audio/hfSoftenerProcessor.js'
import { getEffectChain } from '../audio/effectChain.js'
import { hfSoftenerEffect, HF_SOFTENER_DEFAULTS } from '../audio/effects/hfSoftener.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_SOFTENER_WINDOW_ID = 'hf-softener'

// Singleton reactive state shared between the sidebar trigger and the modal.
const hfAmount = ref(HF_SOFTENER_DEFAULTS.amount)
const hfShape = ref(HF_SOFTENER_DEFAULTS.shape)
const hfLispGuard = ref(HF_SOFTENER_DEFAULTS.lispGuard)
// The band-limited ResoTame ahead of the softener — an A/B of the pairing,
// with fixed settings (see hfSoftenerResoStage.js).
const hfReso = ref(HF_SOFTENER_DEFAULTS.reso)
const hfResoThreshold = ref(HF_SOFTENER_DEFAULTS.resoThreshold)
// Air makeup: Air Boost's curve after the cut, to put back the top the cut
// takes on average.
const hfAir = ref(HF_SOFTENER_DEFAULTS.air)
// The file's gated RMS and the offset it puts on every detector level. A
// property of the audio, measured, never a user setting.
const hfFileLevelDb = ref(null)
const hfLevelOffset = ref(0)
let levelMeasuredFor = null
// DELTA monitor: hear only what is being removed. Never part of the params
// the apply path renders with.
const hfDelta = ref(false)
const hfPreview = ref(false)
const hfReduction = ref(0)
const hfThresholdLift = ref(0)
const hfInputLevels = ref([])
const hfOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    amount: hfAmount.value,
    // Pinned after listening, and off the panel: Context at 50 %, the rotator
    // on the detector only, a 40 ms release, and the fast release as each
    // vowel starts. The kernel keeps all four switchable for the bench and the
    // tests.
    context: HF_SOFTENER_DEFAULTS.context,
    rotator: HF_SOFTENER_DEFAULTS.rotator,
    release: HF_SOFTENER_DEFAULTS.release,
    vowelRelease: HF_SOFTENER_DEFAULTS.vowelRelease,
    shape: hfShape.value,
    lispGuard: hfLispGuard.value,
    reso: hfReso.value,
    resoThreshold: hfResoThreshold.value,
    air: hfAir.value,
    levelOffset: hfLevelOffset.value,
  }
}

export function useHFSoftener() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === hfSoftenerEffect.id)) {
      chain.addEffect(hfSoftenerEffect)
    }
    return chain
  }

  function nodesOf(chain) {
    return chain.effects.find(e => e.id === hfSoftenerEffect.id)?.nodes
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = nodesOf(chain)
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        hfInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        hfOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
        hfReduction.value = nodes.getReduction()
        hfThresholdLift.value = nodes.getThresholdLift()
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
    hfInputLevels.value = []
    hfOutputLevels.value = []
    hfReduction.value = 0
    hfThresholdLift.value = 0
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(hfSoftenerEffect.id, name, value)
    }
  }

  /**
   * Measure the file's level and move every detector threshold with it, so an
   * Amount setting means the same thing on a quiet recording and a hot one.
   *
   * ⚠ THE WHOLE FILE, NEVER THE SELECTION — the same rule OptoSmooth's input
   * alignment follows (see `regionAlignDb`). Measured per selection, a phrase
   * and the paragraph containing it would get different thresholds, and the
   * same edit applied twice would disagree with itself. Same gated-RMS
   * statistic too, so the two plugins read one number for one file.
   */
  function refreshLevel() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (levelMeasuredFor === key) return
    const end = totalDuration.value
    if (!(end > 0)) return
    // regionAlignDb answers "how far below the alignment target", so the
    // gated level itself is the target minus that.
    const gated = ALIGN_TARGET_DBFS - regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    levelMeasuredFor = key
    hfFileLevelDb.value = gated
    hfLevelOffset.value = levelOffsetDbFor(gated)
    pushParam('levelOffset', hfLevelOffset.value)
  }

  function togglePreview() {
    const chain = initChain()
    hfPreview.value = !hfPreview.value
    chain.setEnabled(hfSoftenerEffect.id, hfPreview.value)

    if (hfPreview.value) {
      refreshLevel()
      pushAllParams(chain)
      nodesOf(chain)?.setListen(hfDelta.value ? 'delta' : 'off')
      startMeters(chain)
    } else {
      // Bypassed, there is nothing to hear in the delta.
      hfDelta.value = false
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!hfPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(hfSoftenerEffect.id, name, value)
  }

  function syncAmount(v) {
    hfAmount.value = v
    pushParam('amount', v)
  }

  function syncAir(v) {
    hfAir.value = v
    pushParam('air', v)
  }

  function syncResoThreshold(v) {
    hfResoThreshold.value = v
    pushParam('resoThreshold', v)
  }

  function syncLispGuard(v) {
    hfLispGuard.value = v
    pushParam('lispGuard', v)
  }

  function syncReso(v) {
    hfReso.value = v
    pushParam('reso', v)
  }

  function syncShape(v) {
    hfShape.value = v
    pushParam('shape', v)
  }

  function toggleDelta() {
    if (!hfPreview.value) return
    hfDelta.value = !hfDelta.value
    nodesOf(getEffectChain(getAudioContext()))?.setListen(hfDelta.value ? 'delta' : 'off')
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = hfPreview.value
    if (wasPreviewing) togglePreview()
    refreshLevel()

    startProcessing('Applying HF Softener...')
    try {
      const buffer = await applyHFSoftenerRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'HF Softener')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('HF Softener applied')
    } catch (err) {
      console.error('HF Softener failed:', err)
      showToast('HF Softener failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    // Delta is a monitoring aid; never leave the chain auditioning it after
    // the window closes.
    hfDelta.value = false
    if (hfPreview.value) {
      const chain = getEffectChain(getAudioContext())
      nodesOf(chain)?.setListen('off')
      chain.setEnabled(hfSoftenerEffect.id, false)
      hfPreview.value = false
    }
  }

  function openModal() {
    openWindow(HF_SOFTENER_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(HF_SOFTENER_WINDOW_ID)
  }

  return {
    hfAmount,
    hfResoThreshold,
    hfAir,
    hfShape,
    hfLispGuard,
    hfReso,
    hfFileLevelDb,
    hfLevelOffset,
    hfDelta,
    hfPreview,
    hfReduction,
    hfThresholdLift,
    hfInputLevels,
    hfOutputLevels,
    hasSelection,
    togglePreview,
    syncAmount,
    syncResoThreshold,
    syncAir,
    syncShape,
    syncLispGuard,
    syncReso,
    toggleDelta,
    refreshLevel,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
