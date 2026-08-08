<script setup>
import { computed, ref } from 'vue'

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
})

const emit = defineEmits(['update:modelValue'])

const R = 42
const CIRCUMFERENCE = 2 * Math.PI * R
const ARC = 0.75 * CIRCUMFERENCE
const N_TICKS = 13

const isLog = computed(() =>
  props.scale === 'log' && props.min > 0 && props.max > props.min)

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/** Value → fraction of travel. */
function toPct(v) {
  if (isLog.value) return clamp01(Math.log(v / props.min) / Math.log(props.max / props.min))
  return clamp01((v - props.min) / (props.max - props.min))
}

/** Fraction of travel → value. */
function fromPct(p) {
  if (isLog.value) return props.min * (props.max / props.min) ** p
  return props.min + p * (props.max - props.min)
}

const pct = computed(() => toPct(props.modelValue))

const trackDash = `${ARC.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`

/** Where along the arc the fill starts, as a fraction: 0 normally, 0.5 bipolar. */
const origin = computed(() => (props.bipolar ? 0.5 : 0))

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
        <div class="absolute inset-0" :style="{ transform: `rotate(${indicatorDeg}deg)` }">
          <div class="absolute top-[15%] left-1/2 -translate-x-1/2 w-[6%] h-[6%] rounded-full"
               style="background: #000000;"></div>
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
    </div>
    <span v-if="label" class="uppercase" style="font:600 10px/1 'Inter',system-ui;letter-spacing:0.14em;color:rgba(255,255,255,0.55)">{{ label }}</span>
  </div>
</template>
