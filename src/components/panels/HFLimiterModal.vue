<script setup>
/**
 * Hi-Freq Limiter (registry id `hf-limiter`; code identifiers keep "HF").
 *
 * SHELF is a lookahead dynamic shelf that holds the band above FREQ at the
 * THRESHOLD (relative to the file's voice level), never deeper than RANGE, and
 * lets go over RELEASE. SHAPE picks the split: TIGHT is a one-octave
 * linear-phase ceiling, WARM the EL7 Fatso's 6 dB/oct one-pole tilt. TRANSIENT
 * deepens the same cut for a few milliseconds on sudden onsets — clicks, lip
 * smacks, t/k/p bursts, even below THRESHOLD — up to its own depth, stacked on
 * the shelf's; 0 is off. Read dsp/hfLimit.js for the design.
 *
 * LAYOUT is redesign 3b (`docs/design/hf-limiter/HF_Limiter_Redesign.dc.html`,
 * owner, November 2026): priority reads top-left to bottom-right — THRESHOLD
 * (the large ticks knob) and SHAPE on the left, the curve in the middle, FREQ
 * and RANGE in their own column beside it; TRANSIENT, RELEASE, OUTPUT and the
 * slim IN / OUT pair in one quieter strip below. Every value is an amber LCD
 * (click it to type). The amber node on the curve drags too: left / right is
 * FREQ, up / down is RANGE.
 *
 * ⚠ TAIL IS OFF THE PANEL (the redesign removed it). The param, the kernel
 * stage and presets still carry it; its default, 0, is a single-stage release.
 *
 * The curve is the shelf the kernel is running right now, from the same split
 * it runs, with the deepest cut RANGE allows ghosted behind it. The lamp by
 * TRANSIENT lights while the onset softener cuts (full at 6 dB). DELTA plays
 * only what was removed and never reaches the apply path.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useHFLimiter } from '../../composables/useHFLimiter.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { shelfResponseDb } from '../../audio/dsp/hfLimit.js'
import {
  HF_LIMITER_DEFAULTS, FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TRANSIENT_MAX_DB,
} from '../../audio/hfLimiterParams.js'
import {
  HF_LIMITER_PRESET_PLUGIN, HF_LIMITER_OUTPUT_MIN_DB, HF_LIMITER_OUTPUT_MAX_DB,
} from '../../audio/pluginPresets/hfLimiter.js'
import { hfLimiterSettings } from '../../composables/pluginSettings.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import HFLimiterLcd from './HFLimiterLcd.vue'

defineProps({ z: { type: Number, default: 500 } })

const pluginApi = useHFLimiter()
const {
  hflParams, hflPreview, hflDelta, hflReduction, hflTransient,
  hflInputLevels, hflOutputLevels,
  togglePreview, syncParam, toggleDelta, apply, teardown, closeModal,
} = pluginApi

const presets = usePluginPresets(HF_LIMITER_PRESET_PLUGIN, hfLimiterSettings(pluginApi))

const D = HF_LIMITER_DEFAULTS

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!hflPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const IO_METER_LEN = 98

// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 420
const CURVE_H = 132
/** Drawn height, px: 3b's taller curve (the viewBox stretches to it). */
const CURVE_PX = 200
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

// ── The drag node: on the RANGE floor at FREQ ───────────────────────────────
const node = computed(() => {
  const [db] = shelfResponseDb(
    sampleRate.value, hflParams.freq, Math.pow(10, -hflParams.range / 20), [hflParams.freq], hflParams.shape,
  )
  return {
    left: `${(xFor(hflParams.freq) / CURVE_W) * 100}%`,
    top: `${(yFor(db) / CURVE_H) * 100}%`,
  }
})

/**
 * Left / right moves FREQ (on the curve's own log axis), up / down moves RANGE,
 * both RELATIVE to where the drag started: the node sits on the shelf's response
 * AT Freq, not at the full Range, so mapping the pointer's absolute position
 * would jump the setting on the first press (WARM, Range 12 → ~2.5).
 */
