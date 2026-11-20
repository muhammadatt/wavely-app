import { computed, onScopeDispose, ref, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyToRegion } from './regionApply.js'
import { pendingWindowSettings, takeWindowSettings } from './windowHandoff.js'
import { loudnessNormalizeRegion, measureRegionLoudness } from '../audio/processing.js'
import {
  TARGET_GROUPS, DEFAULT_TARGET_ID, matchingTargets, targetById, targetsInGroup,
} from '../audio/loudnessTargets.js'
import { planNormalization } from '../audio/dsp/loudnessNormalize.js'

/** `+1.2` / `-3.0` / `—`. */
export const formatSignedDb = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—')
/** `1.2` / `—`. */
export const formatDb = v => (Number.isFinite(v) ? v.toFixed(1) : '—')

export const LOUDNESS_INITIAL_TARGET = targetById(DEFAULT_TARGET_ID)

/**
 * THE SETTINGS OUTLIVE THE WINDOW (November 2026): they are kept per file
 * (perFilePluginSettings.js), and a file is entered with its window open or
 * shut. Reopening the window therefore shows the active file's settings — the
 * last ones it was given, or inherited from the file used before it — rather
 * than the defaults. The measurement and its watchers keep the window's
 * lifetime.
 */
const targetDb = ref(LOUDNESS_INITIAL_TARGET.targetDb)
const unit = ref(LOUDNESS_INITIAL_TARGET.unit)
const ceilingDb = ref(LOUDNESS_INITIAL_TARGET.ceilingDb)
const peakMode = ref('limit')
/** The benchmark last clicked: which note to print when several are lit (see `noteTarget`). */
const chosenId = ref(DEFAULT_TARGET_ID)

const PEAK_MODES = ['limit', 'safe']
const UNITS = ['LUFS', 'RMS']

/** Loudness Normalize's settings, for per-file save and restore. */
export const loudnessSettingsIO = {
  read: () => ({
    targetDb: targetDb.value, unit: unit.value, ceilingDb: ceilingDb.value,
    peakMode: peakMode.value, chosenId: chosenId.value,
  }),
  write: (p) => {
    if (Number.isFinite(p?.targetDb)) targetDb.value = p.targetDb
    if (UNITS.includes(p?.unit)) unit.value = p.unit
    if (Number.isFinite(p?.ceilingDb)) ceilingDb.value = p.ceilingDb
    if (PEAK_MODES.includes(p?.peakMode)) peakMode.value = p.peakMode
    if (typeof p?.chosenId === 'string' && targetById(p.chosenId)) chosenId.value = p.chosenId
  },
}

/**
 * Loudness Normalize: measure the region against a delivery target, then move
 * it there and hold a peak ceiling.
 *
 * ⚠ CALL IT FROM THE WINDOW'S SETUP. Its state, its measurement and the
 * watchers that re-run it live as long as the window that asked for them — as
 * they did when they sat in the panel. Nothing here is live audio, and a
 * measurement re-running on every selection change with the window shut would
 * be pure cost (it is uncapped by design; see `remeasure`).
 */
