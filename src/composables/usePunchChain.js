import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import {
  applyPunchChainRegion, computePunchChainPlan, computePeakCache,
} from '../audio/processing.js'
import { regionAlignDb } from '../audio/analysisWindow.js'
import { getEffectChain } from '../audio/effectChain.js'
import { punchChainEffect, PUNCH_CHAIN_DEFAULTS } from '../audio/effects/punchChain.js'
import { embeddedTuning } from '../audio/effects/punchChainParams.js'
import { onLA2ATuningChange } from '../audio/effects/la2aTuning.js'
import { onFET1176TuningChange } from '../audio/effects/fet1176Tuning.js'
import { snapshotLevels } from '../audio/effects/levelTap.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const PUNCH_CHAIN_WINDOW_ID = 'punch-chain'

// Singleton reactive state shared between the sidebar trigger and the modal.
const punchDrive = ref(PUNCH_CHAIN_DEFAULTS.drive)
const punchPeakReduction = ref(PUNCH_CHAIN_DEFAULTS.peakReduction)
const punchOutput = ref(PUNCH_CHAIN_DEFAULTS.output)

/**
 * AUTO owns the makeup, the ceiling and both alignments — the plugin's four
 * measured values, all from one pass.
 *
 * On by default for the reason every other measured makeup here is: without it
 * pushing either dial mostly makes things louder, and every A/B the user runs
 * is decided by loudness rather than by what the dial did. That matters more on
 * this plate than anywhere else in the app, because the two readouts BESIDE the
 * dials are the whole point of it — an unmatched level would move density's
 * reference and make both numbers lie.
 */
const punchAuto = ref(true)
const punchAutoBusy = ref(false)
const punchMakeupDb = ref(PUNCH_CHAIN_DEFAULTS.makeupDb)
const punchCeilingDb = ref(PUNCH_CHAIN_DEFAULTS.ceilingDb)
const punchCeilingKneeDb = ref(PUNCH_CHAIN_DEFAULTS.ceilingKneeDb)
const punchFetAlignDb = ref(PUNCH_CHAIN_DEFAULTS.fetAlignDb)
const punchOptoAlignDb = ref(PUNCH_CHAIN_DEFAULTS.optoAlignDb)

/**
 * The two numbers the plate prints, plus the source's own for comparison.
 *
 * ⚠ BOTH, NOT JUST DENSITY, AND THE SECOND ONE IS NOT DECORATION. Measured on
 * narration at FET drive 25, taking the Opto from PR 40 to 75 reads as
 * -11.43 -> -12.09 density, which looks like pure loss, while level spread goes
 * 5.23 -> 2.88, which is the entire reason to go there. Density alone makes the
 * Opto's job look like a mistake. See dsp/densityMetrics.js.
 */
const punchDensityDb = ref(NaN)
const punchSpreadDb = ref(NaN)
const punchSourceDensityDb = ref(NaN)
const punchSourceSpreadDb = ref(NaN)

/**
 * Why the readouts are what they are: 'idle' | 'measuring' | 'ready' |
 * 'no-selection' | 'failed'.
 *
 * ⚠ THIS EXISTS BECAUSE "—" IS A REPORT WITH NO INFORMATION IN IT. Three
 * different situations printed exactly the same dash — nothing has measured
 * yet, there is no selection to measure, and the pass threw — and the only one
 * of them the user can act on is the middle one. A panel that cannot measure
 * should say so on its face rather than leave someone comparing dashes.
 */
const punchPlanState = ref('idle')

/**
 * Which timeline the alignments were measured from — `docId:revision`.
 *
 * ⚠ A NULL CHECK CANNOT ANSWER "IS THIS STILL THE RIGHT FILE". This state is a
 * module singleton that outlives the document under it, and `setActiveDocument`
 * does not touch plugin state — Scheps shipped exactly that bug, measuring the
 * first file the panel ever saw and never again.
 */
let alignedFor = null

