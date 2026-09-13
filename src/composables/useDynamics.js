import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  computeDynamicsSweep, applyDynamicsRegion, computePeakCache,
} from '../audio/processing.js'
import { getEffectChain } from '../audio/effectChain.js'
import { dynamicsEffect, DYNAMICS_DEFAULTS } from '../audio/effects/dynamics.js'
import { VOICINGS, CLIP_MAX_DEPTH_DB, solveFromSweep } from '../audio/dynamicsSolve.js'
import { regionCovers } from '../audio/dsp/clipGainDecision.js'
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

/** The sampled curves. Everything else on this panel is a lookup on them. */
const sweep = ref(null)
const solution = ref(null)
/** `docId:revision` the solution was measured on. */
const solvedFor = ref(null)
/**
 * The SELECTION the solve was asked about — not the capped window it measured.
 *
 * ⚠ THE DIFFERENCE BETWEEN THOSE TWO SHIPPED AS A BUG THAT DISABLED APPLY ON
 * EVERY REAL SELECTION. This held `analysisWindow(start, end)`, which truncates
 * to AUTO_MAKEUP_MAX_ANALYSIS_S (30 s) from the region's start, and `isStale`
 * asked whether that window covered the selection. For any selection longer than
 * 30 s it cannot — by construction, because the window IS a 30 s slice of it — so
 * the solve reported itself stale the instant it finished, `solutionValid` never
 * became true, and the Apply button stayed disabled no matter how many times it
 * was re-run. A narrator's selection is a chapter; almost nothing real is under
 * 30 s.
 *
 * The window is deliberately a slice: what the solve produces is a set of KNOB
 * POSITIONS, and `analysisWindow`'s own note is that a representative excerpt
 * answers that as well as ten minutes would. So "does this solve still apply?"
 * is a question about the selection it was run on, never about the excerpt it
 * happened to render. `useDeEsser` compares against its analysed region and is
 * correct because that region IS the whole selection — its analysis is uncapped.
 */
const solvedSelection = ref(null)
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
    if (sweep.value === null) return false
    if (solvedFor.value !== timelineKey()) return true
    return !regionCovers(solvedSelection.value, state.selection)
  })
  const hasSolution = computed(() => sweep.value !== null && solution.value !== null)
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

  /**
   * Density and Voicing — LIVE, because they are lookups on the sampled curves.
   *
   * ⚠ THEY USED TO THROW THE MEASUREMENT AWAY. Each move cleared the solution
   * and made the user re-run a 7.3-7.9 s bisect, which is not a knob. The sweep
   * samples both curves once, so re-deriving the knob positions for a new
   * Density costs no renders — see `solveFromSweep`.
   */
  function syncMacro(name, value) {
    panel.value = { ...panel.value, [name]: value }
    if (sweep.value) solution.value = solveFromSweep(sweep.value, macroOptions())
    push()
  }

  /**
   * The sweep lookup's inputs. Mix is left out: it is applied after the law.
   *
   * ⚠ BALANCE IS A PANEL PERCENT AND THE SOLVE TAKES A FRACTION. The knob reads
   * −100…+100 so it can say "OPTO 60" rather than "0.6"; `effectiveVoicing`
   * clamps to ±1, so a stray percent would silently pin instead of throwing.
   */
  function macroOptions() {
    return {
      density: panel.value.density,
      voicing: panel.value.voicing,
      balance: (panel.value.balance ?? 0) / 100,
    }
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
   * Sample the region's curves. Every knob on this panel is a lookup after it.
   *
   * ⚠ THE WINDOW IS CAPPED AND WHAT IS REMEMBERED IS THE SELECTION, NOT THE
   * WINDOW. `computeDynamicsSweep` renders through `analysisWindow`, so it sees
   * a bounded slice anchored at the region's start — but what it produces is a
   * set of knob curves for the whole selection, so that selection is what the
   * staleness check has to compare against. Recording the window instead made
   * every solve on a selection over 30 s instantly stale; see
   * `solvedSelection`.
   *
   * ⚠ THE MACRO IS READ AT LOOKUP TIME, NOT AT SAMPLE TIME. The curves do not
   * depend on Density or Voicing — those only pick targets on them — so moving
   * either while this is in flight is not a race, and the result is valid for
   * whatever the knobs say when it lands.
   */
  async function solve() {
    if (!state.currentFile) return
    const start = state.selection ? state.selection.start : 0
    const end = state.selection ? state.selection.end : totalDuration.value
    if (!(end > start)) return

    solving.value = true
    try {
      const curves = await computeDynamicsSweep(
        state.segments, start, end, {},
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      sweep.value = curves
      solution.value = solveFromSweep(curves, macroOptions())
      solvedFor.value = timelineKey()
      solvedSelection.value = { start, end }
      push()
    } catch (err) {
      console.error('Dynamics solve failed:', err)
      showToast('Dynamics solve failed')
    } finally {
      solving.value = false
    }
  }

  function clearSolution() {
    sweep.value = null
    solution.value = null
    solvedFor.value = null
    solvedSelection.value = null
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
