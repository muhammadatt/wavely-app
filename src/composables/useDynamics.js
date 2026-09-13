import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  computeDynamicsSolve, applyDynamicsRegion, computePeakCache,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { dynamicsEffect, DYNAMICS_DEFAULTS } from '../audio/effects/dynamics.js'
import { VOICINGS, CLIP_MAX_DEPTH_DB } from '../audio/dynamicsSolve.js'
import { regionCovers } from '../audio/dsp/clipGainDecision.js'
import { analysisWindow } from '../audio/analysisWindow.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const DYNAMICS_WINDOW_ID = 'vocal-chain-dynamics'

export { VOICINGS, CLIP_MAX_DEPTH_DB }

/**
 * ⚠ THERE IS AN EXPLICIT SOLVE STEP, AND IT IS NOT A UI PREFERENCE. Every
 * bisect pass renders the analysis window through a compressor kernel —
 * measured at 7.3 s for sixteen seconds of audio, roughly twenty-five renders.
 * Re-running that on a knob drag is not available, so the macro moves and the
 * panel says the solve is stale until it is re-run.
 *
 * ⚠ WHICH MEANS DENSITY AND VOICING INVALIDATE THE SOLUTION AND MIX DOES NOT.
 * That split is real rather than a convenience: Density and Voicing change what
 * the devices are asked to do, so every measured value moves with them. Mix is
 * applied AFTER the blend law, and the solve deliberately measures that law at
 * Mix 1 — the worst case — precisely so the knob stays valid wherever it lands.
 * Output trim is downstream of everything and never invalidates anything.
 */
const panel = ref({ ...DYNAMICS_DEFAULTS })

const solution = ref(null)
/** `docId:revision` the solution was measured on, plus the region it saw. */
const solvedFor = ref(null)
const solvedRegion = ref(null)
const solving = ref(false)

const preview = ref(false)
const metering = ref(null)
const inputLevels = ref([])
const outputLevels = ref([])
let meterId = null

export function useDynamics() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function timelineKey() {
    return state.currentFile ? `${appState.activeDocumentId}:${state.revision}` : null
  }

  /**
   * Two ways to go stale, and they are different failures. The audio changed —
   * an edit, or another file — so the measurements describe samples that have
   * moved. Or the selection has left the window the solve measured, where
   * nothing was measured at all. Narrowing INSIDE that window is neither.
   */
  const isStale = computed(() => {
    if (solution.value === null) return false
    if (solvedFor.value !== timelineKey()) return true
    return !regionCovers(solvedRegion.value, state.selection)
  })
  const hasSolution = computed(() => solution.value !== null)
  const solutionValid = computed(() => hasSolution.value && !isStale.value)

  const voicing = computed(() => VOICINGS[panel.value.voicing] ?? VOICINGS.audiobook)
  /** The blend actually in force: the user's if they set one, else the voicing's. */
  const effectiveMix = computed(() => panel.value.mix ?? voicing.value.mix)
  const mixIsAuto = computed(() => panel.value.mix === null)

  /** What the solve decided, for the panel to show rather than imply. */
  const summary = computed(() => {
    const r = solution.value?.report
    if (!r) return null
    return {
      clipDepthDb: r.clip.depthDb,
      clipCapped: r.clip.capped,
      fetPeakDb: r.fet.peakDb,
      optoPeakDb: r.opto.peakDb,
      squash: r.opto.squash,
      spreadFrom: r.input.spreadDb,
      spreadTo: r.afterWet.spreadDb,
      impactFrom: r.input.impactDb,
      impactTo: r.afterFet.impactDb,
      /**
       * ⚠ SURFACED, NOT HIDDEN. The opto raises peak-to-body by design — it
       * rides the body and lets onsets through — so at high Density this
       * section can hand the chain MORE peak than it received. That is a real
       * trade, evenness bought with headroom, and the limiter downstream is
       * where it is paid for.
       */
      crestRoseBy: r.crestRoseBy,
    }
  })

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === dynamicsEffect.id)) {
      chain.addEffect(dynamicsEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === dynamicsEffect.id)?.nodes
      if (nodes) {
        const chCount = state.currentFile?.channels ?? 1
        inputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        outputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
        metering.value = nodes.getMetering()
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
    metering.value = null
  }

  function push() {
    if (!preview.value) return
    const chain = getEffectChain(getAudioContext())
    // The solve's output is one object, deliberately not merged into panel
    // state — see `setParam('solution')` in effects/dynamics.js.
    chain.updateParam(dynamicsEffect.id, 'solution',
      solutionValid.value ? solution.value.params : null)
    for (const [name, value] of Object.entries(panel.value)) {
      chain.updateParam(dynamicsEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    preview.value = !preview.value
    chain.setEnabled(dynamicsEffect.id, preview.value)
    if (preview.value) {
      push()
      startMeters(chain)
    } else {
      stopMeters()
    }
  }

  /** Density and Voicing invalidate the solve; Mix and Output do not. */
  function syncMacro(name, value) {
    panel.value = { ...panel.value, [name]: value }
    solution.value = null
    solvedFor.value = null
    solvedRegion.value = null
    push()
  }

  function syncBlend(name, value) {
    panel.value = { ...panel.value, [name]: value }
    push()
  }

  /** Hand Mix back to the voicing's own value. */
  function resetMixAuto() {
    panel.value = { ...panel.value, mix: null }
    push()
  }

  /**
   * Measure the region and solve the section's device settings.
   *
   * ⚠ THE WINDOW IS CAPPED AND THE PANEL REMEMBERS WHICH ONE. `computeDynamicsSolve`
   * goes through the capped analysis window, so the solve saw a bounded, centred
   * slice of the selection — and the staleness check above compares against THAT,
   * not against the selection, or moving the playhead outside the measured slice
   * would silently keep applying numbers measured somewhere else.
   */
  async function solve() {
    if (!state.currentFile) return
    const start = state.selection ? state.selection.start : 0
    const end = state.selection ? state.selection.end : totalDuration.value
    if (!(end > start)) return

    solving.value = true
    try {
      const result = await computeDynamicsSolve(
        state.segments, start, end,
        { density: panel.value.density, voicing: panel.value.voicing },
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      solution.value = result
      solvedFor.value = timelineKey()
      solvedRegion.value = analysisWindow(start, end)
      push()
    } catch (err) {
      console.error('Dynamics solve failed:', err)
      showToast('Dynamics solve failed')
    } finally {
      solving.value = false
    }
  }

  function clearSolution() {
    solution.value = null
    solvedFor.value = null
    solvedRegion.value = null
    push()
  }

  async function apply() {
    if (!state.selection || !solutionValid.value) return
    const { start, end } = state.selection

    const wasPreviewing = preview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying vocal chain dynamics...')
    try {
      const buffer = await applyDynamicsRegion(
        state.segments, start, end, panel.value, solution.value.params,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'Vocal chain dynamics')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast('Dynamics applied')
    } catch (err) {
      console.error('Dynamics apply failed:', err)
      showToast('Dynamics apply failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    if (preview.value) togglePreview()
  }

  function openModal() {
    openWindow(DYNAMICS_WINDOW_ID)
  }

  function closeModal() {
    closeWindow(DYNAMICS_WINDOW_ID)
  }

  return {
    panel,
    solution,
    solving,
    preview,
    metering,
    inputLevels,
    outputLevels,
    isStale,
    hasSolution,
    solutionValid,
    summary,
    voicing,
    effectiveMix,
    mixIsAuto,
    hasSelection,
    solve,
    clearSolution,
    syncMacro,
    syncBlend,
    resetMixAuto,
    togglePreview,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
