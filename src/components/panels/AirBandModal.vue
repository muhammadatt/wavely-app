<script setup>
import { computed, onMounted } from 'vue'
import { useAirBand } from '../../composables/useAirBand.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { airBandSections } from '../../audio/airBandProcessor.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import Knob from '../knobs/Knob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  airBandAir, airBandOutput, airBandPreview, airBandInputDb, airBandOutputDb,
  hasSelection, togglePreview, syncAir, syncOutput, apply, teardown, closeModal,
} = useAirBand()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!airBandPreview.value) togglePreview()
})

const ACCENT = '#7fd4e8'

// ── Response curve ──────────────────────────────────────────────────────────
// Drawn from the same coefficient builders the kernel uses, so what is on
// screen is the filter that is running rather than a redrawn approximation.
const CURVE_W = 360
const CURVE_H = 96
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
  return `+${v.toFixed(1)}`
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
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
    :width="600"
    :accent="ACCENT"
    brand-lead="AIR"
    brand-tail="BOOST"
    :engaged="airBandPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <div class="flex items-center justify-between gap-[22px]">
        <LevelMeter :db="airBandInputDb" label="IN" :height="120" />

        <div class="flex-1 flex flex-col items-center">
          <!-- Response curve -->
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="w-full"
            :style="{ height: `${CURVE_H}px` }"
            preserveAspectRatio="none"
          >
            <line
              v-for="f in GRID_FREQS" :key="f"
              :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
              stroke="rgba(255,255,255,.07)" stroke-width="1"
            />
            <line
              :x1="0" :y1="CURVE_H" :x2="CURVE_W" :y2="CURVE_H"
              stroke="rgba(255,255,255,.14)" stroke-width="1"
            />
            <path :d="curveFill" :fill="ACCENT" fill-opacity="0.12" />
            <path :d="curvePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="relative w-full mt-[4px] h-[10px]">
            <span
              v-for="f in GRID_FREQS" :key="f"
              class="absolute top-0"
              :style="{
                ...gridLabelStyle(f),
                fontWeight: 600,
                fontSize: '8px',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.08em',
                color: 'rgba(255,255,255,.28)',
              }"
            >{{ gridLabel(f) }}</span>
          </div>

          <div class="flex gap-[38px] mt-[16px]">
            <div class="w-[128px]">
              <Knob
                :model-value="airBandAir"
                @update:model-value="syncAir"
                :min="0" :max="12" :step="0.1"
                label="Air" :accent="ACCENT" :format-value="formatAir"
                :disabled="!airBandPreview"
              />
            </div>
            <div class="w-[92px]">
              <Knob
                :model-value="airBandOutput"
                @update:model-value="syncOutput"
                :min="-12" :max="12" :step="0.1" :value-font-px="13"
                label="Output" :accent="ACCENT" :format-value="formatOutput"
                :disabled="!airBandPreview"
              />
            </div>
          </div>
        </div>

        <LevelMeter :db="airBandOutputDb" label="OUT" :height="120" />
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Maag-style air lift — a wide shelf shaped by five overlapping bells.
        Adds presence without the harshness of a narrow high boost.
      </p>

      <div class="mt-[16px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#08171c"
          :met="hasSelection"
          message="Make a selection to add air"
          label="Apply AirBoost"
          :disabled="!airBandPreview"
          disabled-hint="Turn AirBoost on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
