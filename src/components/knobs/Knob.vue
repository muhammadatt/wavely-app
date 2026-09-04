<script setup>
import { computed, ref } from 'vue'

import {
  clamp01, valueToPct, pctToValue, bipolarOriginPct,
} from './knobGeometry.js'

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  label: { type: String, default: '' },
  accent: { type: String, default: '#f5a623' },
  formatValue: { type: Function, default: (v) => String(Math.round(v)) },
  disabled: { type: Boolean, default: false },
  // Driven by the plugin rather than the user (e.g. auto makeup owning the
  // Gain knob): not draggable, but stays fully lit because the value it is
  // showing is live and meaningful — unlike `disabled`, which dims.
  readonly: { type: Boolean, default: false },
  valueFontPx: { type: Number, default: 19 },
  // Fill the arc outward from the centre rather than up from the minimum. For a
  // cut/boost control, filling from the minimum lights half the ring at 0, so a
  // row of untouched knobs reads as a row of applied corrections.
  bipolar: { type: Boolean, default: false },
  /**
   * 'linear' | 'log'. Log spreads travel evenly per octave instead of per unit.
   * A frequency knob over 20 Hz–20 kHz is unusable linear: everything below
   * 200 Hz — where nearly every corrective move lives — lands in the first
   * degree of rotation, while half the sweep is spent above 10 kHz.
   * Requires a positive min.
   */
  scale: { type: String, default: 'linear' },
  /**
   * Rounding, when `step` is the wrong shape for the range. A log knob needs
   * precision that varies with magnitude (1 Hz at 80 Hz, 100 Hz at 12 kHz),
   * which a single absolute step cannot express.
   */
  quantize: { type: Function, default: null },
  /** Let the centre read-out be double-clicked and typed into. */
  editable: { type: Boolean, default: false },
  /**
   * Ride a bead on the head of the value arc as well as the cap's own mark.
   * Off by default: the cap mark and the bead sit on one radius, so two marks
   * are two readings of the same angle — worth it only where the arc is the
   * thing being watched.
   */
  arcHead: { type: Boolean, default: false },
  /**
   * How loud that bead is. 'bright' is 75% white with a 3px glow — brighter
   * than anything else on a faceplate, which is why it is not the default.
   * 'soft' is 22% white at a 2px glow; 'flush' is the accent itself with no
   * glow at all, so the bead reads as a thickening of the arc rather than as
   * a lamp.
   */
  beadTone: {
    type: String,
    default: 'soft',
    validator: (v) => ['bright', 'soft', 'flush'].includes(v),
  },
  /**
   * Width of the cap's raised rib, in the knob's own 100-unit space. 4.2 is
   * the settled value: at 3.3 the crown is too narrow to catch the light
   * along its length, and by 6.0 the mark is wider than it is long and reads
   * as a lozenge rather than as a pointer.
   */
  ribWidth: { type: Number, default: 4.2 },
})

const emit = defineEmits(['update:modelValue'])

const R = 42
const CIRCUMFERENCE = 2 * Math.PI * R
const ARC = 0.75 * CIRCUMFERENCE
const N_TICKS = 13

const isLog = computed(() =>
  props.scale === 'log' && props.min > 0 && props.max > props.min)

/** Value → fraction of travel. */
function toPct(v) {
  return valueToPct(v, props.min, props.max, props.scale)
}

/** Fraction of travel → value. */
function fromPct(p) {
  return pctToValue(p, props.min, props.max, props.scale)
}

const pct = computed(() => toPct(props.modelValue))

const trackDash = `${ARC.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`

/**
 * Where along the arc the fill starts, as a fraction: 0 normally, and where
 * ZERO falls when bipolar — not the arc's midpoint, which is only the same
 * thing on a symmetric range. See `bipolarOriginPct`.
 */
const origin = computed(() =>
  (props.bipolar ? bipolarOriginPct(props.min, props.max, props.scale) : 0))

const valDash = computed(() => {
  const len = Math.abs(pct.value - origin.value) * ARC
  return `${len.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`
})
const valDashOffset = computed(() => (-Math.min(pct.value, origin.value) * ARC).toFixed(1))
const indicatorDeg = computed(() => (225 + pct.value * 270).toFixed(1))

