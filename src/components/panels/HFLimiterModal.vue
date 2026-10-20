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
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { shelfResponseDb } from '../../audio/dsp/hfLimit.js'
import {
  FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TAIL_MIN_MS, TAIL_MAX_MS, TRANSIENT_MAX_DB,
} from '../../audio/hfLimiterParams.js'
import {
  HF_LIMITER_DEFAULTS,
} from '../../audio/hfLimiterParams.js'
import {
  HF_LIMITER_PRESET_PLUGIN, HF_LIMITER_PARAM_KEYS, HF_LIMITER_OUTPUT_MIN_DB, HF_LIMITER_OUTPUT_MAX_DB,
} from '../../audio/pluginPresets/hfLimiter.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hflParams, hflPreview, hflDelta, hflReduction, hflTransient,
  hflInputLevels, hflOutputLevels,
  togglePreview, syncParam, applyParams, toggleDelta, apply, teardown, closeModal,
} = useHFLimiter()

const presets = usePluginPresets(HF_LIMITER_PRESET_PLUGIN, {
  read: () => Object.fromEntries(HF_LIMITER_PARAM_KEYS.map(k => [k, hflParams[k]])),
  write: p => applyParams(p),
})

const D = HF_LIMITER_DEFAULTS

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!hflPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 214

// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 420
const CURVE_H = 132
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

const fmtFreq = v => (v >= 10000 ? `${(v / 1000).toFixed(1)}k Hz` : `${(v / 1000).toFixed(2)}k Hz`)
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtRange = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)
const fmtMs = v => `${Math.round(v)} ms`
const fmtTail = v => (v < TAIL_MIN_MS ? 'OFF' : `${Math.round(v)} ms`)
/** Typed entry for Freq: "6.5k" or "6500". */
function parseHz(t) {
  const m = String(t).trim().match(/^(-?\d*\.?\d+)\s*(k)?/i)
  if (!m) return NaN
  return parseFloat(m[1]) * (m[2] ? 1000 : 1)
}

