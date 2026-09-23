<script setup>
import { computed, ref } from 'vue'
import { clamp01 } from './hardwareDial.js'

/**
 * A short horizontal fader from the Classic 76 face: a recessed slot, an
 * engraved scale above and below it, and a chrome cap with a centre line.
 *
 * Click anywhere on it to jump the cap there, then drag; Shift drags fine.
 * Wheel, arrow keys, Home/End and double-click-to-reset all work, and it is a
 * `role="slider"` for assistive tech.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0.01 },
  /** Double-click returns here. Omit for no reset. */
  defaultValue: { type: Number, default: null },
  width: { type: Number, default: 124 },
  /** Engraved divisions across the travel, ends included; alternate ones are long. */
  ticks: { type: Number, default: 5 },
  minLabel: { type: String, default: '' },
  maxLabel: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
  formatValue: { type: Function, default: (v) => String(v) },
})
const emit = defineEmits(['update:modelValue'])

const HEIGHT = 30
/** Where the cap's centre line sits at either end, from the edges. */
const PAD = 22
const CAP_W = 14
const FINE = 5

const travel = computed(() => props.width - PAD * 2)
const span = computed(() => props.max - props.min)
const pct = computed(() => (span.value ? clamp01((props.modelValue - props.min) / span.value) : 0))
const capLeft = computed(() => `${(PAD + pct.value * travel.value - CAP_W / 2).toFixed(1)}px`)

const tickMarks = computed(() => Array.from({ length: props.ticks }, (_, i) => ({
  x: PAD + (props.ticks > 1 ? i / (props.ticks - 1) : 0) * travel.value,
  h: i % 2 === 0 ? 6 : 3,
})))

function quantize(v) {
  const c = Math.max(props.min, Math.min(props.max, v))
  const s = Math.round((c - props.min) / props.step) * props.step + props.min
  return Number(Math.max(props.min, Math.min(props.max, s)).toFixed(6))
}
function set(v) {
  const q = quantize(v)
  if (q !== props.modelValue) emit('update:modelValue', q)
}

const root = ref(null)
const dragging = ref(false)
let lastX = 0
let dragPct = 0

function pctAt(clientX) {
  const r = root.value.getBoundingClientRect()
  return clamp01((clientX - r.left - PAD) / travel.value)
}

function onPointerDown(e) {
  if (props.disabled) return
  e.preventDefault()
  root.value.focus({ preventScroll: true })
  dragging.value = true
  lastX = e.clientX
  // A press on the cap grabs it where it is; anywhere else jumps it there.
  dragPct = e.target.closest('.hf-cap') ? pct.value : pctAt(e.clientX)
  set(props.min + dragPct * span.value)
  e.currentTarget.setPointerCapture(e.pointerId)
}
function onPointerMove(e) {
  if (!dragging.value) return
  const dx = e.clientX - lastX
  lastX = e.clientX
  dragPct = clamp01(dragPct + dx / (travel.value * (e.shiftKey ? FINE : 1)))
  set(props.min + dragPct * span.value)
}
function onPointerUp(e) {
  dragging.value = false
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
}
function onWheel(e) {
  if (props.disabled) return
  e.preventDefault()
  set(props.modelValue + (e.deltaY < 0 ? 1 : -1) * props.step)
}
function onDblClick() {
  if (props.disabled || props.defaultValue == null) return
  set(props.defaultValue)
}
function onKeyDown(e) {
  if (props.disabled) return
  const big = Math.max(props.step, span.value / 10)
  const moves = { ArrowRight: props.step, ArrowUp: props.step, ArrowLeft: -props.step, ArrowDown: -props.step, PageUp: big, PageDown: -big }
  if (e.key in moves) set(props.modelValue + moves[e.key])
  else if (e.key === 'Home') set(props.min)
  else if (e.key === 'End') set(props.max)
  else return
  e.preventDefault()
}
</script>

<template>
  <div
    ref="root"
    class="hf"
    :class="{ 'is-disabled': disabled, 'is-dragging': dragging }"
    :style="{ width: width + 'px', height: HEIGHT + 'px' }"
    role="slider"
    :tabindex="disabled ? -1 : 0"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="modelValue"
    :aria-valuetext="formatValue(modelValue)"
    :aria-disabled="disabled || undefined"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @dblclick="onDblClick"
    @keydown="onKeyDown"
  >
    <template v-for="(t, i) in tickMarks" :key="i">
      <div class="hf-tick" :style="{ left: t.x + 'px', top: (8 - t.h) + 'px', height: t.h + 'px' }" />
      <div class="hf-tick" :style="{ left: t.x + 'px', top: '22px', height: t.h + 'px' }" />
    </template>
    <div v-if="minLabel" class="hf-end" style="left:0">{{ minLabel }}</div>
    <div v-if="maxLabel" class="hf-end" style="right:0">{{ maxLabel }}</div>
    <div class="hf-slot" :style="{ left: PAD - 4 + 'px', right: PAD - 4 + 'px' }" />
    <div class="hf-cap" :style="{ left: capLeft, width: CAP_W + 'px' }"><div class="hf-cap-line" /></div>
  </div>
</template>

<style scoped>
.hf { position: relative; flex: 0 0 auto; cursor: ew-resize; touch-action: none; outline: none; user-select: none; }
.hf.is-disabled { cursor: default; }
.hf:focus-visible { border-radius: 3px; box-shadow: 0 0 0 1.5px rgba(255,164,53,.55); }
.hf-tick { position: absolute; width: 1px; background: #d9d7d2; }
.hf-end {
  position: absolute; top: 50%; transform: translateY(-50%);
  font: 400 8px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .06em;
  color: #f4f2ee; text-shadow: 0 1px 0 rgba(0,0,0,.9); pointer-events: none;
}
.hf-slot {
  position: absolute; top: 50%; height: 4px; margin-top: -2px; border-radius: 2px; background: #000;
  box-shadow: inset 0 1px 2px rgba(0,0,0,1), 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(0,0,0,.6);
}
.hf-cap {
  position: absolute; top: 2px; height: 26px; border-radius: 2px; transition: opacity .15s ease;
  background: linear-gradient(90deg,#9ea1a5 0%,#cfd1d3 24%,#f6f6f5 46%,#dcdddf 62%,#a9acb0 100%);
  box-shadow: inset 1px 0 0 rgba(255,255,255,.9), inset -1px 0 0 rgba(0,0,0,.35), 0 3px 5px rgba(0,0,0,.75), 0 0 0 .5px rgba(0,0,0,.7);
}
.hf.is-disabled .hf-cap { opacity: .5; }
.hf-cap-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: #0c0d0e; box-shadow: 1px 0 0 rgba(255,255,255,.5); }
</style>