const ticks = computed(() => {
  const out = []
  for (let i = 0; i < N_TICKS; i++) {
    const t = i / (N_TICKS - 1)
    const ang = (135 + t * 270) * Math.PI / 180
    const rr1 = 48, rr2 = 44
    const lo = Math.min(pct.value, origin.value) - 0.0001
    const hi = Math.max(pct.value, origin.value) + 0.0001
    const on = t >= lo && t <= hi
    out.push({
      x1: (50 + rr1 * Math.cos(ang)).toFixed(2),
      y1: (50 + rr1 * Math.sin(ang)).toFixed(2),
      x2: (50 + rr2 * Math.cos(ang)).toFixed(2),
      y2: (50 + rr2 * Math.sin(ang)).toFixed(2),
      col: on ? props.accent : 'rgba(255,255,255,0.16)',
    })
  }
  return out
})

const valColor = computed(() => `color-mix(in srgb, ${props.accent} 60%, #ffffff)`)

// ── Cap mark ───────────────────────────────────────────────────────────────
// A raised rib machined into the cap, not a hole drilled through it: lit from
// above with a cast shadow below, in the cap's own metal rather than in the
// accent, so the indicator reads the same on every faceplate hue and does not
// compete with the lit arc for the eye.
const RIB_H = 4.9
const RIB_Y = 16.7

const rib = computed(() => {
  const w = props.ribWidth
  const sw = w + 0.3
  return {
    x: (50 - w / 2).toFixed(2), w: w.toFixed(2), r: (w / 2).toFixed(2),
    shadowX: (50 - sw / 2).toFixed(2), shadowW: sw.toFixed(2), shadowR: (sw / 2).toFixed(2),
  }
})

const BEAD = {
  bright: { r: 2.6, white: 75, glow: 3 },
  soft: { r: 2.2, white: 22, glow: 2 },
  flush: { r: 2.0, white: 0, glow: 0 },
}

/** The bead riding the end of the arc, when `arcHead` is on. */
const bead = computed(() => {
  const tone = BEAD[props.beadTone] ?? BEAD.soft
  const ang = (135 + pct.value * 270) * Math.PI / 180
  return {
    cx: (50 + R * Math.cos(ang)).toFixed(2),
    cy: (50 + R * Math.sin(ang)).toFixed(2),
    r: tone.r,
    fill: tone.white
      ? `color-mix(in srgb, ${props.accent} ${100 - tone.white}%, #ffffff)`
      : props.accent,
    style: tone.glow ? { filter: `drop-shadow(0 0 ${tone.glow}px ${props.accent})` } : {},
  }
})

// Drag-to-adjust: vertical drag, 150px traverses the full range
const DRAG_RANGE_PX = 150
const dragging = ref(false)
let dragStartY = 0
let dragStartPct = 0

function quantize(v) {
  const clamped = Math.max(props.min, Math.min(props.max, v))
  if (props.quantize) return props.quantize(clamped)
  const stepped = Math.round((clamped - props.min) / props.step) * props.step + props.min
  return Math.max(props.min, Math.min(props.max, stepped))
}

/**
 * Dragging works in travel, not in value, so a log knob moves under the pointer
 * at the same rate everywhere on its range. For a linear knob this is exactly
 * the previous arithmetic rewritten.
 */