const punchPreview = ref(false)
const punchReduction = ref(0)
const punchFetReduction = ref(0)
const punchOptoReduction = ref(0)
const punchInputLevels = ref([])
const punchOutputLevels = ref([])
let meterId = null

/**
 * Debounce + supersede state for the measurement pass, shared across every
 * usePunchChain() caller so knob drags coalesce into one measurement.
 *
 * ⚠ TRAILING EDGE ONLY, WHERE EVERY OTHER PLUGIN HERE ALSO MEASURES ON THE
 * LEADING ONE. Theirs is a cheap pass, so measuring the first move of a burst
 * costs nothing and makes a single click feel instant. This pass is the
 * heaviest in the app, and a leading edge made it feel far slower than it is:
 * it measures the knob position the drag STARTED at, so a stale pair of numbers
 * lands most of a second in, sits there while the trailing pass runs, and is
 * then replaced. Two passes per drag, and the first one's answer was wrong
 * before it was computed.
 *
 * The cost of dropping it is that a single nudge now waits out the window
 * before the readouts move, which at 160 ms is not perceptible next to the
 * measurement itself.
 */
const PLAN_DEBOUNCE_MS = 160
let planTimer = null
let planSeq = 0

/**
 * Re-measure when either bench tuning moves.
 *
 * ⚠ SUBSCRIBED AT MODULE SCOPE, NOT FROM THE PANEL, for the reason
 * `punchChain.js` gives about its own pair: the panels that own these tunings
 * are OptoSmooth's and FET Punch's, and neither should have to know this plugin
 * exists. The effect wrapper's subscription re-pushes params at the LIVE node;
 * this one re-runs the MEASUREMENT, which is a different thing — without it the
 * node would play the new tuning while the plate kept the old tuning's numbers.
 *
 * Costs nothing when the panel is shut: `refreshPlan` returns early without a
 * selection, and the bench panels are developer tools that move rarely.
 */
let rePlanOnTuningChange = () => {}
onLA2ATuningChange(() => rePlanOnTuningChange())
onFET1176TuningChange(() => rePlanOnTuningChange())

function currentParams() {
  return {
    drive: punchDrive.value,
    peakReduction: punchPeakReduction.value,
    output: punchOutput.value,
    /**
     * ⚠ ONLY WHILE AUTO OWNS THEM. With AUTO off the level is the user's and
     * there is no measured ceiling behind it; enforcing a stale one would
     * attenuate a setting they made deliberately. Same rule `useLA2A` and
     * `useScheps` follow.
     */
    makeupDb: punchAuto.value ? punchMakeupDb.value : 0,
    ceilingDb: punchAuto.value ? punchCeilingDb.value : null,
    ceilingKneeDb: punchAuto.value ? punchCeilingKneeDb.value : null,
    /**
     * ⚠ INDEPENDENT OF AUTO, unlike the ceiling, and BOTH of them are. The
     * ceiling is half of the makeup solve and leaves with it; the alignments
     * decide how much either stage compresses at all — and the Opto's decides
     * whether its dial means the same thing at every position of the FET's.
     * Turning AUTO off is not a reason to hand back a plugin whose second knob
     * drifts with its first.
     */
    fetAlignDb: punchFetAlignDb.value,
    optoAlignDb: punchOptoAlignDb.value,
  }
}

/**
 * Params for the measurement pass — the makeup is what we're solving for.
 *
 * ⚠ THE BENCH TUNINGS BELONG HERE, AND LEAVING THEM OUT WAS A REAL DRIFT. The
 * plan builds fresh kernels from `PUNCH_CHAIN_KERNEL_DEFAULTS` plus what it is
 * handed, so without these it solved the makeup, the ceiling knee, the opto's
 * alignment and BOTH readouts against the shipping kernels while preview and
 * apply ran the tuned ones. After a re-fit the level and the numbers on the
 * plate would both be wrong, with nothing saying so — the same shape as the
 * Scheps-didn't-follow-the-bench defect, one layer down.
 *
 * Folded in from the same `embeddedTuning` the live path and the apply path
 * use, so the three cannot disagree.
 */
