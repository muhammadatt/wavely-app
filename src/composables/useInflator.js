import { ref } from 'vue'
import { useEditorState, DocumentSwitchedError } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { applyInflatorRegion, computePeakCache } from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { inflatorEffect as soloInflatorEffect, INFLATOR_DEFAULTS } from '../audio/effects/inflator.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'
import { registerChainPlugin } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const INFLATOR_WINDOW_ID = 'inflator'

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own state, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const inflatorEffect = effectForCopy(soloInflatorEffect, copy)
  const windowId = idForCopy(INFLATOR_WINDOW_ID, copy)

  // Reactive state shared by every caller of this copy.
  const inInputDb = ref(INFLATOR_DEFAULTS.inputDb)
  const inEffect = ref(INFLATOR_DEFAULTS.effect)
  const inCurve = ref(INFLATOR_DEFAULTS.curve)
  const inOutputDb = ref(INFLATOR_DEFAULTS.outputDb)
  const inClip = ref(INFLATOR_DEFAULTS.clip)
  const inBandSplit = ref(INFLATOR_DEFAULTS.bandSplit)

  const inPreview = ref(false)
  const inInputLevels = ref([])
  const inOutputLevels = ref([])
  // What the curve is adding right now, dB per channel: output RMS less input RMS,
  // with Input and Output taken out (both taps sit outside those gains' reach in
  // opposite ways — the input tap is ahead of Input, the output tap after
  // Output). Quiet passages read the curve's full small-signal lift, loud ones
  // nearly nothing: the Inflator's whole effect, metered.
  const inLiftDb = ref([])
  const LIFT_GATE_DB = -60
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

  function useInflator() {
    const {
      state, getAudioContext, hasSelection, replaceRegion, setPeakCache,
      startProcessing, endProcessing, pinActiveDocument, showToast,
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
          inLiftDb.value = inInputLevels.value.map((lin, ch) => {
            const lout = inOutputLevels.value[ch]
            if (!lout || !(lin.rmsDb > LIFT_GATE_DB)) return 0
            return Math.max(0, (lout.rmsDb - inOutputDb.value) - (lin.rmsDb + inInputDb.value))
          })
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
      inLiftDb.value = []
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

    /** Put a whole param set into effect (a preset). */
    function applyParams(p) {
      syncParam('inputDb', inInputDb, p.inputDb)
      syncParam('effect', inEffect, p.effect)
      syncParam('curve', inCurve, p.curve)
      syncParam('outputDb', inOutputDb, p.outputDb)
      syncParam('clip', inClip, p.clip)
      syncParam('bandSplit', inBandSplit, p.bandSplit)
    }

    const syncInputDb = v => syncParam('inputDb', inInputDb, v)
    const syncEffect = v => syncParam('effect', inEffect, v)
    const syncCurve = v => syncParam('curve', inCurve, v)
    const syncOutputDb = v => syncParam('outputDb', inOutputDb, v)
    const syncClip = v => syncParam('clip', inClip, v)
    const syncBandSplit = v => syncParam('bandSplit', inBandSplit, v)

    /** Render [start, end) of `segments` with the current settings, uncommitted. */
    function renderRegion(segments, start, end) {
      return applyInflatorRegion(
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
      const pin = pinActiveDocument('Cambridge Inflator')

      const wasPreviewing = inPreview.value
      if (wasPreviewing) togglePreview()

      startProcessing('Inflating...', pin.docId)
      try {
        const buffer = await renderRegion(state.segments, start, end)
        pin.check()
        const bufferId = replaceRegion(start, end, buffer, 'inflator', pin.docId)
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast('Cambridge Inflator applied')
      } catch (err) {
        console.error('Inflator failed:', err)
        showToast(err instanceof DocumentSwitchedError ? err.message : 'Cambridge Inflator failed')
      } finally {
        endProcessing(pin.docId)
      }
    }

    // The window closing stops the meters only: the plugin keeps its slot in
    // the chain, live or bypassed, until it is removed there.
    function teardown() {
      stopMeters()
    }

    registerChainPlugin({
      id: inflatorEffect.id,
      windowId,
      label: 'Cambridge Inflator',
      dispose: life.dispose,
      isActive: () => inPreview.value,
      setActive: (on) => { if (inPreview.value !== on) togglePreview() },
      render: renderRegion,
      resume: () => startMeters(initChain()),
      suspend: teardown,
    })

    function openModal() {
      openWindow(windowId)
    }

    function closeModal() {
      closeWindow(windowId)
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
      inLiftDb,
      hasSelection,
      currentParams,
      applyParams,
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

  return useInflator
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function useInflator() {
  return copies()()
}
