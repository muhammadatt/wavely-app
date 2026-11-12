<script setup>
/**
 * The Saturation Bench's pre-emphasis as a response plot: the curve is the
 * filter the layer's curve is fed through (the de-emphasis after it is its exact
 * inverse), and the node on it IS Freq and Gain — drag it sideways for the
 * corner, up and down for the gain, scroll over it for Q. It replaces three
 * knobs with one picture that shows what they do together.
 *
 * Bypassed, the curve is dashed and the node hollow: it still shows the filter
 * that WOULD run, so the bypass reads as "this is switched out", not "this is
 * flat".
 *
 * Emits `change` with only the fields that moved, as the layer's own names.
 */
import { computed, ref } from 'vue'
import { emphasisSections, SAT_EMPH_HZ_MIN, SAT_EMPH_HZ_MAX, SAT_EMPH_Q_MIN, SAT_EMPH_Q_MAX, SAT_EMPH_DB_MAX } from '../../audio/dsp/saturationLayers.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import { clamp01, valueToPct, pctToValue } from '../knobs/knobGeometry.js'

const props = defineProps({
  type: { type: String, default: 'hishelf' },
  hz: { type: Number, required: true },
  q: { type: Number, required: true },
  db: { type: Number, required: true },
  /** false: the pair is bypassed. */
  on: { type: Boolean, default: true },
  sampleRate: { type: Number, default: 44100 },
  color: { type: String, default: '#e8a33d' },
  disabled: { type: Boolean, default: false },
  /** `{ hz, q, db }` — where double-click goes back to. */
  defaults: { type: Object, default: null },
  /** The plot's own coordinate width: with the fixed height it sets the aspect, not the size on screen. */
  width: { type: Number, default: 340 },
})
const emit = defineEmits(['change'])

const W = props.width
const H = 104
const F_MIN = 50
const F_MAX = 20000
const DB_SPAN = SAT_EMPH_DB_MAX + 3 // headroom for a bell's overshoot at high Q

const xFor = f => valueToPct(f, F_MIN, F_MAX, 'log') * W
const yFor = db => H / 2 - (Math.max(-DB_SPAN, Math.min(DB_SPAN, db)) / DB_SPAN) * (H / 2)

const FREQS = Array.from({ length: 140 }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / 139))
const GRID_F = [100, 1000, 10000]
const GRID_DB = [-12, 0, 12]

const path = computed(() => {
  const pair = emphasisSections(props.type, props.hz, props.q, props.db, props.sampleRate)
  const resp = pair ? magnitudeResponseDb(pair.pre, FREQS, props.sampleRate) : null
  return FREQS.map((f, i) => `${i ? 'L' : 'M'}${xFor(f).toFixed(1)},${yFor(resp ? resp[i] : 0).toFixed(1)}`).join(' ')
})

const nodeX = computed(() => xFor(props.hz))
const nodeY = computed(() => yFor(props.db))

function quantHz(v) {
  const step = v >= 1000 ? 100 : v >= 100 ? 10 : 1
  return Math.round(v / step) * step
}
const round = (v, s) => Number((Math.round(v / s) * s).toFixed(6))

const svg = ref(null)
const dragging = ref(false)

function pointAt(e) {
  const r = svg.value.getBoundingClientRect()
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
}

function moveTo(e) {
  const { x, y } = pointAt(e)
  const hz = quantHz(Math.max(SAT_EMPH_HZ_MIN, Math.min(SAT_EMPH_HZ_MAX, pctToValue(clamp01(x), F_MIN, F_MAX, 'log'))))
  let db = round(((0.5 - clamp01(y)) * 2) * DB_SPAN, 0.5)
  db = Math.max(-SAT_EMPH_DB_MAX, Math.min(SAT_EMPH_DB_MAX, db))
  const fields = {}
  if (hz !== props.hz) fields.emphHz = hz
  if (db !== props.db) fields.emphDb = db
  if (Object.keys(fields).length) emit('change', fields)
}

