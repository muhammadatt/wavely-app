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
import Knob from '../../knobs/Knob.vue'
import DeviceChoiceRocker from '../../knobs/DeviceChoiceRocker.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  state, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, totalDuration, hasSelection,
} = useEditorState()

const ACCENT = '#d8e05b'

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

/**
 * Measure the region.
 *
 * ⚠ REPLIES ARE MATCHED TO THE REQUEST THAT ASKED FOR THEM. Dragging a
 * selection edge starts a measurement per settle, the long region can take
 * longer than the short one, and without the sequence check an older reply
 * would land last and leave the readout describing a region nobody has
 * selected.
 */
async function remeasure() {
  const { start, end } = region()
  if (!(end > start) || !state.currentFile) {
    measurement.value = null
    return
  }
  const seq = ++measureSeq
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
    if (seq === measureSeq) measuring.value = false
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

/** What the last Apply landed on, or null before one has run. */
const achieved = computed(() => {
  const r = lastReport.value
  if (!r) return null
  const miss = Math.abs(r.achievedDb - targetDb.value)
  return {
    text: `Applied: ${plain(r.achievedDb)} ${r.unitLabel} at ${plain(r.achievedPeakDb)} ${r.peakUnitLabel}`,
    warn: !r.converged || miss > 0.5,
  }
})

async function applyNormalize() {
  const { start, end } = region()
  if (start >= end) return

  startProcessing('Loudness normalizing…')
  try {
    const ctx = getAudioContext()
    const { buffer, report } = await loudnessNormalizeRegion(
      state.segments, start, end, target.value, peakMode.value,
      ctx, state.currentFile.sampleRate, state.currentFile.channels,
    )
    const bufferId = replaceRegion(start, end, buffer, 'loudness normalization')
    setPeakCache(bufferId, await computePeakCache(buffer, 256))

    lastReport.value = {
      ...report,
      unitLabel: unit.value,
      peakUnitLabel: peakUnit.value,
    }
    // The region now measures differently — say so with the new numbers rather
    // than leaving the readout describing the file that has just been replaced.
    measurement.value = null
    scheduleMeasure()

    showToast(report.converged
      ? 'Loudness normalized'
      : `Reached ${plain(report.achievedDb)} ${unit.value} — the ceiling would not allow more`)
  } catch (err) {
    console.error('Loudness normalize failed:', err)
    showToast('Loudness normalization failed')
  } finally {
    endProcessing()
  }
}
</script>

<template>
  <FloatingWindow
    window-id="loudness"
    :z="z"
    :width="520"
    :accent="ACCENT"
    brand-lead="LOUDNESS"
    brand-tail="NORM"
    :show-engage="false"
    show-preview
    :previewable="false"
    show-apply
    :apply-disabled="!measurement"
    apply-disabled-hint="Nothing measurable in this region"
    @apply="applyNormalize()"
  >
    <div class="px-[24px] pt-[20px] pb-[22px] flex flex-col gap-[18px]">

      <!-- ── What the region measures ────────────────────────────────────
           First, and above the controls, because every decision below is made
           against it: a target is meaningless without the number it is being
           moved from. -->
      <div
        class="rounded-[10px] px-[14px] py-[11px]"
        style="background:rgba(0,0,0,.22);border:1px solid rgba(255,255,255,.06)"
      >
        <div class="flex items-center justify-between">
          <span style="font:600 8.5px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.38)">
            {{ hasSelection ? 'SELECTION' : 'WHOLE FILE' }}
          </span>
          <span
            v-if="measuredLine"
            style="font:600 9px 'Inter',system-ui;color:rgba(255,255,255,.4)"
          >{{ measuredLine }}</span>
        </div>

        <div v-if="measurement && !measuring" class="mt-[9px] flex items-center gap-[22px]">
          <div class="flex flex-col">
            <span style="font:600 8px 'Inter',system-ui;letter-spacing:.12em;color:rgba(255,255,255,.35)">
              {{ unit === 'RMS' ? 'RMS' : 'INTEGRATED' }}
            </span>
            <span
              class="font-['JetBrains_Mono']"
              style="font-size:17px;font-weight:700;font-variant-numeric:tabular-nums"
              :style="{ color: ACCENT }"
            >{{ plain(unit === 'RMS' ? measurement.rmsDb : measurement.lufs) }}
              <span style="font-size:9px;opacity:.6">{{ unit === 'RMS' ? 'dBFS' : 'LUFS' }}</span>
            </span>
          </div>

          <div class="flex flex-col">
            <span style="font:600 8px 'Inter',system-ui;letter-spacing:.12em;color:rgba(255,255,255,.35)">
              {{ unit === 'RMS' ? 'SAMPLE PEAK' : 'TRUE PEAK' }}
            </span>
            <span
              class="font-['JetBrains_Mono']"
              style="font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.82)"
            >{{ plain(unit === 'RMS' ? measurement.samplePeakDb : measurement.truePeakDb) }}
              <span style="font-size:9px;opacity:.6">{{ peakUnit }}</span>
            </span>
          </div>

          <div class="flex-1 min-w-0 text-right">
            <span
              v-if="outcome"
              class="font-['JetBrains_Mono']"
              style="font-size:10.5px;font-weight:600;color:rgba(255,255,255,.55)"
            >{{ outcome }}</span>
          </div>
        </div>

        <!-- ⚠ A SHORT REGION IS NOT AN INTEGRATED MEASUREMENT and saying so is
             the difference between a reading and a claim. Below 400 ms there
             are no BS.1770 blocks to gate, so the figure above is a single
             ungated window — fine for evening out a phrase, not a number to
             submit anything against. -->
        <p
          v-if="measurement?.short && unit !== 'RMS'"
          class="mt-[8px]"
          style="font:600 9px/1.5 'Inter',system-ui;color:#d8e05b"
        >
          Under 0.4 s — this is a single ungated window, not an integrated reading
        </p>
      </div>

      <!-- ── Benchmarks ──────────────────────────────────────────────────
           Buttons describe values rather than selecting a mode: land on
           Spotify's numbers by turning the knobs and its button lights, which
           is the truth about what the panel is set to. -->
      <div class="flex flex-col gap-[10px]">
        <div v-for="g in buttons" :key="g.id" class="flex items-center gap-[10px]">
          <span
            style="font:600 8px 'Inter',system-ui;letter-spacing:.12em;color:rgba(255,255,255,.3);width:74px;flex-shrink:0"
          >{{ g.label }}</span>
          <div class="flex flex-wrap gap-[6px]">
            <button
              v-for="t in g.targets"
              :key="t.id"
              type="button"
              :title="`${t.name} — ${t.targetDb} ${t.unit}, ${t.ceilingDb} ${t.unit === 'RMS' ? 'dBFS' : 'dBTP'}. ${t.note}`"
              class="cursor-pointer"
              @click="selectTarget(t.id)"
              :style="[
                {
                  padding: '7px 11px', borderRadius: '9px',
                  transition: 'background-color .15s ease, border-color .15s ease',
                },
                t.active
                  ? {
                    background: `color-mix(in srgb, ${ACCENT} 20%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${ACCENT} 55%, transparent)`,
                  }
                  : { background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)' },
              ]"
            >
              <span
                style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.1em"
                :style="{ color: t.active ? ACCENT : 'rgba(255,255,255,.72)' }"
              >{{ t.label }}</span>
            </button>
          </div>
        </div>

        <!-- Reserved height rather than a conditional: the line is blank
             whenever the knobs sit off every benchmark, and an element that
             came and went would jump the controls below it on every nudge. -->
        <p
          class="text-center"
          style="font:600 9px 'Inter',system-ui;color:rgba(255,255,255,.4);min-height:12px"
        >{{ noteTarget ? noteTarget.note : '' }}</p>
      </div>

      <!-- ── The three controls ──────────────────────────────────────────── -->
      <div class="flex items-start justify-center gap-[26px] pt-[4px]">
        <div class="w-[112px]">
          <Knob
            v-model="targetDb"
            :min="targetRange.min" :max="targetRange.max" :step="0.1"
            label="Target" :accent="ACCENT" :format-value="plain" editable
          />
          <p class="mt-[4px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ unit === 'RMS' ? 'dBFS RMS, ungated' : 'LUFS integrated' }}
          </p>
        </div>

        <div class="w-[112px]">
          <Knob
            v-model="ceilingDb"
            :min="-9" :max="0" :step="0.1"
            label="Ceiling" :accent="ACCENT" :format-value="plain" editable
          />
          <p class="mt-[4px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ peakUnit }}
          </p>
        </div>

        <div class="flex flex-col items-center gap-[8px] pt-[10px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4);white-space:nowrap">
            PEAK
          </span>
          <DeviceChoiceRocker
            v-model="peakMode"
            :options="PEAK_MODES.map(m => ({ value: m.id, label: m.label, title: m.caption }))"
            :accent="ACCENT"
            label="Peak control"
            :caption="PEAK_MODES.find(m => m.id === peakMode)?.caption ?? ''"
          />
        </div>
      </div>

      <!-- ── What the last Apply actually did ────────────────────────────
           Measured on the rendered audio, not predicted from the gain. It is
           the only number in the panel that is a fact rather than a plan, and
           where limiting was involved the two genuinely differ. -->
      <p
        v-if="achieved"
        class="text-center font-['JetBrains_Mono']"
        style="font-size:10px;font-weight:600;font-variant-numeric:tabular-nums"
        :style="{ color: achieved.warn ? '#ffb094' : 'rgba(255,255,255,.5)' }"
      >{{ achieved.text }}</p>
    </div>
  </FloatingWindow>
</template>
