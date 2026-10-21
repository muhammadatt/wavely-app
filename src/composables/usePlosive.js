import { reactive, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { registerChainPlugin } from './usePluginChain.js'
import { pluginCopies, effectForCopy, idForCopy } from './pluginCopies.js'
import { applyPlosiveRegion, computePeakCache } from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../audio/dsp/inputAlign.js'
import { getEffectChain, getEffectChainIfExists } from '../audio/effectChain.js'
import { plosiveEffect as soloPlosiveEffect, PLOSIVE_DEFAULTS } from '../audio/effects/plosive.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const PLOSIVE_WINDOW_ID = 'plosive'

/**
 * One copy of the plugin — the solo copy or the chain's (pluginCopies.js). Each
 * has its own state, its own node in the EffectChain and its own window.
 */
const copies = pluginCopies((copy, life) => {
  const plosiveEffect = effectForCopy(soloPlosiveEffect, copy)
  const windowId = idForCopy(PLOSIVE_WINDOW_ID, copy)

  // Reactive state shared by every caller of this copy. `voiceLevelDb` is in
  // here because the kernel needs it, but it is measured, never set from the panel.
  const plParams = reactive({ ...PLOSIVE_DEFAULTS })
  const plPreview = ref(false)
  // DELTA monitor: hear only what is being removed. Never part of the params
  // the apply path renders with.
  const plDelta = ref(false)
  const plPopCut = ref(0)
  const plBurstCut = ref(0)
  const plPops = ref(0)
  const plBursts = ref(0)
  const plInputLevels = ref([])
  const plOutputLevels = ref([])
  let meterId = null
  let levelMeasuredFor = null
  const MEASURED = new Set(['voiceLevelDb'])

  function usePlosive() {
    const {
      state, appState, getAudioContext, replaceRegion, setPeakCache,
      startProcessing, endProcessing, showToast, totalDuration,
    } = useEditorState()
    const { openWindow, closeWindow } = useWindows()

    function initChain() {
      const chain = getEffectChain(getAudioContext())
      if (!chain.effects.find(e => e.id === plosiveEffect.id)) chain.addEffect(plosiveEffect)
      return chain
    }

    function nodesOf(chain) {
      return chain.effects.find(e => e.id === plosiveEffect.id)?.nodes
    }

    function liveNodes() {
      if (!plPreview.value) return null
      return nodesOf(getEffectChain(getAudioContext())) ?? null
    }

    function startMeters(chain) {
      stopMeters()
      function tick() {
        const nodes = nodesOf(chain)
        if (nodes) {
          const chCount = state.currentFile?.channels ?? 1
          plInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
          plOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
          const r = nodes.getReduction()
          plPopCut.value = r.pop
          plBurstCut.value = r.burst
          const c = nodes.getCounts()
          plPops.value = c.pops
          plBursts.value = c.bursts
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
      plInputLevels.value = []
      plOutputLevels.value = []
      plPopCut.value = 0
      plBurstCut.value = 0
    }

    function pushParam(name, value) {
      if (!plPreview.value) return
      getEffectChain(getAudioContext()).updateParam(plosiveEffect.id, name, value)
    }

    /**
     * Measure the file's voice level, which POP's rumble gate is relative to.
     * ⚠ THE WHOLE FILE, NEVER THE SELECTION, and the same gated-RMS statistic
     * the HF Limiter and the De-Esser read — one number for one file.
     */
    function refreshLevel(segments = state.segments) {
      if (!state.currentFile) return
      // During a chain apply `segments` is the chain's running result, which is
      // no revision of the document: always measured, under a key no real
      // revision matches.
      const own = segments === state.segments
      const key = own ? `${appState.activeDocumentId}:${state.revision}` : `${appState.activeDocumentId}:chain`
      if (own && levelMeasuredFor === key) return
      const end = totalDuration.value
      if (!(end > 0)) return
      const gated = ALIGN_TARGET_DBFS - regionAlignDb(
        segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
      )
      levelMeasuredFor = key
      plParams.voiceLevelDb = gated
      pushParam('voiceLevelDb', gated)
    }

    function togglePreview() {
      const chain = initChain()
      plPreview.value = !plPreview.value
      chain.setEnabled(plosiveEffect.id, plPreview.value)
      if (plPreview.value) {
        refreshLevel()
        for (const [name, value] of Object.entries(plParams)) {
          chain.updateParam(plosiveEffect.id, name, value)
        }
        nodesOf(chain)?.setListen(plDelta.value ? 'delta' : 'off')
        startMeters(chain)
      } else {
        // Bypassed, there is nothing to hear in the delta.
        plDelta.value = false
        stopMeters()
      }
    }

    /** Set one user-facing param. */
    function syncParam(name, value) {
      if (!(name in plParams) || MEASURED.has(name)) return
      plParams[name] = value
      pushParam(name, value)
    }

    /** A preset's controls, through the same path a knob turn takes. */
    function applyParams(p) {
      for (const [k, v] of Object.entries(p)) {
        if (v !== undefined && plParams[k] !== v) syncParam(k, v)
      }
    }

    function toggleDelta() {
      if (!plPreview.value) return
      plDelta.value = !plDelta.value
      liveNodes()?.setListen(plDelta.value ? 'delta' : 'off')
    }

    /** The scope's ring, or null while the effect is not in the chain. */
    function getScope() {
      return liveNodes()?.getScope() ?? null
    }

    function holdScope(on) {
      liveNodes()?.holdScope(on)
    }

    function clearScope() {
      liveNodes()?.clearScope()
    }

    /** Zero the POP / BURST event counters on the panel. */
    function resetCounts() {
      liveNodes()?.resetCounts()
      plPops.value = 0
      plBursts.value = 0
    }

    /** What apply re-measures first, so it renders with exact rather than live values. */
    async function prepareApply(segments = state.segments) {
      refreshLevel(segments)
    }

    /** Render [start, end) of `segments` with the current settings, uncommitted. */
    function renderRegion(segments, start, end) {
      return applyPlosiveRegion(
        segments, start, end,
        { ...plParams },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
    }

    async function apply() {
      if (!state.selection) return
      const { start, end } = state.selection

      const wasPreviewing = plPreview.value
      if (wasPreviewing) togglePreview()
      await prepareApply()

      startProcessing('Applying Plosive Tamer...')
      try {
        const buffer = await renderRegion(state.segments, start, end)
        const bufferId = replaceRegion(start, end, buffer, 'Plosive Tamer')
        const cache = await computePeakCache(buffer, 256)
        setPeakCache(bufferId, cache)
        showToast('Plosive Tamer applied')
      } catch (err) {
        console.error('Plosive Tamer failed:', err)
        showToast('Plosive Tamer failed')
      } finally {
        endProcessing()
      }
    }

    function teardown() {
      stopMeters()
      // Delta is a monitoring aid; never leave the chain auditioning it after
      // the window closes.
      plDelta.value = false
      const chain = getEffectChainIfExists()
      if (chain) nodesOf(chain)?.setListen('off')
    }

    registerChainPlugin({
      id: plosiveEffect.id,
      windowId,
      label: 'Plosive Tamer',
      dispose: life.dispose,
      isActive: () => plPreview.value,
      setActive: (on) => { if (plPreview.value !== on) togglePreview() },
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

    return {
      plParams,
      plPreview,
      plDelta,
      plPopCut,
      plBurstCut,
      plPops,
      plBursts,
      plInputLevels,
      plOutputLevels,
      togglePreview,
      syncParam,
      applyParams,
      toggleDelta,
      getScope,
      holdScope,
      clearScope,
      resetCounts,
      apply,
      teardown,
      openModal,
      closeModal,
    }
  }

  return usePlosive
})

/** The copy the calling window edits (the solo copy outside a plugin window). */
export function usePlosive() {
  return copies()()
}