function onCurveDown(e) {
  if (!hflPreview.value || e.button > 0) return
  e.preventDefault()
  const rect = e.currentTarget.getBoundingClientRect()
  const x0 = e.clientX, y0 = e.clientY
  const freq0 = hflParams.freq, range0 = hflParams.range
  const set = ev => {
    const octaves = ((ev.clientX - x0) / rect.width) * Math.log2(F_MAX / F_MIN)
    const freq = Math.round(clampTo(freq0 * Math.pow(2, octaves), FREQ_MIN_HZ, FREQ_MAX_HZ) / 10) * 10
    const range = Math.round(clampTo(range0 + ((ev.clientY - y0) / rect.height) * RANGE_MAX_DB, 0, RANGE_MAX_DB) * 2) / 2
    if (freq !== hflParams.freq) syncParam('freq', freq)
    if (range !== hflParams.range) syncParam('range', range)
  }
  const up = () => {
    window.removeEventListener('pointermove', set)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', set)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

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

const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmtFreq = v => (v >= 10000 ? `${(v / 1000).toFixed(1)}k Hz` : `${(v / 1000).toFixed(2)}k Hz`)
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtRange = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)
const fmtMs = v => `${Math.round(v)} ms`
const fmtTransient = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)
/** Typed entry for Freq: "6.5k" or "6500". */
function parseHz(t) {
  const m = String(t).trim().match(/^(-?\d*\.?\d+)\s*(k)?/i)
  if (!m) return NaN
  return parseFloat(m[1]) * (m[2] ? 1000 : 1)
}
/** Range and Transient are cuts: "-6", "6" and "−6" all mean 6 dB. */
const parseCut = t => Math.abs(parseFloat(t))

/** A typed value, clamped to the knob's travel (the LCD has no range of its own). */
function typed(key, lo, hi, step) {
  return v => syncParam(key, clampTo(Math.round(v / step) * step, lo, hi))
}