function measurementParams() {
  return {
    drive: punchDrive.value,
    peakReduction: punchPeakReduction.value,
    // The whole-file offset, so the plan anchors the Opto's to it rather than
    // to its own capped window. See `computePunchChainPlan`.
    fetAlignDb: punchFetAlignDb.value,
    ...embeddedTuning(),
  }
}

export function usePunchChain() {
  const {
    state, appState, getAudioContext, hasSelection, replaceRegion, setPeakCache,
    startProcessing, endProcessing, showToast, totalDuration,
  } = useEditorState()
  const { openWindow, closeWindow } = useWindows()

  function initChain() {
    const ctx = getAudioContext()
    const chain = getEffectChain(ctx)
    if (!chain.effects.find(e => e.id === punchChainEffect.id)) {
      chain.addEffect(punchChainEffect)
    }
    return chain
  }

  function startMeters(chain) {
    stopMeters()
    function tick() {
      const nodes = chain.effects.find(e => e.id === punchChainEffect.id)?.nodes
      if (nodes) {
        punchReduction.value = nodes.getReduction()
        const { fetDb, optoDb } = nodes.getStageReduction()
        punchFetReduction.value = fetDb
        punchOptoReduction.value = optoDb
        // Only meter channels the source really has: the splitter is discrete,
        // so asking for stereo on a mono file adds a dead bar.
        const chCount = state.currentFile?.channels ?? 1
        punchInputLevels.value = snapshotLevels(nodes.getInputLevels(chCount))
        punchOutputLevels.value = snapshotLevels(nodes.getOutputLevels(chCount))
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
    punchReduction.value = 0
    punchFetReduction.value = 0
    punchOptoReduction.value = 0
    punchInputLevels.value = []
    punchOutputLevels.value = []
  }

  function pushAllParams(chain) {
    for (const [name, value] of Object.entries(currentParams())) {
      chain.updateParam(punchChainEffect.id, name, value)
    }
  }

  function togglePreview() {
    const chain = initChain()
    punchPreview.value = !punchPreview.value
    chain.setEnabled(punchChainEffect.id, punchPreview.value)

    if (punchPreview.value) {
      // Before pushAllParams, which pushes `currentParams()` — otherwise
      // preview starts on a stale or unmeasured offset.
      refreshInputAlign()
      pushAllParams(chain)
      startMeters(chain)
      refreshPlan()
    } else {
      stopMeters()
    }
  }

  function pushParam(name, value) {
    if (!punchPreview.value) return
    const chain = getEffectChain(getAudioContext())
    chain.updateParam(punchChainEffect.id, name, value)
  }

  /**
   * Measure the file's alignment offset for the FET and push it.
   *
   * ⚠ THE WHOLE FILE, IGNORING THE SELECTION — see `regionAlignDb`. This plugin
   * applies to a selection, so this is the one measurement here deliberately
   * NOT scoped to it: a per-selection offset would make the chain a different
   * compressor on every selection, and two applies over overlapping ranges
   * would not agree.
   *
   * ⚠ AND BEFORE THE PLAN, WHICH CONSUMES IT — the plan anchors the OPTO's
   * offset to this one, so a stale value here moves both stages.
   */
  function refreshInputAlign() {
    if (!state.currentFile) return
    const key = `${appState.activeDocumentId}:${state.revision}`
    if (alignedFor === key) return // already measured for this exact timeline
    const end = totalDuration.value
    if (!(end > 0)) return
    const db = regionAlignDb(
      state.segments, 0, end, state.currentFile.sampleRate, state.currentFile.channels,
    )
    alignedFor = key
    punchFetAlignDb.value = db
    pushParam('fetAlignDb', db)
  }

  /**
   * Re-measure everything for the current selection and settings. Superseded
   * calls are discarded by sequence number so a fast knob drag can't have an
   * older measurement land after a newer one.
   */
  async function refreshPlan() {
    /**
     * ⚠ BEFORE THE GUARDS, NOT AFTER. Alignment is not part of the makeup solve
     * — it decides how hard either stage works at all — so gating it behind
     * AUTO or behind a selection would leave the live chain on a stale offset
     * in both cases. Cheap and idempotent: keyed on the timeline.
     */
    refreshInputAlign()
    if (!state.selection || !state.currentFile) {
      /**
       * ⚠ THE READOUTS ARE CLEARED RATHER THAN LEFT STANDING. They describe a
       * region, and without one they describe nothing — holding the last
       * region's numbers beside two live dials would be worse than a dash,
       * because they would look current.
       */
      punchPlanState.value = 'no-selection'
      punchDensityDb.value = NaN
      punchSpreadDb.value = NaN
      punchSourceDensityDb.value = NaN
      punchSourceSpreadDb.value = NaN
      return
    }

    const { start, end } = state.selection
    const seq = ++planSeq
    punchAutoBusy.value = true
    punchPlanState.value = 'measuring'
    try {
      const plan = await computePunchChainPlan(
        state.segments, start, end,
        measurementParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== planSeq) return // a newer measurement is already in flight

      /**
       * ⚠ THE OPTO'S ALIGNMENT LANDS WHETHER OR NOT AUTO IS ON, and first,
       * because it is not part of the makeup — it is what makes the second dial
       * mean the same thing at every position of the first. Withholding it with
       * AUTO would give the user back the interaction this plate exists to
       * remove, silently.
       */
      punchOptoAlignDb.value = plan.optoAlignDb
      pushParam('optoAlignDb', plan.optoAlignDb)

      // The readouts are measurements of the render, not of the solve, so they
      // are true regardless of AUTO.
      punchSourceDensityDb.value = plan.sourceDensityDb
      punchSourceSpreadDb.value = plan.sourceSpreadDb
      punchDensityDb.value = plan.densityDb
      punchSpreadDb.value = plan.spreadDb
      punchPlanState.value = 'ready'

      if (!punchAuto.value) return

      /**
       * ⚠ THE CEILING GOES BEFORE THE MAKEUP, AND THE ORDER IS THE GUARANTEE.
       * These reach the live node as separate param messages, so between them
       * it holds one old value and one new one; makeup first would run the
       * raised signal against the old ceiling, or against none.
       */
      punchCeilingDb.value = plan.ceilingDb
      pushParam('ceilingDb', plan.ceilingDb)
      // With the ceiling, ahead of the makeup: the knee is how hard it holds.
      punchCeilingKneeDb.value = plan.ceilingKneeDb
      pushParam('ceilingKneeDb', plan.ceilingKneeDb)
      punchMakeupDb.value = plan.makeupDb
      pushParam('makeupDb', plan.makeupDb)
    } catch (err) {
      console.error('Punch Chain measurement failed:', err)
      if (seq === planSeq) punchPlanState.value = 'failed'
    } finally {
      if (seq === planSeq) punchAutoBusy.value = false
    }
  }

  rePlanOnTuningChange = schedulePlan

  function schedulePlan() {
    if (planTimer !== null) clearTimeout(planTimer)
    planTimer = setTimeout(() => {
      planTimer = null
      refreshPlan()
    }, PLAN_DEBOUNCE_MS)
  }

  /**
   * ⚠ BOTH DIALS RE-MEASURE, AND THE DRIVE DIAL HAS TO. It moves the level the
   * Opto is fed, so it moves the Opto's alignment — which is the one thing
   * keeping the second dial honest. Output does not re-measure: it is a
   * deliberate deviation applied after everything.
   */
  function syncDrive(v) {
    punchDrive.value = v
    pushParam('drive', v)
    schedulePlan()
  }

  function syncPeakReduction(v) {
    punchPeakReduction.value = v
    pushParam('peakReduction', v)
    schedulePlan()
  }

  function syncOutput(v) {
    punchOutput.value = v
    pushParam('output', v)
  }

  function toggleAuto() {
    punchAuto.value = !punchAuto.value
    if (punchAuto.value) {
      refreshPlan()
      return
    }

    // Off means no makeup and no ceiling. Leaving the last measured pair in
    // place would be worse than either: the readout would claim a match that
    // stops being true the moment anything changes.
    if (planTimer !== null) {
      clearTimeout(planTimer)
      planTimer = null
    }
    planSeq++ // discard any in-flight measurement
    punchAutoBusy.value = false
    punchMakeupDb.value = 0
    pushParam('makeupDb', 0)
    /**
     * ⚠ THE CEILING LEAVES WITH AUTO TOO. `currentParams()` already drops it,
     * but the LIVE node has been told about it and would keep enforcing a
     * measured ceiling against a level the user now owns — a manual setting
     * silently held down, with nothing on the panel saying so.
     */
    punchCeilingDb.value = null
    pushParam('ceilingDb', null)
    punchCeilingKneeDb.value = null
    pushParam('ceilingKneeDb', null)
  }

  async function apply() {
    if (!state.selection) return
    const { start, end } = state.selection

    /**
     * ⚠ RE-MEASURED HERE EVEN THOUGH THE MAKEUP IS NOT. The makeup is held in
     * state from the preview the user actually heard, deliberately; the
     * alignment is a property of the FILE, and the file can have been edited
     * since the panel was opened. Applying against a stale offset would render
     * a different chain from the one auditioned.
     */
    refreshInputAlign()

    const wasPreviewing = punchPreview.value
    if (wasPreviewing) togglePreview()

    startProcessing('Applying Punch Chain...')
    try {
      /**
       * ⚠ THE TRIM IS REPORTED RATHER THAN APPLIED SILENTLY, the same contract
       * FET Punch has. The makeup is level-matched on the percentile, which
       * deliberately leaves the peak under the source; `applyPunchChainRegion`
       * puts it back on the ceiling and hands back what it added. Saying so is
       * the difference between a number the user can check and gain that
       * appeared from nowhere. See `peakRestoreTrimDb`.
       */
      const { buffer, trimDb } = await applyPunchChainRegion(
        state.segments, start, end,
        currentParams(),
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      const bufferId = replaceRegion(start, end, buffer, 'Punch Chain')
      const cache = await computePeakCache(buffer, 256)
      setPeakCache(bufferId, cache)
      showToast(Math.abs(trimDb) >= 0.05
        ? `Punch Chain applied — peak restored ${trimDb >= 0 ? '+' : ''}${trimDb.toFixed(2)} dB`
        : 'Punch Chain applied')
    } catch (err) {
      console.error('Punch Chain failed:', err)
      showToast('Punch Chain failed')
    } finally {
      endProcessing()
    }
  }

  function teardown() {
    stopMeters()
    if (punchPreview.value) {
      const chain = getEffectChain(getAudioContext())
      chain.setEnabled(punchChainEffect.id, false)
      punchPreview.value = false
    }
  }

  function openModal() {
    openWindow(PUNCH_CHAIN_WINDOW_ID)
    // The file may have changed, or been edited, since the last measurement.
    refreshInputAlign()
  }

  function closeModal() {
    closeWindow(PUNCH_CHAIN_WINDOW_ID)
  }

  return {
    punchDrive,
    punchPeakReduction,
    punchOutput,
    punchAuto,
    punchAutoBusy,
    punchMakeupDb,
    punchFetAlignDb,
    punchOptoAlignDb,
    punchDensityDb,
    punchSpreadDb,
    punchSourceDensityDb,
    punchSourceSpreadDb,
    punchPlanState,
    punchPreview,
    punchReduction,
    punchFetReduction,
    punchOptoReduction,
    punchInputLevels,
    punchOutputLevels,
    hasSelection,
    togglePreview,
    syncDrive,
    syncPeakReduction,
    syncOutput,
    toggleAuto,
    refreshPlan,
    schedulePlan,
    apply,
    teardown,
    openModal,
    closeModal,
  }
}
