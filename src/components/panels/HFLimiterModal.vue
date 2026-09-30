<script setup>
/**
 * HF Limiter.
 *
 * SHELF is a lookahead dynamic shelf that holds the band above FREQ at the
 * THRESHOLD (relative to the file's voice level), never deeper than RANGE, and
 * lets go over RELEASE — then, with TAIL up, over a slow second stage that only
 * a sustained cut charges. SHAPE picks the split: TIGHT is a one-octave
 * linear-phase ceiling, WARM the EL7 Fatso's 6 dB/oct one-pole tilt. TRANSIENT
 * deepens the same cut for a few milliseconds on sudden onsets — clicks, lip
 * smacks, t/k/p bursts, even below THRESHOLD — up to its own depth, stacked on
 * the shelf's; 0 is off. Read dsp/hfLimit.js for the design.
 *
 * The curve is the shelf the kernel is running right now, from the same split
 * it runs, with the deepest cut RANGE allows ghosted behind it. The lamp by
 * TRANSIENT lights while the onset softener cuts (full at 6 dB). DELTA plays only what
 * was removed and never reaches the apply path.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useHFLimiter } from '../../composables/useHFLimiter.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { shelfResponseDb } from '../../audio/dsp/hfLimit.js'
import {
  FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TAIL_MIN_MS, TAIL_MAX_MS, TRANSIENT_MAX_DB,
} from '../../audio/hfLimiterParams.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hflParams, hflPreview, hflDelta, hflReduction, hflTransient,
  hflInputLevels, hflOutputLevels,
  togglePreview, syncParam, toggleDelta, apply, teardown, closeModal,
} = useHFLimiter()

const { state } = useEditorState()

onMounted(() => {
  if (!hflPreview.value) togglePreview()
})

const ACCENT = '#e8b07f'

// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 360
const CURVE_H = 96
const F_MIN = 500
const F_MAX = 20000
const DB_MIN = -RANGE_MAX_DB

const CURVE_FREQS = Array.from({ length: 140 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 139),
)
const GRID_FREQS = [1000, 2000, 5000, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  return (Math.max(DB_MIN, Math.min(0, db)) / DB_MIN) * CURVE_H
}

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

function pathFor(gain) {
  const db = shelfResponseDb(sampleRate.value, hflParams.freq, gain, CURVE_FREQS, hflParams.shape)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${yFor(db[i]).toFixed(1)}`,
  ).join(' ')
}

// The live cut follows the meter, so the curve moves with the audio.
const livePath = computed(() => pathFor(Math.pow(10, -hflReduction.value / 20)))
const floorPath = computed(() => pathFor(Math.pow(10, -hflParams.range / 20)))
const liveFill = computed(() => `${livePath.value} L${CURVE_W},0 L0,0 Z`)

// ── Transient lamp: instant on, held fall, so one edge is visible ──────────
const lamp = ref(0)
let lampFrame = null
function lampTick() {
  const target = Math.min(1, hflTransient.value / 6)
  lamp.value = target > lamp.value ? target : lamp.value * 0.92
  lampFrame = requestAnimationFrame(lampTick)
}
onMounted(() => { lampFrame = requestAnimationFrame(lampTick) })
onBeforeUnmount(() => { if (lampFrame !== null) cancelAnimationFrame(lampFrame) })
watch(hflPreview, on => { if (!on) lamp.value = 0 })

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

const fmtFreq = v => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${(v / 1000).toFixed(2)}k`)
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const fmtRange = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)
const fmtMs = v => `${Math.round(v)}`
const fmtTail = v => (v < TAIL_MIN_MS ? 'OFF' : `${Math.round(v)}`)

const SHAPE_OPTIONS = [
  { value: 'tight', label: 'TIGHT', title: 'A one-octave, linear-phase split: a ceiling on the band above Freq, leaving everything below it alone' },
  { value: 'warm', label: 'WARM', title: 'A gentle 6 dB/oct split, the EL7 Fatso’s Warmth: the whole top end tilts down, starting an octave or more below Freq' },
]
const fmtTransient = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)

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
    window-id="hf-limiter"
    :z="z"
    :width="700"
    :accent="ACCENT"
    brand-lead="HF"
    brand-tail="LIMITER"
    :engaged="hflPreview"
    show-delta
    :delta="hflDelta"
    :delta-disabled="!hflPreview"
    delta-title="Hear only what is being removed — it should sound like hiss, sibilance and edges, not voice. Monitoring only; Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!hflPreview"
    apply-disabled-hint="Turn HF Limiter on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <GainReductionBar
        :reduction-db="-hflReduction" :accent="ACCENT"
        :full-scale-db="RANGE_MAX_DB" ballistics="none" title="HF REDUCTION"
      />

      <div class="flex items-center justify-between gap-[22px] mt-[18px]">
        <LevelMeter :levels="hflInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center">
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
            <line :x1="0" :y1="0" :x2="CURVE_W" :y2="0" stroke="rgba(255,255,255,.14)" stroke-width="1" />
            <line
              :x1="xFor(hflParams.freq)" :y1="0" :x2="xFor(hflParams.freq)" :y2="CURVE_H"
              :stroke="ACCENT" stroke-opacity=".35" stroke-width="1" stroke-dasharray="3 3"
            />
            <path :d="floorPath" stroke="rgba(255,255,255,.22)" stroke-width="1.2" fill="none" stroke-dasharray="4 3" />
            <path :d="liveFill" :fill="ACCENT" fill-opacity="0.12" />
            <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="relative w-full mt-[4px] h-[10px]">
            <span
              v-for="f in GRID_FREQS" :key="f"
              class="absolute top-0"
              :style="{
                left: `${(xFor(f) / CURVE_W) * 100}%`,
                transform: f >= F_MAX ? 'translateX(-100%)' : 'translateX(-50%)',
                fontWeight: 600, fontSize: '8px',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.08em', color: 'rgba(255,255,255,.28)',
              }"
            >{{ gridLabel(f) }}</span>
          </div>
        </div>

        <LevelMeter :levels="hflOutputLevels" label="OUT" :height="150" />
      </div>

      <div class="flex justify-center gap-[12px] mt-[18px]">
        <div class="w-[80px]" title="Where bright starts: the band above this is what the limiter listens to and turns down">
          <Knob
            :model-value="hflParams.freq" @update:model-value="v => syncParam('freq', v)"
            :min="FREQ_MIN_HZ" :max="FREQ_MAX_HZ" :step="10" scale="log" :value-font-px="13"
            label="Freq" :accent="ACCENT" :format-value="fmtFreq" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="Where the band is held, dB relative to the file's voice level — the same setting does the same thing on a quiet recording and a hot one">
          <Knob
            :model-value="hflParams.threshold" @update:model-value="v => syncParam('threshold', v)"
            :min="THRESHOLD_MIN_DB" :max="THRESHOLD_MAX_DB" :step="0.5" :value-font-px="13"
            label="Threshold" :accent="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="The deepest the shelf may cut. Keeps a hard S from turning into a lisp; 0 takes the shelf out">
          <Knob
            :model-value="hflParams.range" @update:model-value="v => syncParam('range', v)"
            :min="0" :max="RANGE_MAX_DB" :step="0.5" :value-font-px="13"
            label="Range" :accent="ACCENT" :format-value="fmtRange" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="How quickly the top comes back after a bright moment, ms">
          <Knob
            :model-value="hflParams.release" @update:model-value="v => syncParam('release', v)"
            :min="RELEASE_MIN_MS" :max="RELEASE_MAX_MS" :step="1" scale="log" :value-font-px="13"
            label="Release" :accent="ACCENT" :format-value="fmtMs" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="A slow second release stage, ms. A sustained bright passage charges it and the top comes back over this long; a single click barely does and recovers at the Release speed. Fully down is OFF, a single-stage release">
          <Knob
            :model-value="hflParams.tail" @update:model-value="v => syncParam('tail', v)"
            :min="0" :max="TAIL_MAX_MS" :step="5" :value-font-px="13"
            label="Tail" :accent="ACCENT" :format-value="fmtTail" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px] relative" title="Extra cut on sudden bright onsets — clicks, lip smacks, T, K and P bursts — even below the threshold, for a few milliseconds. Reacts to how suddenly the top end rises, not how loud it is, so a steady S is left to the shelf. Stacks on top of the shelf; 0 is off">
          <Knob
            :model-value="hflParams.transient" @update:model-value="v => syncParam('transient', v)"
            :min="0" :max="TRANSIENT_MAX_DB" :step="0.5" :value-font-px="13"
            label="Transient" :accent="ACCENT" :format-value="fmtTransient" :disabled="!hflPreview"
          />
          <span
            class="absolute top-[2px] right-[6px] w-[7px] h-[7px] rounded-full"
            :style="{
              background: ACCENT,
              opacity: 0.12 + 0.88 * lamp,
              boxShadow: lamp > 0.05 ? `0 0 ${6 * lamp}px ${ACCENT}` : 'none',
            }"
            aria-hidden="true"
          />
        </div>
        <div class="w-[80px]">
          <Knob
            :model-value="hflParams.output" @update:model-value="v => syncParam('output', v)"
            :min="-12" :max="12" :step="0.1" :value-font-px="13" bipolar
            label="Output" :accent="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
          />
        </div>
      </div>

      <div class="flex justify-center mt-[16px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)">SHAPE</span>
          <DeviceChoiceRocker
            :model-value="hflParams.shape" :options="SHAPE_OPTIONS" :accent="ACCENT"
            :disabled="!hflPreview" label="Shape"
            @update:model-value="v => syncParam('shape', v)"
          />
        </div>
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Holds the top end at a ceiling: brightness and harshness on the shelf,
        clicks and sharp onsets on Transient. Below the threshold it passes audio untouched.
      </p>
    </div>
  </FloatingWindow>
</template>