const SHAPE_OPTIONS = [
  { value: 'tight', label: 'TIGHT', title: 'A one-octave, linear-phase split: a ceiling on the band above Freq, leaving everything below it alone' },
  { value: 'warm', label: 'WARM', title: 'A gentle 6 dB/oct split, the EL7 Fatso’s Warmth: the whole top end tilts down, starting an octave or more below Freq' },
]
const fmtTransient = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)

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
    :width="760"
    :accent="ACCENT"
    design="modula"
    brand-lead="HF LIMITER"
    :presets="presets"
    :presets-disabled="!hflPreview"
    presets-disabled-hint="Turn HF Limiter on to use presets"
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
    <div class="hl-grid">
      <div class="hl-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="hflInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="hl-display">
        <GainReductionBar
          :reduction-db="-hflReduction" :accent="ACCENT"
          :full-scale-db="RANGE_MAX_DB" ballistics="none" title="HF REDUCTION"
        />

        <!-- The shelf the kernel is running right now, with the deepest cut
             RANGE allows ghosted behind it and FREQ dashed. -->
        <div>
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="hl-well"
            :style="{ height: `${CURVE_H}px` }"
            preserveAspectRatio="none"
          >
            <line
              v-for="f in GRID_FREQS" :key="f"
              :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
              stroke="rgba(255,255,255,.07)" stroke-width="1"
            />
            <line :x1="0" :y1="0.5" :x2="CURVE_W" :y2="0.5" stroke="rgba(255,255,255,.16)" stroke-width="1" />
            <line
              :x1="xFor(hflParams.freq)" :y1="0" :x2="xFor(hflParams.freq)" :y2="CURVE_H"
              :stroke="ACCENT" stroke-opacity=".4" stroke-width="1" stroke-dasharray="3 3"
            />
            <path :d="floorPath" stroke="rgba(255,255,255,.26)" stroke-width="1.2" fill="none" stroke-dasharray="4 3" />
            <path :d="liveFill" :fill="ACCENT" fill-opacity="0.14" />
            <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="hl-axis">
            <span
              v-for="f in GRID_FREQS" :key="f"
              :style="{
                left: `${(xFor(f) / CURVE_W) * 100}%`,
                transform: f >= F_MAX ? 'translateX(-100%)' : 'translateX(-50%)',
              }"
            >{{ gridLabel(f) }}</span>
          </div>
        </div>

        <div class="hl-shape">
          <span class="m-caption">Shape</span>
          <ModulaSegmented
            :model-value="hflParams.shape" :options="SHAPE_OPTIONS"
            aria-label="Shape" :disabled="!hflPreview"
            @update:model-value="v => syncParam('shape', v)"
          />
        </div>
      </div>

      <div class="hl-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="hflOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="hflParams.output" show-value
              :min="HF_LIMITER_OUTPUT_MIN_DB" :max="HF_LIMITER_OUTPUT_MAX_DB" :step="0.1"
              :default-value="D.output" :format-value="fmtDb"
              aria-label="Output" :disabled="!hflPreview"
              title="Output: a trim after the limiter. Double-click to reset"
              @update:model-value="v => syncParam('output', v)"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <!-- The shelf's four controls, then the slow tail and the onset softener. -->
    <div class="hl-knobs">
      <ModulaKnob
        variant="small" :size="52" show-value editable :parse-value="parseHz"
        :model-value="hflParams.freq" :min="FREQ_MIN_HZ" :max="FREQ_MAX_HZ" :step="10" scale="log"
        :default-value="D.freq" label="Freq" :color="ACCENT" :format-value="fmtFreq" :disabled="!hflPreview"
        title="Where bright starts: the band above this is what the limiter listens to and turns down. Double-click to reset"
        @update:model-value="v => syncParam('freq', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="hflParams.threshold" :min="THRESHOLD_MIN_DB" :max="THRESHOLD_MAX_DB" :step="0.5"
        :default-value="D.threshold" label="Threshold" :color="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
        title="Where the band is held, dB relative to the file's voice level — the same setting does the same thing on a quiet recording and a hot one. Double-click to reset"
        @update:model-value="v => syncParam('threshold', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable :parse-value="t => Math.abs(parseFloat(t))"
        :model-value="hflParams.range" :min="0" :max="RANGE_MAX_DB" :step="0.5"
        :default-value="D.range" label="Range" :color="ACCENT" :format-value="fmtRange" :disabled="!hflPreview"
        title="The deepest the shelf may cut. Keeps a hard S from turning into a lisp; 0 takes the shelf out. Double-click to reset"
        @update:model-value="v => syncParam('range', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="hflParams.release" :min="RELEASE_MIN_MS" :max="RELEASE_MAX_MS" :step="1" scale="log"
        :default-value="D.release" label="Release" :color="ACCENT" :format-value="fmtMs" :disabled="!hflPreview"
        title="How quickly the top comes back after a bright moment. Double-click to reset"
        @update:model-value="v => syncParam('release', v)"
      />
      <span class="hl-rule" aria-hidden="true"></span>
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="hflParams.tail" :min="0" :max="TAIL_MAX_MS" :step="5"
        :default-value="D.tail" label="Tail" :color="ACCENT" :format-value="fmtTail" :disabled="!hflPreview"
        title="A slow second release stage. A sustained bright passage charges it and the top comes back over this long; a single click barely does and recovers at the Release speed. Fully down is OFF, a single-stage release. Double-click to reset"
        @update:model-value="v => syncParam('tail', v)"
      />
      <div class="hl-transient">
        <ModulaKnob
          variant="small" :size="52" show-value editable :parse-value="t => Math.abs(parseFloat(t))"
          :model-value="hflParams.transient" :min="0" :max="TRANSIENT_MAX_DB" :step="0.5"
          :default-value="D.transient" label="Transient" :color="ACCENT" :format-value="fmtTransient" :disabled="!hflPreview"
          title="Extra cut on sudden bright onsets — clicks, lip smacks, T, K and P bursts — even below the threshold, for a few milliseconds. Reacts to how suddenly the top end rises, not how loud it is, so a steady S is left to the shelf. Stacks on top of the shelf; 0 is off. Double-click to reset"
          @update:model-value="v => syncParam('transient', v)"
        />
        <!-- Lights while the onset softener cuts (full at 6 dB). -->
        <span
          class="hl-lamp"
          :style="{
            background: ACCENT,
            opacity: 0.12 + 0.88 * lamp,
            boxShadow: lamp > 0.05 ? `0 0 ${6 * lamp}px ${ACCENT}` : 'none',
          }"
          aria-hidden="true"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.hl-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.hl-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.hl-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.hl-well {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.hl-axis {
  position: relative;
  height: 10px;
  margin-top: 4px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.hl-axis span { position: absolute; top: 0; }
.hl-shape {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.hl-knobs {
  margin-top: 12px;
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  gap: 8px;
  padding: 14px 12px 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.hl-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
.hl-transient { position: relative; }
.hl-lamp {
  position: absolute;
  top: 0;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
</style>
