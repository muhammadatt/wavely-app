<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import {
  loudnessNormalizeRegion, measureRegionLoudness, computePeakCache,
} from '../../../audio/processing.js'
import {
  TARGET_GROUPS, DEFAULT_TARGET_ID, matchingTargets, targetById, targetsInGroup,
} from '../../../audio/loudnessTargets.js'
import { PEAK_MODES, planNormalization } from '../../../audio/dsp/loudnessNormalize.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import ModulaChip from '../../modula/ModulaChip.vue'
import ModulaSegmented from '../../modula/ModulaSegmented.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  appState, state, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, totalDuration, hasSelection,
} = useEditorState()

const ACCENT = '#e8a33d'

/**
 * The panel's own state, held here rather than in a composable.
 *
 * Nothing about this effect is live: there is no worklet, no preview node and
 * no parameter the transport has to see, so the state that would justify a
 * composable does not exist. Peak Normalize next door is built the same way,
 * and it is the shape that keeps the composable→destructure blind spot out of
 * a panel that has no need for one.
 */
const initial = targetById(DEFAULT_TARGET_ID)
const targetDb = ref(initial.targetDb)
const unit = ref(initial.unit)
const ceilingDb = ref(initial.ceilingDb)
const peakMode = ref('limit')

/** The last measurement of the current region, or null while unknown. */
const measurement = ref(null)
const measuring = ref(false)
/** What the last Apply actually achieved — measured on the render. */
const lastReport = ref(null)

/** The region the panel works on: the selection, or the whole file. */
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

/**
 * Which benchmark's note to print, when more than one is lit.
 *
 * ⚠ THE CLICK IS REMEMBERED ONLY FOR THIS. It is not a selection — the lit
 * buttons come from the values, and turning the knob off them unlights
 * everything including this one. What it settles is that clicking PODCAST
 * prints the podcast note rather than Apple Music's, even though both are
 * true of -16 LUFS at -1 dBTP.
 */
const chosenId = ref(DEFAULT_TARGET_ID)

const noteTarget = computed(() => {
  const lit = matchingTargets(targetDb.value, unit.value, ceilingDb.value)
  return lit.find(t => t.id === chosenId.value) ?? lit[0] ?? null
})

/**
 * What Apply would do, from the last measurement.
 *
 * ⚠ THIS IS THE SAME FUNCTION THE RENDER USES, not a display-side re-derivation
 * of it. The whole promise of the panel is that the number under the knob is
 * the number that comes out, and two implementations of "what gain does this
 * need" would eventually disagree about a ceiling.
 */
const plan = computed(() => {
  if (!measurement.value) return null
  return planNormalization(measurement.value, target.value, peakMode.value)
})

// ── Measurement ─────────────────────────────────────────────────────────────

let measureSeq = 0
let measureTimer = null
/** Set while a pass is in the worker, so a second one cannot be started. */
let measureInFlight = false
/** Set when a request arrives mid-pass; the pass re-runs once, on completion. */
let measureAgain = false

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

onMounted(remeasure)
onUnmounted(() => clearTimeout(measureTimer))
watch(() => state.selection, scheduleMeasure, { deep: true })
// A render replaces buffers in the region, so the reading it produced is stale
// the moment anything else edits the file.
watch(() => state.revision, scheduleMeasure)

// ── Setting the target ──────────────────────────────────────────────────────

function selectTarget(id) {
  const t = targetById(id)
  if (!t) return
  chosenId.value = id
  targetDb.value = t.targetDb
  unit.value = t.unit
  ceilingDb.value = t.ceilingDb
}

/**
 * Knob ranges follow the unit, because the two meters do not share a scale.
 *
 * -20 means "the middle of the ACX window" on the RMS meter and "quieter than
 * every broadcast standard" on the LUFS one. One range spanning both would put
 * every value anyone actually uses inside a third of the travel.
 */
const targetRange = computed(() =>
  unit.value === 'RMS' ? { min: -30, max: -10 } : { min: -32, max: -8 })

