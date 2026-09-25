<script setup>
/**
 * HF Softener.
 *
 * Four controls, as the spec has it: Amount and Context are the tuning, the
 * Rotator routing is a character choice, and Listen is a monitor tap that
 * never reaches the apply path. The curve is the shelf the kernel is running
 * right now, drawn from the same coefficient builder, with the Amount's
 * maximum depth ghosted behind it so the headroom left is visible.
 */
import { computed, onMounted } from 'vue'
import { useHFSoftener } from '../../composables/useHFSoftener.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  amountToMaxDepthDb, amountToThresholdDb, softenerSections, RELEASE_MS_MIN, RELEASE_MS_MAX,
} from '../../audio/hfSoftenerProcessor.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hfAmount, hfContext, hfRotator, hfRelease, hfVowelRelease, hfShape, hfListen, hfPreview,
  hfReduction, hfThresholdLift, hfInputLevels, hfOutputLevels,
  togglePreview, syncAmount, syncContext, syncRotator, syncRelease, syncVowelRelease, syncShape, syncListen,
  apply, teardown, closeModal,
} = useHFSoftener()

const { state } = useEditorState()

onMounted(() => {
  if (!hfPreview.value) togglePreview()
})

const ACCENT = '#e8b77f'

const SHAPE_OPTIONS = [
  { value: 'shelf', label: 'SHELF', title: 'Cut everything above 4.5 kHz — the spec’s original shape' },
  { value: 'band', label: 'BAND', title: 'Cut the sibilance band and return to flat above 11 kHz, so the air stays' },
]

const VOWEL_OPTIONS = [
  { value: true, label: 'ON', title: 'Let go within ~10 ms when a vowel starts, so the sound after an S is not dulled' },
  { value: false, label: 'OFF', title: 'Use the Release setting everywhere' },
]

const ROTATOR_OPTIONS = [
  { value: 'off', label: 'OFF', title: 'No phase rotation — the detector reads the raw signal' },
  { value: 'sidechain', label: 'SIDECHAIN', title: 'Rotate the detector only; the audio stays phase-intact' },
  { value: 'inpath', label: 'IN-PATH', title: 'Rotate the audio too — a character choice, and not safe to sum with a double or second mic' },
]

const LISTEN_OPTIONS = [
  { value: 'off', label: 'OFF', title: 'Hear the processed output' },
  { value: 'delta', label: 'DELTA', title: 'Hear only what is being removed — it should sound like sibilance and nothing else' },
  { value: 'sidechain', label: 'SIDECHAIN', title: 'Hear what the detector hears' },
]

// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 360
const CURVE_H = 96
const F_MIN = 100
const F_MAX = 20000
const DB_MIN = -10

const CURVE_FREQS = Array.from({ length: 160 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 159),
)
const GRID_FREQS = [100, 1000, 4500, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  // 0 dB on the top edge; the shelf only ever cuts.
  return (db / DB_MIN) * CURVE_H
}

