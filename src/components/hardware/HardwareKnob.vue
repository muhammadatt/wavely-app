<script setup>
import { computed, ref } from 'vue'
import { clamp01, pctToDeg, polar } from './hardwareDial.js'

/**
 * A hardware-faceplate knob: engraved scale around a moulded cap.
 *
 * Three caps, all from the Classic 76 face:
 *  - `large`  fluted black skirt, chrome centre, white pointer bar (Input/Output)
 *  - `small`  fluted skirt, chrome cap, black dot (Attack/Release)
 *  - `mini`   chrome cap, black dot (Mix)
 *
 * The knob turns linearly in its value; anything non-linear (a taper, a
 * detent law) belongs to the value itself, and the engraving is placed by the
 * caller in angles so it can say what the value means.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  variant: { type: String, default: 'large' }, // 'large' | 'small' | 'mini'
  /** Double-click returns here. Omit for no reset. */
  defaultValue: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  /** Accessible name; the face's engraved label is the caller's. */
  label: { type: String, default: '' },
  /** Screen-reader value text. */
  formatValue: { type: Function, default: (v) => String(v) },
  /** Engraving: bare dots, as angles. */
  dots: { type: Array, default: () => [] },
  /** Engraving: numerals, as { angle, text }. */
  labels: { type: Array, default: () => [] },
  dotRadius: { type: Number, default: null },
  dotSize: { type: Number, default: null },
  labelRadius: { type: Number, default: null },
  labelSize: { type: Number, default: null },
})

const emit = defineEmits(['update:modelValue'])

const SPECS = {
  large: { box: 176, cap: 112, dotR: 62, dotD: 3, labelR: 78, labelPx: 14 },
  small: { box: 112, cap: 58, dotR: 42, dotD: 2.6, labelR: 62, labelPx: 10 },
  mini: { box: 86, cap: 42, dotR: 30, dotD: 2.4, labelR: 40, labelPx: 10 },
}
const spec = computed(() => SPECS[props.variant] ?? SPECS.large)
const dotR = computed(() => props.dotRadius ?? spec.value.dotR)
const dotD = computed(() => props.dotSize ?? spec.value.dotD)
const labelR = computed(() => props.labelRadius ?? spec.value.labelR)
const labelPx = computed(() => props.labelSize ?? spec.value.labelPx)

const span = computed(() => props.max - props.min)
const pct = computed(() => (span.value ? clamp01((props.modelValue - props.min) / span.value) : 0))
const rotation = computed(() => `rotate(${pctToDeg(pct.value).toFixed(2)}deg)`)

const placedLabels = computed(() => props.labels
  .filter(l => l.text !== '' && l.text != null)
  .map(l => {
    const { x, y } = polar(l.angle, labelR.value)
    return { text: l.text, left: `calc(50% + ${x.toFixed(1)}px)`, top: `calc(50% + ${y.toFixed(1)}px)` }
  }))

function quantize(v) {
  const c = Math.max(props.min, Math.min(props.max, v))
  const s = Math.round((c - props.min) / props.step) * props.step + props.min
  // Float noise from the multiply would otherwise leak into the readouts.
  return Number(Math.max(props.min, Math.min(props.max, s)).toFixed(6))
}

function set(v) {
  const q = quantize(v)
  if (q !== props.modelValue) emit('update:modelValue', q)
}

// ── Drag ────────────────────────────────────────────────────────────────────
// Vertical, 200 px for the full travel; Shift for fine (five times slower).
const DRAG_RANGE_PX = 200
const FINE = 5
const dragging = ref(false)
let lastY = 0
let dragPct = 0