function onPointerDown(e) {
  if (props.disabled || props.readonly || editing.value) return
  dragging.value = true
  dragStartY = e.clientY
  dragStartPct = pct.value
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onPointerMove(e) {
  if (!dragging.value) return
  const deltaY = dragStartY - e.clientY
  emit('update:modelValue', quantize(fromPct(clamp01(dragStartPct + deltaY / DRAG_RANGE_PX))))
}

function onPointerUp(e) {
  dragging.value = false
  // On pointercancel the capture is already implicitly released
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
}

/** One notch of travel. Linear knobs keep their old absolute step. */
const wheelPct = computed(() =>
  (isLog.value ? 0.01 : props.step / (props.max - props.min)))

function onWheel(e) {
  if (props.disabled || props.readonly || editing.value) return
  e.preventDefault()
  const dir = e.deltaY < 0 ? 1 : -1
  emit('update:modelValue', quantize(fromPct(clamp01(pct.value + dir * wheelPct.value))))
}

// ── Type-in ────────────────────────────────────────────────────────────────
// A knob is the better control for feel and the worse one for "80 Hz exactly".
// The read-out is already showing the number, so it may as well accept one.

const editing = ref(false)
const draft = ref('')
const inputEl = ref(null)

function beginEdit() {
  if (!props.editable || props.disabled || props.readonly) return
  draft.value = String(Number(props.modelValue.toFixed(4)))
  editing.value = true
  requestAnimationFrame(() => inputEl.value?.select())
}

function commitEdit() {
  if (!editing.value) return
  editing.value = false
  const parsed = Number(draft.value)
  if (Number.isFinite(parsed)) emit('update:modelValue', quantize(parsed))
}

function cancelEdit() {
  editing.value = false
}
</script>

<template>
  <div class="flex flex-col items-center gap-[7px] w-full select-none transition-opacity"
       :style="{ fontFamily: `'Inter',system-ui,sans-serif`, opacity: disabled ? 0.4 : 1 }">
    <div
      class="relative w-full touch-none"
      :class="disabled || readonly ? 'cursor-default' : 'cursor-ns-resize'"
      style="aspect-ratio:1"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @dblclick="beginEdit"
    >
      <svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full overflow-visible">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="2.4"
                stroke-linecap="round" :stroke-dasharray="trackDash" transform="rotate(135 50 50)" />
        <circle cx="50" cy="50" r="42" fill="none" :stroke="accent" stroke-width="2.4"
                stroke-linecap="round" :stroke-dasharray="valDash" :stroke-dashoffset="valDashOffset"
                transform="rotate(135 50 50)"
                :style="{ filter: `drop-shadow(0 0 4px ${accent})` }" />
        <line v-for="(t, i) in ticks" :key="i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
              :stroke="t.col" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <div class="absolute left-[16%] top-[16%] w-[68%] h-[68%] rounded-full"
           style="background:radial-gradient(circle at 50% 38%,#2b323c 74%,#6b727c 89%,#7a818b 94%,#3a424c 100%);box-shadow:inset 0 1.5px 1px rgba(255,255,255,.16), inset 0 -3px 6px rgba(0,0,0,.6), 0 8px 18px rgba(0,0,0,.55)">
        <div class="absolute inset-[9%] rounded-full overflow-hidden"
             style="background:linear-gradient(160deg,#1f252d,#1b212a);box-shadow:inset 0 0 0 1px rgba(0,0,0,.32)">
        </div>
        <div
          class="absolute inset-0 flex items-center justify-center"
          :class="editing ? '' : 'pointer-events-none'"
        >
          <input
            v-if="editing"
            ref="inputEl"
            v-model="draft"
            class="w-[76%] bg-transparent text-center outline-none"
            :style="{ font: `500 ${valueFontPx}px/1 'Inter',system-ui`, color: valColor }"
            @pointerdown.stop
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.prevent="cancelEdit"
            @blur="commitEdit"
          >
          <span
            v-else
            class="tracking-[0.01em]"
            :style="{ font: `500 ${valueFontPx}px/1 'Inter',system-ui`, color: valColor }"
          >{{ formatValue(modelValue) }}</span>
        </div>
      </div>
      <svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
        <defs>
          <linearGradient id="wvKnobRib" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#39414a" />
            <stop offset="34%" stop-color="#8f979f" />
            <stop offset="62%" stop-color="#6a727b" />
            <stop offset="100%" stop-color="#2f363e" />
          </linearGradient>
        </defs>
        <g :transform="`rotate(${indicatorDeg} 50 50)`">
          <rect :x="rib.shadowX" :y="RIB_Y + 0.5" :width="rib.shadowW" :height="RIB_H + 0.1"
                :rx="rib.shadowR" fill="rgba(0,0,0,.6)" />
          <rect :x="rib.x" :y="RIB_Y" :width="rib.w" :height="RIB_H" :rx="rib.r"
                fill="url(#wvKnobRib)" />
        </g>
        <circle v-if="arcHead" :cx="bead.cx" :cy="bead.cy" :r="bead.r" :fill="bead.fill"
                :style="bead.style" />
      </svg>
    </div>
    <span v-if="label" class="uppercase" style="font:600 10px/1 'Inter',system-ui;letter-spacing:0.14em;color:rgba(255,255,255,0.55)">{{ label }}</span>
  </div>
</template>