function down(e) {
  if (props.disabled || e.button > 0) return
  e.preventDefault()
  dragging.value = true
  svg.value.setPointerCapture?.(e.pointerId)
  svg.value.focus?.({ preventScroll: true })
  moveTo(e)
}
function move(e) { if (dragging.value) moveTo(e) }
function up(e) {
  dragging.value = false
  try { svg.value.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
}

/** Scroll = Q, 5 % a notch, on the log scale the knob had. */
function wheel(e) {
  if (props.disabled) return
  e.preventDefault()
  const q = Math.max(SAT_EMPH_Q_MIN, Math.min(SAT_EMPH_Q_MAX, props.q * (e.deltaY < 0 ? 1.05 : 1 / 1.05)))
  const next = round(q, 0.01)
  if (next !== props.q) emit('change', { emphQ: next })
}

function key(e) {
  if (props.disabled) return
  const fine = e.shiftKey ? 0.2 : 1
  let fields = null
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const hz = quantHz(Math.max(SAT_EMPH_HZ_MIN, Math.min(SAT_EMPH_HZ_MAX, props.hz * Math.pow(2, (dir * fine) / 6))))
    fields = { emphHz: hz }
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const dir = e.key === 'ArrowUp' ? 1 : -1
    fields = { emphDb: Math.max(-SAT_EMPH_DB_MAX, Math.min(SAT_EMPH_DB_MAX, round(props.db + dir * 0.5 * (e.shiftKey ? 1 : 2), 0.5))) }
  } else if (e.key === 'PageUp' || e.key === 'PageDown') {
    const q = props.q * (e.key === 'PageUp' ? 1.1 : 1 / 1.1)
    fields = { emphQ: round(Math.max(SAT_EMPH_Q_MIN, Math.min(SAT_EMPH_Q_MAX, q)), 0.01) }
  }
  if (fields) { e.preventDefault(); emit('change', fields) }
}

function reset() {
  const d = props.defaults
  if (props.disabled || !d) return
  emit('change', { emphHz: d.hz, emphQ: d.q, emphDb: d.db })
}

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}
</script>

<template>
  <div class="ep" :class="{ 'is-disabled': disabled }">
    <svg
      ref="svg" class="ep-well m-focusable" :viewBox="`0 0 ${W} ${H}`"
      role="slider" tabindex="0" aria-label="Pre-emphasis frequency and gain"
      :aria-valuetext="`${Math.round(hz)} Hz, ${db} dB, Q ${q}`"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"
      @wheel="wheel" @keydown="key" @dblclick="reset"
    >
      <line
        v-for="f in GRID_F" :key="f"
        :x1="xFor(f)" y1="0" :x2="xFor(f)" :y2="H" stroke="rgba(255,255,255,.07)" stroke-width="1"
      />
      <line
        v-for="d in GRID_DB" :key="d"
        x1="0" :y1="yFor(d)" :x2="W" :y2="yFor(d)"
        :stroke="d === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.06)'" stroke-width="1"
      />
      <path
        :d="path" fill="none" :stroke="color" stroke-width="2"
        :stroke-dasharray="on ? null : '5 4'" :stroke-opacity="on ? 1 : .55"
      />
      <line
        :x1="nodeX" y1="0" :x2="nodeX" :y2="H"
        :stroke="color" stroke-opacity=".3" stroke-width="1" stroke-dasharray="3 3"
      />
      <circle
        :cx="nodeX" :cy="nodeY" r="6"
        :fill="on ? color : '#0b0e13'" :stroke="color" stroke-width="2" class="ep-node"
      />
    </svg>
    <div class="ep-axis">
      <span v-for="f in GRID_F" :key="f" :style="{ left: `${(xFor(f) / W) * 100}%` }">{{ gridLabel(f) }}</span>
    </div>
  </div>
</template>

<style scoped>
.ep { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; transition: opacity .15s ease; }
.ep.is-disabled { opacity: .4; pointer-events: none; }
.ep-well {
  /* Fills whatever width the strip leaves and keeps its aspect, so opening the
     editor can never make the row wider than it was shut. */
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
  cursor: crosshair;
  touch-action: none;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.ep-node { cursor: grab; }
.ep-axis { position: relative; height: 10px; font: 600 8px/1 var(--m-font-mono); letter-spacing: .08em; color: var(--m-ink-4); }
.ep-axis span { position: absolute; top: 0; transform: translateX(-50%); }
</style>