const buttons = computed(() => TARGET_GROUPS.map(g => ({
  ...g,
  targets: targetsInGroup(g.id).map(t => ({
    ...t,
    active: activeIds.value.has(t.id),
  })),
})))

// ── Readout ─────────────────────────────────────────────────────────────────

const db = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—')
const plain = v => (Number.isFinite(v) ? v.toFixed(1) : '—')

const PEAK_MODE_OPTIONS = PEAK_MODES.map(m => ({ value: m.id, label: m.label, title: m.caption }))
const peakModeCaption = computed(() => PEAK_MODES.find(m => m.id === peakMode.value)?.caption ?? '')

/** The unit a peak is stated in, which follows the target's meter. */
const peakUnit = computed(() => (unit.value === 'RMS' ? 'dBFS' : 'dBTP'))

const measuredLine = computed(() => {
  if (measuring.value) return 'Measuring…'
  if (!measurement.value) return 'No audio in this region'
  return null
})

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
  if (!p.ceilingHit) return `${db(p.gainDb)} dB, nothing limited`
  if (peakMode.value === 'safe') {
    return `${db(p.gainDb)} dB — stops ${plain(p.shortfallDb)} dB short of target`
  }
  return `${db(p.gainDb)} dB, then peaks limited to ${plain(ceilingDb.value)} ${peakUnit.value}`
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
    text: `Applied: ${plain(r.achievedDb)} ${r.unitLabel} at ${plain(r.achievedPeakDb)} ${r.peakUnitLabel}`,
    warn: !r.converged || miss > 0.5 || r.shortfallDb > 0.5,
  }
})

async function applyNormalize() {
  const { start, end } = region()
  if (start >= end) return
  // A region with nothing measurable has no target to move to. The Apply button
  // is disabled for it, and this is the second half of that: a keyboard or a
  // race must not reach a no-op that then reports success.
  if (!plan.value || plan.value.silent) return

  /**
   * ⚠ THE DOCUMENT IS CAPTURED BEFORE THE AWAIT, NOT LOOKED UP AFTER IT.
   * `replaceRegion`, `startProcessing` and `endProcessing` all default to
   * whichever tab is active when they are CALLED, and this render is the
   * longest-running client-side apply in the app — a whole-file measurement
   * plus up to four limiter passes. Switch tabs while it runs and the default
   * splices the result into the wrong document and leaves this one stuck
   * showing "processing" forever. The state API already takes a docId for
   * exactly this reason; it just has to be passed.
   */
  const docId = appState.activeDocumentId
  // Likewise the settings: the knobs stay live during the render, and the
  // report has to be labelled with what was actually rendered.
  const applied = target.value
  const appliedUnit = unit.value
  const appliedPeakUnit = peakUnit.value
  const mode = peakMode.value
  const { sampleRate, channels } = state.currentFile

  startProcessing('Loudness normalizing…', docId)
  try {
    const ctx = getAudioContext()
    const { buffer, report } = await loudnessNormalizeRegion(
      state.segments, start, end, applied, mode, ctx, sampleRate, channels,
    )
    const bufferId = replaceRegion(start, end, buffer, 'loudness normalization', docId)
    setPeakCache(bufferId, await computePeakCache(buffer, 256))

    lastReport.value = {
      ...report,
      targetDb: applied.targetDb,
      unitLabel: appliedUnit,
      peakUnitLabel: appliedPeakUnit,
    }
    // The region now measures differently — say so with the new numbers rather
    // than leaving the readout describing the file that has just been replaced.
    measurement.value = null
    scheduleMeasure()

    showToast(toastFor(report, appliedUnit))
  } catch (err) {
    console.error('Loudness normalize failed:', err)
    showToast('Loudness normalization failed')
  } finally {
    endProcessing(docId)
  }
}

/**
 * What to say about a finished render.
 *
 * ⚠ `converged` IS NOT THE SAME QUESTION AS "DID IT REACH THE TARGET". SAFE
 * converges by design when the ceiling stops it short — there was nothing to
 * iterate — so reporting on `converged` alone announced "Loudness normalized"
 * for a render the panel's own outcome line had just said would fall 8 dB
 * short. Both ways of missing are reported, in the terms that caused them.
 */
