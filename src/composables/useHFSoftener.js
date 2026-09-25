import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyHFSoftenerRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { hfSoftenerEffect, HF_SOFTENER_DEFAULTS } from '../audio/effects/hfSoftener.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const HF_SOFTENER_WINDOW_ID = 'hf-softener'

// Singleton reactive state shared between the sidebar trigger and the modal.
const hfAmount = ref(HF_SOFTENER_DEFAULTS.amount)
const hfContext = ref(HF_SOFTENER_DEFAULTS.context)
const hfRotator = ref(HF_SOFTENER_DEFAULTS.rotator)
const hfRelease = ref(HF_SOFTENER_DEFAULTS.release)
const hfVowelRelease = ref(HF_SOFTENER_DEFAULTS.vowelRelease)
const hfShape = ref(HF_SOFTENER_DEFAULTS.shape)
// Monitor tap. Never part of the params the apply path renders with.
const hfListen = ref('off')
const hfPreview = ref(false)
const hfReduction = ref(0)
const hfThresholdLift = ref(0)
const hfInputLevels = ref([])
const hfOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    amount: hfAmount.value,
    context: hfContext.value,
    rotator: hfRotator.value,
    release: hfRelease.value,
    vowelRelease: hfVowelRelease.value,
    shape: hfShape.value,
  }
}

export function useHFSoftener() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
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

  function togglePreview() {
    const chain = initChain()
    hfPreview.value = !hfPreview.value
    chain.setEnabled(hfSoftenerEffect.id, hfPreview.value)

    if (hfPreview.value) {
      pushAllParams(chain)
      nodesOf(chain)?.setListen(hfListen.value)
      startMeters(chain)
    } else {
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

  function syncContext(v) {
    hfContext.value = v
    pushParam('context', v)
  }

  function syncRotator(v) {
    hfRotator.value = v
    pushParam('rotator', v)
  }

  function syncRelease(v) {
    hfRelease.value = v
    pushParam('release', v)
  }

  function syncVowelRelease(v) {
    hfVowelRelease.value = v
    pushParam('vowelRelease', v)
  }

  function syncShape(v) {
    hfShape.value = v
    pushParam('shape', v)
  }

  function syncListen(v) {
    hfListen.value = v
    if (!hfPreview.value) return
    nodesOf(getEffectChain(getAudioContext()))?.setListen(v)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = hfPreview.value
    if (wasPreviewing) togglePreview()

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
    // Listen is a monitoring aid; never leave the chain auditioning the delta
    // or the sidechain after the window closes.
    hfListen.value = 'off'
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
    hfContext,
    hfRotator,
    hfRelease,
    hfVowelRelease,
    hfShape,
    hfListen,
    hfPreview,
    hfReduction,
    hfThresholdLift,
    hfInputLevels,
    hfOutputLevels,
    hasSelection,
    togglePreview,
    syncAmount,
    syncContext,
    syncRotator,
    syncRelease,
    syncVowelRelease,
    syncShape,
    syncListen,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