function shelfPath(gainDb) {
  const sr = state.currentFile?.sampleRate ?? 44100
  const db = magnitudeResponseDb(softenerSections(sr, gainDb, hfShape.value), CURVE_FREQS, sr)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${Math.max(0.5, yFor(db[i])).toFixed(1)}`,
  ).join(' ')
}

const maxDepthDb = computed(() => amountToMaxDepthDb(hfAmount.value / 100))
const maxPath = computed(() => shelfPath(-maxDepthDb.value))
const livePath = computed(() => shelfPath(-Math.min(hfReduction.value, maxDepthDb.value)))
const liveFill = computed(() => `${livePath.value} L${CURVE_W},0 L0,0 Z`)

const thresholdLabel = computed(() => {
  const t = amountToThresholdDb(hfAmount.value / 100)
  return hfAmount.value === 0 ? 'OFF' : `${t.toFixed(0)} dBFS`
})

function formatMs(v) {
  return `${Math.round(v)} ms`
}

function formatPct(v) {
  return `${Math.round(v)}%`
}

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

function gridLabelStyle(freqHz) {
  if (freqHz <= F_MIN) return { left: '0%', transform: 'none' }
  if (freqHz >= F_MAX) return { left: '100%', transform: 'translateX(-100%)' }
  return { left: `${(xFor(freqHz) / CURVE_W) * 100}%`, transform: 'translateX(-50%)' }
}

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

function segStyle(active, disabled) {
  return [
    {
      padding: '7px 10px', borderRadius: '8px',
      font: "700 8.5px 'JetBrains Mono',monospace", letterSpacing: '.12em',
      transition: 'background-color .15s ease, border-color .15s ease',
    },
    active
      ? {
        background: `color-mix(in srgb, ${ACCENT} 20%, transparent)`,
        border: `1px solid color-mix(in srgb, ${ACCENT} 55%, transparent)`,
        color: ACCENT,
      }
      : { background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', color: 'rgba(255,255,255,.7)' },
    disabled ? { opacity: 0.35 } : { opacity: 1 },
  ]
}
</script>

<template>
  <FloatingWindow
    window-id="hf-softener"
    :z="z"
    :width="620"
    :accent="ACCENT"
    brand-lead="HF"
    brand-tail="SOFTENER"
    :engaged="hfPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!hfPreview"
    apply-disabled-hint="Turn HF Softener on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <!-- 12 dB full scale: the deepest the shelf can go is 9 dB. -->
      <GainReductionBar :reduction-db="-hfReduction" :accent="ACCENT" :full-scale-db="12" title="SHELF DEPTH" />

      <div class="flex items-center justify-between gap-[22px] mt-[18px]">
        <LevelMeter :levels="hfInputLevels" label="IN" :height="150" />

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
            <line :x1="0" :y1="0.5" :x2="CURVE_W" :y2="0.5" stroke="rgba(255,255,255,.14)" stroke-width="1" />
            <path :d="maxPath" :stroke="ACCENT" stroke-opacity="0.3" stroke-dasharray="3 3" stroke-width="1.5" fill="none" />
            <path :d="liveFill" :fill="ACCENT" fill-opacity="0.12" />
            <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
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

          <div class="flex gap-[22px] mt-[16px]">
            <div class="w-[112px] flex flex-col items-center">
              <Knob
                :model-value="hfAmount"
                @update:model-value="syncAmount"
                :min="0" :max="100" :step="1"
                label="Amount" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ thresholdLabel }} · {{ maxDepthDb.toFixed(1) }} dB
              </span>
            </div>
            <div class="w-[112px] flex flex-col items-center">
              <Knob
                :model-value="hfContext"
                @update:model-value="syncContext"
                :min="0" :max="100" :step="1"
                label="Context" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
              />
              <!-- Deliberately unsmoothed: with Context up, the same sibilant
                   is treated differently by phrase, and the readout says so. -->
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                +{{ hfThresholdLift.toFixed(1) }} dB LIFT
              </span>
            </div>
            <div class="w-[112px] flex flex-col items-center">
              <!-- Log travel: the useful choices are 20–60 ms, and a linear
                   knob would spend two thirds of its sweep above that. -->
              <Knob
                :model-value="hfRelease"
                @update:model-value="syncRelease"
                :min="RELEASE_MS_MIN" :max="RELEASE_MS_MAX" :step="1" scale="log"
                label="Release" :accent="ACCENT" :format-value="formatMs" :value-font-px="15"
                :disabled="!hfPreview"
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ hfVowelRelease ? 'OUTSIDE VOWELS' : 'EVERYWHERE' }}
              </span>
            </div>
          </div>
        </div>

        <LevelMeter :levels="hfOutputLevels" label="OUT" :height="150" />
      </div>

      <div class="flex justify-center gap-[48px] mt-[20px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">SHAPE</span>
          <DeviceChoiceRocker
            :model-value="hfShape" :options="SHAPE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Cut shape"
            @update:model-value="syncShape"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">VOWEL RELEASE</span>
          <DeviceChoiceRocker
            :model-value="hfVowelRelease" :options="VOWEL_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Vowel release"
            @update:model-value="syncVowelRelease"
          />
        </div>
      </div>

      <div class="flex justify-center gap-[36px] mt-[18px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">ROTATOR</span>
          <div class="flex gap-[6px]" role="radiogroup" aria-label="Phase rotator routing">
            <button
              v-for="o in ROTATOR_OPTIONS" :key="o.value"
              type="button" role="radio" :aria-checked="hfRotator === o.value"
              :title="o.title" :disabled="!hfPreview"
              class="cursor-pointer disabled:cursor-not-allowed"
              :style="segStyle(hfRotator === o.value, !hfPreview)"
              @click="syncRotator(o.value)"
            >{{ o.label }}</button>
          </div>
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">LISTEN</span>
          <div class="flex gap-[6px]" role="radiogroup" aria-label="Monitor">
            <button
              v-for="o in LISTEN_OPTIONS" :key="o.value"
              type="button" role="radio" :aria-checked="hfListen === o.value"
              :title="o.title" :disabled="!hfPreview"
              class="cursor-pointer disabled:cursor-not-allowed"
              :style="segStyle(hfListen === o.value, !hfPreview)"
              @click="syncListen(o.value)"
            >{{ o.label }}</button>
          </div>
        </div>
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Dips the sibilance band only while a consonant spikes, and lets go as the
        next vowel starts. Breath and air pass untouched. Listen stays off when you apply.
      </p>
    </div>
  </FloatingWindow>
</template>