function toastFor(report, appliedUnit) {
  if (report.shortfallDb > 0.05) {
    return `Normalized to ${plain(report.achievedDb)} ${appliedUnit} — `
      + `${plain(report.shortfallDb)} dB short of target, held by the ceiling`
  }
  if (!report.converged) {
    return `Reached ${plain(report.achievedDb)} ${appliedUnit} — the ceiling would not allow more`
  }
  return 'Loudness normalized'
}

</script>

<template>
  <FloatingWindow
    window-id="loudness"
    :z="z"
    :width="560"
    :accent="ACCENT"
    design="modula"
    brand-lead="LOUDNESS NORMALIZE"
    :show-engage="false"
    show-preview
    :previewable="false"
    show-apply
    :requires-selection="false"
    :apply-disabled="!measurement || !!plan?.silent"
    :apply-disabled-hint="measuring
      ? 'Measuring the region'
      : 'Nothing measurable in this region'"
    @apply="applyNormalize()"
  >
    <div class="ln-face">

      <!-- ── What the region measures ────────────────────────────────────
           First, and above the controls, because every decision below is made
           against it: a target is meaningless without the number it is being
           moved from. -->
      <div class="ln-well">
        <div class="ln-well-head">
          <span class="m-caption">{{ hasSelection ? 'Selection' : 'Whole file' }}</span>
          <span v-if="measuredLine" class="ln-status">{{ measuredLine }}</span>
        </div>

        <div v-if="measurement && !measuring" class="ln-reads">
          <div class="ln-read">
            <span class="ln-read-cap">{{ unit === 'RMS' ? 'RMS' : 'INTEGRATED' }}</span>
            <span class="ln-read-val" :style="{ color: ACCENT }">
              {{ plain(unit === 'RMS' ? measurement.rmsDb : measurement.lufs) }}<span class="ln-read-unit">{{ unit === 'RMS' ? 'dBFS' : 'LUFS' }}</span>
            </span>
          </div>
          <div class="ln-read">
            <span class="ln-read-cap">{{ unit === 'RMS' ? 'SAMPLE PEAK' : 'TRUE PEAK' }}</span>
            <span class="ln-read-val">
              {{ plain(unit === 'RMS' ? measurement.samplePeakDb : measurement.truePeakDb) }}<span class="ln-read-unit">{{ peakUnit }}</span>
            </span>
          </div>
          <span v-if="outcome" class="ln-outcome">{{ outcome }}</span>
        </div>

        <!-- ⚠ A SHORT REGION IS NOT AN INTEGRATED MEASUREMENT and saying so is
             the difference between a reading and a claim. Below 400 ms there
             are no BS.1770 blocks to gate, so the figure above is a single
             ungated window — fine for evening out a phrase, not a number to
             submit anything against. -->
        <p v-if="measurement?.short && unit !== 'RMS'" class="ln-short">
          Under 0.4 s — this is a single ungated window, not an integrated reading
        </p>
      </div>

      <!-- ── Benchmarks ──────────────────────────────────────────────────
           Buttons describe values rather than selecting a mode: land on
           Spotify's numbers by turning the knobs and its lamp lights, which
           is the truth about what the panel is set to. -->
      <div class="ln-benchmarks">
        <div v-for="g in buttons" :key="g.id" class="ln-group">
          <span class="ln-group-label">{{ g.label }}</span>
          <div class="ln-chips">
            <ModulaChip
              v-for="t in g.targets"
              :key="t.id"
              lamp
              :model-value="t.active"
              :label="t.label"
              :color="ACCENT"
              :title="`${t.name} — ${t.targetDb} ${t.unit}, ${t.ceilingDb} ${t.unit === 'RMS' ? 'dBFS' : 'dBTP'}. ${t.note}`"
              @click="selectTarget(t.id)"
            />
          </div>
        </div>

        <!-- Reserved height rather than a conditional: the line is blank
             whenever the knobs sit off every benchmark, and an element that
             came and went would jump the controls below it on every nudge. -->
        <p class="ln-note">{{ noteTarget ? noteTarget.note : '' }}</p>
      </div>

      <!-- ── The three controls ──────────────────────────────────────────── -->
      <div class="ln-panel">
        <div class="ln-knob">
          <ModulaKnob
            variant="led" :size="105" show-value editable
            v-model="targetDb" :min="targetRange.min" :max="targetRange.max" :step="0.1"
            :default-value="initial.targetDb"
            label="Target" :color="ACCENT" :format-value="plain"
            title="The loudness to move the region to. Double-click to reset; click the value to type one"
          />
          <span class="m-note">{{ unit === 'RMS' ? 'dBFS RMS, ungated' : 'LUFS integrated' }}</span>
        </div>

        <div class="ln-knob">
          <ModulaKnob
            variant="ticks" :size="85" show-value editable
            v-model="ceilingDb" :min="-9" :max="0" :step="0.1"
            :default-value="initial.ceilingDb"
            label="Ceiling" :color="ACCENT" :format-value="plain"
            title="The highest the peaks may land. Double-click to reset; click the value to type one"
          />
          <span class="m-note">{{ peakUnit }}</span>
        </div>

        <div class="ln-mode">
          <span class="m-caption">Peak</span>
          <ModulaSegmented v-model="peakMode" :options="PEAK_MODE_OPTIONS" aria-label="Peak control" />
          <span class="ln-mode-cap">{{ peakModeCaption }}</span>
        </div>
      </div>

      <!-- ── What the last Apply actually did ────────────────────────────
           Measured on the rendered audio, not predicted from the gain. It is
           the only number in the panel that is a fact rather than a plan, and
           where limiting was involved the two genuinely differ. -->
      <p v-if="achieved" class="ln-achieved" :class="{ 'is-warn': achieved.warn }">{{ achieved.text }}</p>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.ln-face {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── Measurement well ── */
.ln-well {
  padding: 11px 14px 12px;
  border-radius: 10px;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
}
.ln-well-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ln-status {
  font: 600 10px/1 var(--m-font-ui);
  color: var(--m-ink-4);
}
.ln-reads {
  margin-top: 10px;
  display: flex;
  align-items: flex-end;
  gap: 24px;
}
.ln-read {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ln-read-cap {
  font: 600 8.5px/1 var(--m-font-ui);
  letter-spacing: .12em;
  color: var(--m-ink-4);
}
.ln-read-val {
  font: 700 19px/1 var(--m-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--m-ink);
}
.ln-read-unit {
  margin-left: 4px;
  font-size: 9px;
  opacity: .6;
}
.ln-outcome {
  flex: 1;
  min-width: 0;
  text-align: right;
  font: 600 10.5px/1.3 var(--m-font-mono);
  color: var(--m-ink-3);
}
.ln-short {
  margin: 9px 0 0;
  font: 600 9.5px/1.5 var(--m-font-ui);
  color: var(--m-accent);
}

/* ── Benchmarks ── */
.ln-benchmarks {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.ln-group {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ln-group-label {
  flex: none;
  width: 92px;
  font: 600 9px/1.2 var(--m-font-ui);
  letter-spacing: .14em;
  color: var(--m-ink-4);
}
.ln-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ln-note {
  margin: 0;
  min-height: 13px;
  text-align: center;
  font: 500 10px/1.3 var(--m-font-ui);
  color: var(--m-ink-4);
}

/* ── Controls ── */
.ln-panel {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 34px;
  padding: 16px 18px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.ln-knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.ln-mode {
  align-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
}
.ln-mode-cap {
  max-width: 130px;
  text-align: center;
  font: 500 9.5px/1.4 var(--m-font-ui);
  color: var(--m-ink-4);
}

.ln-achieved {
  margin: 0;
  text-align: center;
  font: 600 10px/1.3 var(--m-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--m-ink-3);
}
.ln-achieved.is-warn { color: #ffb094; }
</style>