function onPointerDown(e) {
  if (props.disabled) return
  e.preventDefault()
  dragging.value = true
  lastY = e.clientY
  dragPct = pct.value
  e.currentTarget.focus?.({ preventScroll: true })
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onPointerMove(e) {
  if (!dragging.value) return
  // Accumulate per move rather than from the start, so pressing or releasing
  // Shift mid-drag changes the rate from here on instead of jumping.
  const dy = lastY - e.clientY
  lastY = e.clientY
  dragPct = clamp01(dragPct + dy / (DRAG_RANGE_PX * (e.shiftKey ? FINE : 1)))
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
  const moves = {
    ArrowUp: props.step, ArrowRight: props.step,
    ArrowDown: -props.step, ArrowLeft: -props.step,
    PageUp: big, PageDown: -big,
  }
  if (e.key in moves) set(props.modelValue + moves[e.key])
  else if (e.key === 'Home') set(props.min)
  else if (e.key === 'End') set(props.max)
  else return
  e.preventDefault()
}
</script>

<template>
  <div class="hw-knob relative select-none" :style="{ width: spec.box + 'px', height: spec.box + 'px' }">
    <div
      v-for="(a, i) in dots" :key="'d' + i"
      class="hw-dot"
      :style="{ width: dotD + 'px', height: dotD + 'px', transform: `translate(-50%,-50%) rotate(${a}deg) translateY(-${dotR}px)` }"
    />
    <div
      v-for="(l, i) in placedLabels" :key="'l' + i"
      class="hw-numeral"
      :style="{ left: l.left, top: l.top, fontSize: labelPx + 'px' }"
    >{{ l.text }}</div>

    <div
      class="hw-cap"
      :class="[`hw-cap--${variant}`, { 'is-disabled': disabled, 'is-dragging': dragging }]"
      :style="{ width: spec.cap + 'px', height: spec.cap + 'px', margin: `-${spec.cap / 2}px 0 0 -${spec.cap / 2}px` }"
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
      <div class="hw-rotor" :style="{ transform: rotation }">
        <template v-if="variant === 'large'">
          <div class="hw-l-body" />
          <div class="hw-l-sheen" />
          <div class="hw-l-bar" />
          <div class="hw-l-flute" />
          <div class="hw-l-flute-shade" />
          <div class="hw-l-chrome" />
          <div class="hw-l-chrome-shade" />
        </template>
        <template v-else-if="variant === 'small'">
          <div class="hw-s-flute" />
          <div class="hw-s-flute-shade" />
          <div class="hw-s-chrome" />
          <div class="hw-s-chrome-shade" />
          <div class="hw-pip" />
        </template>
        <template v-else>
          <div class="hw-m-chrome" />
          <div class="hw-m-chrome-shade" />
          <div class="hw-pip" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hw-dot {
  position: absolute; left: 50%; top: 50%; border-radius: 50%;
  background: #f0eee9; box-shadow: 0 1px 0 rgba(0,0,0,.8);
}
.hw-numeral {
  position: absolute; transform: translate(-50%,-50%);
  font-family: Oswald, 'Inter', system-ui, sans-serif; font-weight: 400; line-height: 1;
  letter-spacing: .03em; color: #f4f2ee; text-shadow: 0 1px 0 rgba(0,0,0,.9);
  white-space: nowrap; pointer-events: none;
}
.hw-cap {
  position: absolute; left: 50%; top: 50%; border-radius: 50%;
  cursor: grab; touch-action: none; outline: none;
  transition: opacity .15s ease;
}
.hw-cap.is-dragging { cursor: grabbing; }
.hw-cap.is-disabled { cursor: default; opacity: .5; }
.hw-cap:focus-visible { box-shadow: 0 0 0 2px rgba(255,164,53,.55), 0 11px 16px rgba(0,0,0,.6); }
.hw-cap--large { background: #07080a; box-shadow: 0 11px 16px rgba(0,0,0,.6), 0 3px 5px rgba(0,0,0,.72); }
.hw-cap--small, .hw-cap--mini { background: #0a0a0b; box-shadow: 0 9px 14px rgba(0,0,0,.68), 0 2px 4px rgba(0,0,0,.85); }
.hw-rotor { position: absolute; inset: 0; border-radius: 50%; }
.hw-rotor > div { position: absolute; border-radius: 50%; }

.hw-l-body { inset: 0; background: radial-gradient(125% 125% at 33% 16%,#4a4f57 0%,#20232a 30%,#0e1013 66%,#050608 100%); box-shadow: inset 0 1px 1px rgba(255,255,255,.3), inset 0 -12px 20px rgba(0,0,0,.6); }
.hw-l-sheen { inset: 0; pointer-events: none; background: conic-gradient(from 186deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.22) 26deg,rgba(255,255,255,0) 64deg), radial-gradient(60% 40% at 36% 14%,rgba(255,255,255,.35),rgba(255,255,255,0) 70%); }
.hw-rotor > .hw-l-bar { left: 50%; top: 5px; width: 3.5px; height: 21px; border-radius: 1.75px; transform: translateX(-50%); background: linear-gradient(180deg,#ffffff,rgba(0,0,0,.18)), #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 6px rgba(255,255,255,.12); }
.hw-l-flute, .hw-s-flute { background: repeating-conic-gradient(from 0deg,#3b3f45 0deg 9deg,#1b1d20 9deg 16deg,#4a4f57 16deg 19deg,#0f1113 19deg 24deg); }
.hw-l-flute { inset: 27px; box-shadow: inset 0 1px 1px rgba(255,255,255,.14), 0 3px 6px rgba(0,0,0,.75); }
.hw-l-flute-shade, .hw-s-flute-shade { pointer-events: none; background: radial-gradient(120% 120% at 34% 20%,rgba(255,255,255,.14),rgba(255,255,255,0) 46%), radial-gradient(100% 100% at 62% 100%,rgba(0,0,0,.35),rgba(0,0,0,0) 55%); }
.hw-l-flute-shade { inset: 27px; }
.hw-l-chrome, .hw-s-chrome, .hw-m-chrome { background: conic-gradient(from 0deg,#e9e9e8 0deg,#b7b9bb 44deg,#f4f4f3 90deg,#a9abae 140deg,#e7e8e8 186deg,#aeb0b3 236deg,#f1f1f0 284deg,#b1b3b6 330deg,#e9e9e8 360deg); box-shadow: inset 0 0 0 1px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.85); }
.hw-l-chrome-shade, .hw-s-chrome-shade, .hw-m-chrome-shade { pointer-events: none; background: radial-gradient(circle at 34% 24%,rgba(255,255,255,.8),rgba(255,255,255,0) 50%), radial-gradient(circle at 70% 84%,rgba(0,0,0,.3),rgba(0,0,0,0) 52%); }
.hw-l-chrome, .hw-l-chrome-shade { inset: 32px; }
.hw-s-flute { inset: 0; box-shadow: inset 0 1px 1px rgba(255,255,255,.14); }
.hw-s-flute-shade { inset: 0; }
.hw-s-chrome, .hw-s-chrome-shade { inset: 5px; }
.hw-m-chrome, .hw-m-chrome-shade { inset: 0; }
.hw-rotor > .hw-pip { left: 50%; top: 9px; width: 7.5px; height: 7.5px; margin-left: -3.75px; background: radial-gradient(circle at 40% 30%,#26292e,#070809); box-shadow: inset 0 1px 1px rgba(255,255,255,.22), 0 0 0 .5px rgba(255,255,255,.3); }
</style>