const SHAPE_OPTIONS = [
  { value: 'tight', label: 'TIGHT', title: 'A one-octave, linear-phase split: a ceiling on the band above Freq, leaving everything below it alone' },
  { value: 'warm', label: 'WARM', title: 'A gentle 6 dB/oct split, the EL7 Fatso’s Warmth: the whole top end tilts down, starting an octave or more below Freq' },
]

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
    brand-lead="HI-FREQ LIMITER"
    :presets="presets"
    :presets-disabled="!hflPreview"
    presets-disabled-hint="Turn Hi-Freq Limiter on to use presets"
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
    apply-disabled-hint="Turn Hi-Freq Limiter on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="hl">
      <div class="hl-top">
        <!-- THRESHOLD, the main control, then SHAPE. -->
        <div class="hl-left">
          <span class="hl-cap">Threshold</span>
          <ModulaKnob
            data-help="threshold"
            variant="ticks" :size="104"
            :model-value="hflParams.threshold" :min="THRESHOLD_MIN_DB" :max="THRESHOLD_MAX_DB" :step="0.5"
            :default-value="D.threshold" aria-label="Threshold" :color="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
            title="Where the band is held, relative to the file's voice level"
            @update:model-value="v => syncParam('threshold', v)"
          />
          <HFLimiterLcd
            :text="fmtDb(hflParams.threshold)" aria-label="Threshold" :disabled="!hflPreview"
            @commit="typed('threshold', THRESHOLD_MIN_DB, THRESHOLD_MAX_DB, 0.5)($event)"
          />
          <div class="hl-shape" data-help="shape">
            <span class="hl-cap">Shape</span>
            <ModulaSegmented
              :model-value="hflParams.shape" :options="SHAPE_OPTIONS"
              aria-label="Shape" :disabled="!hflPreview"
              @update:model-value="v => syncParam('shape', v)"
            />
          </div>
        </div>

        <!-- The meter and the shelf the kernel is running right now, with the
             deepest cut RANGE allows ghosted behind it and FREQ dashed. -->
        <div class="hl-display">
          <GainReductionBar
            data-help="meter"
            :reduction-db="-hflReduction" :accent="ACCENT"
            :full-scale-db="RANGE_MAX_DB" ballistics="none" title="HF REDUCTION"
          />
          <div data-help="curve">
            <div
              class="hl-curve" :class="{ 'is-disabled': !hflPreview }"
              title="Drag: left / right moves Freq, up / down moves Range"
              @pointerdown="onCurveDown"
            >
              <svg
                :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
                class="hl-well"
                :style="{ height: `${CURVE_PX}px` }"
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
              <span class="hl-node" :style="node" aria-hidden="true"></span>
            </div>
            <div class="hl-axis">
              <span
                v-for="f in GRID_FREQS.slice(0, -1)" :key="f"
                :style="{ left: `${(xFor(f) / CURVE_W) * 100}%`, transform: 'translateX(-50%)' }"
              >{{ gridLabel(f) }}</span>
              <span :style="{ left: '100%', transform: 'translateX(-100%)' }">{{ gridLabel(F_MAX) }}</span>
            </div>
          </div>
        </div>

        <!-- FREQ and RANGE: the band, in a column beside the curve they change. -->
        <div class="hl-right">
          <div class="hl-ctl" data-help="freq">
            <ModulaKnob
              variant="halo" :size="72"
              :model-value="hflParams.freq" :min="FREQ_MIN_HZ" :max="FREQ_MAX_HZ" :step="10" scale="log"
              :default-value="D.freq" aria-label="Freq" :color="ACCENT" :format-value="fmtFreq" :disabled="!hflPreview"
              title="Where bright starts: the band above it is what the limiter turns down"
              @update:model-value="v => syncParam('freq', v)"
            />
            <span class="hl-cap">Freq</span>
            <HFLimiterLcd
              :text="fmtFreq(hflParams.freq)" :edit-text="String(hflParams.freq)" :parse="parseHz" aria-label="Freq" :disabled="!hflPreview"
              @commit="typed('freq', FREQ_MIN_HZ, FREQ_MAX_HZ, 10)($event)"
            />
          </div>
          <div class="hl-ctl" data-help="range">
            <ModulaKnob
              variant="halo" :size="72"
              :model-value="hflParams.range" :min="0" :max="RANGE_MAX_DB" :step="0.5"
              :default-value="D.range" aria-label="Range" :color="ACCENT" :format-value="fmtRange" :disabled="!hflPreview"
              title="The deepest the shelf may cut; 0 takes the shelf out"
              @update:model-value="v => syncParam('range', v)"
            />
            <span class="hl-cap">Range</span>
            <HFLimiterLcd
              :text="fmtRange(hflParams.range)" :parse="parseCut" aria-label="Range" :disabled="!hflPreview"
              @commit="typed('range', 0, RANGE_MAX_DB, 0.5)($event)"
            />
          </div>
        </div>
      </div>

      <span class="hl-rule" aria-hidden="true"></span>

      <!-- The quieter strip: TRANSIENT, RELEASE, OUTPUT, then IN / OUT. -->
      <div class="hl-bottom">
        <div class="hl-item" data-help="transient">
          <ModulaKnob
            variant="halo" :size="52"
            :model-value="hflParams.transient" :min="0" :max="TRANSIENT_MAX_DB" :step="0.5"
            :default-value="D.transient" aria-label="Transient" :color="ACCENT" :format-value="fmtTransient" :disabled="!hflPreview"
            title="Extra cut on sudden bright onsets; 0 is off"
            @update:model-value="v => syncParam('transient', v)"
          />
          <div class="hl-item-text">
            <span class="hl-cap hl-cap--mono">
              Transient
              <!-- Lights while the onset softener cuts (full at 6 dB). -->
              <span
                class="hl-lamp"
                :style="{ opacity: 0.12 + 0.88 * lamp, boxShadow: lamp > 0.05 ? `0 0 ${6 * lamp}px ${ACCENT}` : 'none' }"
                aria-hidden="true"
              />
            </span>
            <HFLimiterLcd
              :text="fmtTransient(hflParams.transient)" :parse="parseCut" aria-label="Transient" :disabled="!hflPreview"
              @commit="typed('transient', 0, TRANSIENT_MAX_DB, 0.5)($event)"
            />
          </div>
        </div>
        <div class="hl-item" data-help="release">
          <ModulaKnob
            variant="halo" :size="52"
            :model-value="hflParams.release" :min="RELEASE_MIN_MS" :max="RELEASE_MAX_MS" :step="1" scale="log"
            :default-value="D.release" aria-label="Release" :color="ACCENT" :format-value="fmtMs" :disabled="!hflPreview"
            title="How quickly the top comes back after a bright moment"
            @update:model-value="v => syncParam('release', v)"
          />
          <div class="hl-item-text">
            <span class="hl-cap hl-cap--mono">Release</span>
            <HFLimiterLcd
              :text="fmtMs(hflParams.release)" aria-label="Release" :disabled="!hflPreview"
              @commit="typed('release', RELEASE_MIN_MS, RELEASE_MAX_MS, 1)($event)"
            />
          </div>
        </div>
        <div class="hl-item" data-help="output">
          <ModulaKnob
            variant="halo" :size="52" bipolar
            :model-value="hflParams.output" :min="HF_LIMITER_OUTPUT_MIN_DB" :max="HF_LIMITER_OUTPUT_MAX_DB" :step="0.1"
            :default-value="D.output" aria-label="Output" :color="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
            title="A trim after the limiter"
            @update:model-value="v => syncParam('output', v)"
          />
          <div class="hl-item-text">
            <span class="hl-cap hl-cap--mono">Output</span>
            <HFLimiterLcd
              :text="fmtDb(hflParams.output)" aria-label="Output" :disabled="!hflPreview"
              @commit="typed('output', HF_LIMITER_OUTPUT_MIN_DB, HF_LIMITER_OUTPUT_MAX_DB, 0.1)($event)"
            />
          </div>
        </div>
        <div class="hl-io" data-help="in-out">
          <LevelMeter variant="modula" slim label="IN" label-side="start" orientation="horizontal" :levels="hflInputLevels" :height="IO_METER_LEN" :show-scale="false" />
          <LevelMeter variant="modula" slim label="OUT" label-side="start" orientation="horizontal" :levels="hflOutputLevels" :height="IO_METER_LEN" :show-scale="false" />
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.hl {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 4px 0;
}
.hl-top {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr) 92px;
  gap: 22px;
  align-items: start;
}
.hl-cap {
  font: 600 10px/1 Inter, system-ui, sans-serif;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: #b6bdc4;
  margin-right: -.14em;
  white-space: nowrap;
}
.hl-cap--mono {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font: 500 9px/1 var(--m-font-mono, 'JetBrains Mono', monospace);
  color: #a0a8b0;
  margin-right: 0;
}
.hl-left {
  align-self: end;
  padding-bottom: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.hl-shape {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.hl-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 2px;
}
.hl-curve {
  position: relative;
  cursor: crosshair;
  touch-action: none;
}
.hl-curve.is-disabled { cursor: default; }
.hl-well {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.hl-node {
  position: absolute;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: #e8a33d;
  box-shadow: 0 0 8px #e8a33d, 0 0 0 2px #0b0e13;
  pointer-events: none;
}
.hl-curve.is-disabled .hl-node { opacity: .4; box-shadow: 0 0 0 2px #0b0e13; }
.hl-axis {
  position: relative;
  height: 10px;
  margin-top: 4px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.hl-axis span { position: absolute; top: 0; }
.hl-right {
  align-self: end;
  padding-bottom: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.hl-ctl {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
}
.hl-rule {
  height: 1px;
  background: rgba(0, 0, 0, .3);
  box-shadow: 0 1px 0 rgba(255, 255, 255, .05);
}
.hl-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.hl-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hl-item-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
}
.hl-lamp {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e8a33d;
}
.hl-io {
  width: 196px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 9px 8px;
  border-radius: 9px;
  background: #1a1c20;
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .8), 0 1px 0 rgba(255, 255, 255, .05);
}
</style>
