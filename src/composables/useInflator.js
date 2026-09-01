import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyInflatorRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { inflatorEffect, INFLATOR_DEFAULTS } from '../audio/effects/inflator.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const INFLATOR_WINDOW_ID = 'inflator'

// Singleton reactive state shared between the sidebar trigger and the modal.
const inInputDb = ref(INFLATOR_DEFAULTS.inputDb)
const inEffect = ref(INFLATOR_DEFAULTS.effect)
const inCurve = ref(INFLATOR_DEFAULTS.curve)
const inOutputDb = ref(INFLATOR_DEFAULTS.outputDb)
const inClip = ref(INFLATOR_DEFAULTS.clip)
const inBandSplit = ref(INFLATOR_DEFAULTS.bandSplit)

const inPreview = ref(false)
const inInputLevels = ref([])
const inOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    inputDb: inInputDb.value,
    effect: inEffect.value,
    curve: inCurve.value,
    outputDb: inOutputDb.value,
    clip: inClip.value,
    bandSplit: inBandSplit.value,
  }
}

export function useInflator() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === inflatorEffect.id)) {
      chain.addEffect(inflatorEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === inflatorEffect.id)?.nodes
      if (nodes) {
        // Only meter channels the source really has: the splitter is discrete,
        // so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        inInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        inOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    inInputLevels.value = []
    inOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(inflatorEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    inPreview.value = !inPreview.value
    chain.setEnabled(inflatorEffect.id, inPreview.value)

    if (inPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!inPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(inflatorEffect.id, name, value)
  }

  function syncParam(name, refVar, value) {
    refVar.value = value
    pushParam(name, value)
  }

  const syncInputDb = v => syncParam('inputDb', inInputDb, v)
  const syncEffect = v => syncParam('effect', inEffect, v)
  const syncCurve = v => syncParam('curve', inCurve, v)
  const syncOutputDb = v => syncParam('outputDb', inOutputDb, v)
  const syncClip = v => syncParam('clip', inClip, v)
  const syncBandSplit = v => syncParam('bandSplit', inBandSplit, v)

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = inPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Inflating...')
    try {
      const buffer = await applyInflatorRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'inflator')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Inflator applied')
    } catch (err) {
      console.error('Inflator failed:', err)
      showToast('Inflator failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (inPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(inflatorEffect.id, false)
      inPreview.value = false
    }
  }

  function openModal() {
    openWindow(INFLATOR_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(INFLATOR_WINDOW_ID)
  }

  return {
    inInputDb,
    inEffect,
    inCurve,
    inOutputDb,
    inClip,
    inBandSplit,
    inPreview,
    inInputLevels,
    inOutputLevels,
    hasSelection,
    togglePreview,
    syncInputDb,
    syncEffect,
    syncCurve,
    syncOutputDb,
    syncClip,
    syncBandSplit,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