export function useLoudnessNormalize() {
  const { state, appState, totalDuration, showToast } = useEditorState()

  /** The last measurement of the current region, or null while unknown. */
  const measurement = ref(null)
  const measuring = ref(false)
  /**
   * What the last Apply actually achieved — measured on the render — per file:
   * a report describes the file it was rendered on, so another tab shows its
   * own (or none).
   */
  const reports = ref({})
  const lastReport = computed(() => reports.value[appState.activeDocumentId] ?? null)

  /** The region the window works on: the selection, or the whole file. */
  function region() {
    const start = state.selection ? state.selection.start : 0
    const end = state.selection ? state.selection.end : totalDuration.value
    return { start, end }
  }

  const target = computed(() => ({
    targetDb: targetDb.value,
    unit: unit.value,
    ceilingDb: ceilingDb.value,
  }))

  /**
   * Every benchmark the three settings sit on — a set, because several of these
   * specs are the same three numbers. See `matchingTargets`.
   */
  const activeIds = computed(() => new Set(
    matchingTargets(targetDb.value, unit.value, ceilingDb.value).map(t => t.id)))

  /*
   * Which benchmark's note to print, when more than one is lit (`chosenId`).
   *
   * ⚠ THE CLICK IS REMEMBERED ONLY FOR THIS. It is not a selection — the lit
   * buttons come from the values, and turning the knob off them unlights
   * everything including this one. What it settles is that clicking PODCAST
   * prints the podcast note rather than Apple Music's, even though both are
   * true of -16 LUFS at -1 dBTP.
   */

  const noteTarget = computed(() => {
    const lit = matchingTargets(targetDb.value, unit.value, ceilingDb.value)
    return lit.find(t => t.id === chosenId.value) ?? lit[0] ?? null
  })

  /** The benchmark buttons, by group, each lit when the settings sit on it. */
  const targetButtons = computed(() => TARGET_GROUPS.map(g => ({
    ...g,
    targets: targetsInGroup(g.id).map(t => ({ ...t, active: activeIds.value.has(t.id) })),
  })))

  /**
   * What Apply would do, from the last measurement.
   *
   * ⚠ THIS IS THE SAME FUNCTION THE RENDER USES, not a display-side re-derivation
   * of it. The whole promise of the window is that the number under the knob is
   * the number that comes out, and two implementations of "what gain does this
   * need" would eventually disagree about a ceiling.
   */
  const plan = computed(() => {
    if (!measurement.value) return null
    return planNormalization(measurement.value, target.value, peakMode.value)
  })

  // ── Measurement ───────────────────────────────────────────────────────────

  let measureSeq = 0
  let measureTimer = null
  /** Set while a pass is in the worker, so a second one cannot be started. */
  let measureInFlight = false
  /** Set when a request arrives mid-pass; the pass re-runs once, on completion. */
  let measureAgain = false
  let disposed = false

  /**
   * Measure the region.
   *
   * ⚠ REPLIES ARE MATCHED TO THE REQUEST THAT ASKED FOR THEM. Dragging a
   * selection edge starts a measurement per settle, the long region can take
   * longer than the short one, and without the sequence check an older reply
   * would land last and leave the readout describing a region nobody has
   * selected.
   *
   * ⚠ AND ONLY ONE PASS IS EVER IN FLIGHT, which the sequence check alone does
   * NOT give you: a superseded request still renders its whole region to a flat
   * buffer, transfers it, and runs the full measurement before its reply is
   * thrown away. Unlike the compressors' measurements this one is uncapped by
   * design, so on an hour of stereo that is hundreds of megabytes of allocation
   * and a serialised worker queue per discarded pass — and the worker is shared,
   * so the queue is in front of every other plugin's measurements too. Anything
   * asked for mid-pass collapses into a single re-run at the end instead, which
   * bounds the work at twice the useful amount however hard the selection is
   * dragged. The re-run reads the CURRENT region, so the last answer is still
   * the right one.
   */
  async function remeasure() {
    if (disposed) return
    if (measureInFlight) {
      measureAgain = true
      return
    }
    const { start, end } = region()
    if (!(end > start) || !state.currentFile) {
      measurement.value = null
      return
    }
    const seq = ++measureSeq
    measureInFlight = true
    measuring.value = true
    try {
      const m = await measureRegionLoudness(
        state.segments, start, end,
        state.currentFile.sampleRate, state.currentFile.channels,
      )
      if (seq !== measureSeq) return
      measurement.value = m
    } catch (err) {
      if (seq !== measureSeq) return
      console.error('Loudness measurement failed:', err)
      measurement.value = null
    } finally {
      measureInFlight = false
      if (measureAgain) {
        measureAgain = false
        // Straight back round: the region moved while this pass was running, so
        // what it just measured is not what is selected now.
        remeasure()
      } else if (seq === measureSeq) {
        measuring.value = false
      }
    }
  }

  /** Debounced, because dragging a selection edge is a stream of these. */
  function scheduleMeasure() {
    clearTimeout(measureTimer)
    measureTimer = setTimeout(remeasure, 220)
  }

  remeasure()
  watch(() => state.selection, scheduleMeasure, { deep: true })
  // A render replaces buffers in the region, so the reading it produced is stale
  // the moment anything else edits the file.
  watch(() => state.revision, scheduleMeasure)
  // Another file: its own reading, at once. Neither watch above fires when both
  // files have no selection and the same revision count.
  watch(() => appState.activeDocumentId, () => {
    measurement.value = null
    clearTimeout(measureTimer)
    remeasure()
  })
  onScopeDispose(() => {
    disposed = true
    clearTimeout(measureTimer)
  })

  // ── Setting the target ────────────────────────────────────────────────────

  function selectTarget(id) {
    const t = targetById(id)
    if (!t) return
    chosenId.value = id
    targetDb.value = t.targetDb
    unit.value = t.unit
    ceilingDb.value = t.ceilingDb
  }

  // Settings handed over by a try-out link (useTryOut.js): `target` is a
  // benchmark id. Taken on open, or when they arrive while the window is open.
  watch(() => pendingWindowSettings('loudness'), (s) => {
    if (!s) return
    takeWindowSettings('loudness')
    if (typeof s.target === 'string') selectTarget(s.target)
  }, { immediate: true })

  /**
   * Knob ranges follow the unit, because the two meters do not share a scale.
   *
   * -20 means "the middle of the ACX window" on the RMS meter and "quieter than
   * every broadcast standard" on the LUFS one. One range spanning both would put
   * every value anyone actually uses inside a third of the travel.
   */
  const targetRange = computed(() =>
    unit.value === 'RMS' ? { min: -30, max: -10 } : { min: -32, max: -8 })

  /** The unit a peak is stated in, which follows the target's meter. */
  const peakUnit = computed(() => (unit.value === 'RMS' ? 'dBFS' : 'dBTP'))

  /**
   * The one line that says what will happen, in the terms the user is aiming in.
   *
   * ⚠ IT NAMES THE COST RATHER THAN HIDING IT. Both peak modes give something up
   * when the target and the ceiling disagree, and which one they gave up is the
   * only thing the user needs to decide between them.
   */
  const outcome = computed(() => {
    const p = plan.value
    if (!p || p.silent) return null
    if (!p.ceilingHit) return `${formatSignedDb(p.gainDb)} dB, nothing limited`
    if (peakMode.value === 'safe') {
      return `${formatSignedDb(p.gainDb)} dB — stops ${formatDb(p.shortfallDb)} dB short of target`
    }
    return `${formatSignedDb(p.gainDb)} dB, then peaks limited to ${formatDb(ceilingDb.value)} ${peakUnit.value}`
  })

  /**
   * What the last Apply landed on, or null before one has run.
   *
   * ⚠ EVERY FIGURE HERE COMES FROM THE SNAPSHOT TAKEN AT APPLY TIME, including
   * the units it is labelled with and the target it is judged against. The knobs
   * are live and a render is not instant: reading `unit` or `targetDb` here would
   * let a user who moved to ACX mid-render see the LUFS result they asked for
   * labelled dBFS, and warn or not warn against a target that measurement was
   * never aiming at.
   */
  const achieved = computed(() => {
    const r = lastReport.value
    if (!r) return null
    const miss = Math.abs(r.achievedDb - r.targetDb)
    return {
      text: `Applied: ${formatDb(r.achievedDb)} ${r.unitLabel} at ${formatDb(r.achievedPeakDb)} ${r.peakUnitLabel}`,
      warn: !r.converged || miss > 0.5 || r.shortfallDb > 0.5,
    }
  })

  /** Whether there is anything to apply: a measured region with sound in it. */
  const canApply = computed(() => !!measurement.value && !plan.value?.silent)

  async function apply() {
    // A region with nothing measurable has no target to move to. The Apply
    // button is disabled for it, and this is the second half of that: a
    // keyboard or a race must not reach a no-op that then reports success.
    if (!canApply.value) return false
    const { start, end } = region()
    // The settings are taken now: the knobs stay live during the render, and
    // the report has to be labelled with what was actually rendered.
    const applied = target.value
    const appliedUnit = unit.value
    const appliedPeakUnit = peakUnit.value
    const mode = peakMode.value

    // The longest-running client-side apply in the app — a whole-region
    // measurement plus up to four limiter passes — so the document pin
    // (applyToRegion) matters most here.
    const out = await applyToRegion({
      what: 'Loudness normalization',
      label: 'loudness normalization',
      busy: 'Loudness normalizing…',
      start,
      end,
      render: r => loudnessNormalizeRegion(r.segments, r.start, r.end, applied, mode, r.ctx, r.sampleRate, r.channels),
      failed: 'Loudness normalization failed',
    })
    if (!out) return false

    // applyToRegion committed, so the file active now is the one rendered.
    reports.value = {
      ...reports.value,
      [appState.activeDocumentId]: {
        ...out.report,
      targetDb: applied.targetDb,
      unitLabel: appliedUnit,
        peakUnitLabel: appliedPeakUnit,
      },
    }
    // The region now measures differently — say so with the new numbers rather
    // than leaving the readout describing the file that has just been replaced.
    measurement.value = null
    scheduleMeasure()
    showToast(loudnessToast(out.report, appliedUnit))
    return true
  }

  return {
    targetDb, unit, ceilingDb, peakMode,
    measurement, measuring, plan, outcome, achieved, canApply,
    noteTarget, targetButtons, targetRange, peakUnit,
    selectTarget, apply,
  }
}

/**
 * What to say about a finished render.
 *
 * ⚠ `converged` IS NOT THE SAME QUESTION AS "DID IT REACH THE TARGET". SAFE
 * converges by design when the ceiling stops it short — there was nothing to
 * iterate — so reporting on `converged` alone announced "Loudness normalized"
 * for a render the window's own outcome line had just said would fall 8 dB
 * short. Both ways of missing are reported, in the terms that caused them.
 */
export function loudnessToast(report, appliedUnit) {
  if (report.shortfallDb > 0.05) {
    return `Normalized to ${formatDb(report.achievedDb)} ${appliedUnit} — `
      + `${formatDb(report.shortfallDb)} dB short of target, held by the ceiling`
  }
  if (!report.converged) {
    return `Reached ${formatDb(report.achievedDb)} ${appliedUnit} — the ceiling would not allow more`
  }
  return 'Loudness normalized'
}
