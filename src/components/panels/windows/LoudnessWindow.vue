<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import {
  useLoudnessNormalize, formatDb as plain, LOUDNESS_INITIAL_TARGET as initial,
} from '../../../composables/useLoudnessNormalize.js'
import { PEAK_MODES } from '../../../audio/dsp/loudnessNormalize.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import ModulaChip from '../../modula/ModulaChip.vue'
import ModulaSegmented from '../../modula/ModulaSegmented.vue'

defineProps({ z: { type: Number, default: 500 } })

const { hasSelection } = useEditorState()

/**
 * Everything this window decides — the measurement and when it re-runs, the
 * plan, the outcome and the apply — is useLoudnessNormalize's; the window
 * draws it.
 */
const {
  targetDb, unit, ceilingDb, peakMode,
  measurement, measuring, outcome, achieved, canApply,
  noteTarget, targetButtons: buttons, targetRange, peakUnit,
  selectTarget, apply: applyNormalize,
} = useLoudnessNormalize()

const ACCENT = '#e8a33d'

const PEAK_MODE_OPTIONS = PEAK_MODES.map(m => ({ value: m.id, label: m.label, title: m.caption }))
const peakModeCaption = computed(() => PEAK_MODES.find(m => m.id === peakMode.value)?.caption ?? '')

const measuredLine = computed(() => {
  if (measuring.value) return 'Measuring…'
  if (!measurement.value) return 'No audio in this region'
  return null
})
</script>

<template>
  <FloatingWindow
    window-id="loudness"
    :z="z"
    :width="560"
    :accent="ACCENT"
    design="modula"
    brand-lead="LOUDNESS"
    brand-tail="NORMALIZE"
    :show-engage="false"
    show-preview
    :previewable="false"
    show-apply
    :requires-selection="false"
    :apply-disabled="!canApply"
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
      <div class="ln-well" data-help="measurement">
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
      <div class="ln-benchmarks" data-help="benchmarks">
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
        <div class="ln-knob" data-help="target">
          <ModulaKnob
            variant="led" :size="146" show-value editable
            v-model="targetDb" :min="targetRange.min" :max="targetRange.max" :step="0.1"
            :default-value="initial.targetDb"
            label="Target" :color="ACCENT" :format-value="plain"
            title="The loudness to move the region to. Double-click to reset; click the value to type one"
          />
          <span class="m-note">{{ unit === 'RMS' ? 'dBFS RMS, ungated' : 'LUFS integrated' }}</span>
        </div>

        <div class="ln-knob" data-help="ceiling">
          <ModulaKnob
            variant="ticks" :size="139" show-value editable
            v-model="ceilingDb" :min="-9" :max="0" :step="0.1"
            :default-value="initial.ceilingDb"
            label="Ceiling" :color="ACCENT" :format-value="plain"
            title="The highest the peaks may land. Double-click to reset; click the value to type one"
          />
          <span class="m-note">{{ peakUnit }}</span>
        </div>

        <div class="ln-mode" data-help="peak">
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
