<script setup>
import { computed, onMounted } from 'vue'
import { useAirBand } from '../../composables/useAirBand.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { airBandSections } from '../../audio/airBandProcessor.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { AIR_BOOST_PRESET_PLUGIN } from '../../audio/pluginPresets/airBoost.js'
import {
  AIR_BAND_DEFAULTS, AIR_MAX_DB, AIR_OUTPUT_MIN_DB, AIR_OUTPUT_MAX_DB,
} from '../../audio/airBandParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  airBandAir, airBandOutput, airBandPreview, airBandInputLevels, airBandOutputLevels,
  togglePreview, syncAir, syncOutput, applyParams, apply, teardown, closeModal,
} = useAirBand()

const presets = usePluginPresets(AIR_BOOST_PRESET_PLUGIN, {
  read: () => ({ air: airBandAir.value, output: airBandOutput.value }),
  write: p => applyParams(p),
})

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!airBandPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#8fd48a'
const METER_H = 200

// ── Response curve ──────────────────────────────────────────────────────────
// Drawn from the same coefficient builders the kernel uses, so what is on
// screen is the filter that is running rather than a redrawn approximation.
const CURVE_W = 360
const CURVE_H = 112
const F_MIN = 100
const F_MAX = 20000
const DB_MAX = 14

const CURVE_FREQS = Array.from({ length: 160 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 159),
)

const GRID_FREQS = [100, 1000, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  // 0 dB sits on the baseline; the curve only ever lifts.
  return CURVE_H - (db / DB_MAX) * CURVE_H
}

const curvePath = computed(() => {
  // The response is sample-rate dependent, so use the file's rate where we
  // have one and fall back to the most common rate before a file is loaded.
  const sr = state.currentFile?.sampleRate ?? 44100
  const sections = airBandSections(sr, airBandAir.value)
  const db = magnitudeResponseDb(sections, CURVE_FREQS, sr)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${yFor(db[i]).toFixed(1)}`,
  ).join(' ')
})

const curveFill = computed(
  () => `${curvePath.value} L${CURVE_W},${CURVE_H} L0,${CURVE_H} Z`,
)

function formatAir(v) {
  return `+${v.toFixed(1)} dB`
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

function gridLabelStyle(freqHz) {
  if (freqHz <= F_MIN) {
    return {
      left: '0%',
      transform: 'none',
    }
  }
  if (freqHz >= F_MAX) {
    return {
      left: '100%',
      transform: 'translateX(-100%)',
    }
  }
  return {
    left: `${(xFor(freqHz) / CURVE_W) * 100}%`,
    transform: 'translateX(-50%)',
  }
}

// Preview is transport playback — the worklet is already in the chain, so what
// makes it live is that audio is running while you turn the knob.
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="air-band"
    :z="z"
    :width="680"
    :accent="ACCENT"
    design="modula"
    brand-lead="AIR BOOST"
    :presets="presets"
    :presets-disabled="!airBandPreview"
    presets-disabled-hint="Turn Air Boost on to use presets"
    :engaged="airBandPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!airBandPreview"
    apply-disabled-hint="Turn Air Boost on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="ab-grid">
      <div class="ab-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="airBandInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="ab-panel">
        <!-- Response curve, from the same coefficient builders the kernel runs. -->
        <div>
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="ab-well"
            :style="{ height: `${CURVE_H}px` }"
            preserveAspectRatio="none"
          >
            <line
              v-for="f in GRID_FREQS" :key="f"
              :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
              stroke="rgba(255,255,255,.07)" stroke-width="1"
            />
            <line
              :x1="0" :y1="CURVE_H - 0.5" :x2="CURVE_W" :y2="CURVE_H - 0.5"
              stroke="rgba(255,255,255,.16)" stroke-width="1"
            />
            <path :d="curveFill" :fill="ACCENT" fill-opacity="0.14" />
            <path :d="curvePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="ab-axis">
            <span v-for="f in GRID_FREQS" :key="f" :style="gridLabelStyle(f)">{{ gridLabel(f) }}</span>
          </div>
        </div>

        <ModulaKnob
          variant="led" :size="146" show-value editable
          :model-value="airBandAir" :min="0" :max="AIR_MAX_DB" :step="0.1"
          :default-value="AIR_BAND_DEFAULTS.air"
          label="Air" :color="ACCENT" :format-value="formatAir" :disabled="!airBandPreview"
          title="How much air: the whole shelf and its five bells scale together. Double-click to reset; click the value to type one"
          @update:model-value="syncAir"
        />
      </div>

      <div class="ab-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="airBandOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="airBandOutput" show-value
              :min="AIR_OUTPUT_MIN_DB" :max="AIR_OUTPUT_MAX_DB" :step="0.1"
              :default-value="AIR_BAND_DEFAULTS.output" :format-value="formatOutput"
              aria-label="Output" :disabled="!airBandPreview"
              title="Output: a trim for a level-matched A/B. Double-click to reset"
              @update:model-value="syncOutput"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <p class="ab-about">
      Maag-style air lift — a wide shelf shaped by five overlapping bells.
      Adds presence without the harshness of a narrow high boost.
    </p>
  </FloatingWindow>
</template>

<style scoped>
.ab-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.ab-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.ab-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 14px 14px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.ab-panel > :deep(.m-knob) { align-self: center; }
.ab-well {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.ab-axis {
  position: relative;
  height: 10px;
  margin-top: 4px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.ab-axis span { position: absolute; top: 0; }
.ab-about {
  margin: 12px 8px 0;
  text-align: center;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
</style>
