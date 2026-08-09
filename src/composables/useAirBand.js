import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyAirBandRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { airBandEffect, AIR_BAND_DEFAULTS } from '../audio/effects/airBand.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const AIR_BAND_WINDOW_ID = 'air-band'

// Singleton reactive state shared between the sidebar trigger and the modal.
const airBandAir = ref(AIR_BAND_DEFAULTS.air)
const airBandOutput = ref(AIR_BAND_DEFAULTS.output)
const airBandPreview = ref(false)
const airBandInputLevels = ref([])
const airBandOutputLevels = ref([])
let meterId = null

function currentParams() {
  return {
    air: airBandAir.value,
    output: airBandOutput.value,
  }
}

export function useAirBand() {
  const {
    state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === airBandEffect.id)) {
      chain.addEffect(airBandEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === airBandEffect.id)?.nodes
      if (nodes) {
        // Only meter channels the source really has: the splitter is
        // discrete, so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        airBandInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        airBandOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    airBandInputLevels.value = []
    airBandOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(airBandEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    airBandPreview.value = !airBandPreview.value
    chain.setEnabled(airBandEffect.id, airBandPreview.value)

    if (airBandPreview.value) {
      pushAllParams(chain)
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!airBandPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(airBandEffect.id, name, value)
  }

  function syncAir(v) {
    airBandAir.value = v
    pushParam('air', v)
  }

  function syncOutput(v) {
    airBandOutput.value = v
    pushParam('output', v)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    const wasPreviewing = airBandPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying AirBoost...')
    try {
      const buffer = await applyAirBandRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer)
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('AirBoost applied')
    } catch (err) {
      console.error('AirBoost failed:', err)
      showToast('AirBoost failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (airBandPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(airBandEffect.id, false)
      airBandPreview.value = false
    }
  }

  function openModal() {
    openWindow(AIR_BAND_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(AIR_BAND_WINDOW_ID)
  }

  return {
    airBandAir,
    airBandOutput,
    airBandPreview,
    airBandInputLevels,
    airBandOutputLevels,
    hasSelection,
    togglePreview,
    syncAir,
    syncOutput,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
