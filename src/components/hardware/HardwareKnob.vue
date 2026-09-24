<script setup>
import { computed, ref } from 'vue'
import { clamp01, pctToDeg, polar } from './hardwareDial.js'

/**
 * A hardware-faceplate knob: engraved scale around a moulded cap.
 *
 * Five caps:
 *  - `large`   fluted black skirt, chrome centre, white pointer bar (Classic 76 Input/Output)
 *  - `small`   fluted skirt, chrome cap, black dot (Classic 76 Attack/Release)
 *  - `mini`    chrome cap, black dot
 *  - `chrome`  black body, chrome cap, pointer bar, fixed centre screw (Vintage 2A Peak Reduction/Gain)
 *  - `trim`    a small slotted trimmer in a recessed well (Vintage 2A HF Emph)
 *
 * The engraving's colours come from CSS custom properties (`--hw-ink`,
 * `--hw-ink-shadow`, `--hw-mark`, `--hw-mark-shadow`) with the dark Classic 76
 * face as the fallback, so a light faceplate re-inks every control on it by
 * setting four variables rather than threading a theme prop through each.
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
  /** 'dot' marks, or 'line' ticks (engraved strokes, as on the Vintage 2A). */
  markStyle: { type: String, default: 'dot' },
  /** Turn numerals to follow the dial, flipping the bottom ones upright. */
  rotateLabels: { type: Boolean, default: false },
  labelWeight: { type: Number, default: 400 },
  /**
   * A value bubble above the knob while it is dragged, hovered or focused.
   * For faces that print no readout under the knob.
   */
  tip: { type: String, default: null },
})

const emit = defineEmits(['update:modelValue'])

const SPECS = {
  large: { box: 176, cap: 112, dotR: 62, dotD: 3, labelR: 78, labelPx: 14 },
  small: { box: 112, cap: 58, dotR: 42, dotD: 2.6, labelR: 62, labelPx: 10 },
  mini: { box: 86, cap: 42, dotR: 30, dotD: 2.4, labelR: 40, labelPx: 10 },
  chrome: { box: 196, cap: 112, dotR: 72, dotD: 3, labelR: 88, labelPx: 11 },
  trim: { box: 88, cap: 26, dotR: 22, dotD: 2.8, labelR: 36, labelPx: 9 },
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
    // Upright at the bottom: a numeral past ±100° would otherwise read upside down.
    const turn = Math.abs(l.angle) > 100 ? l.angle + (l.angle > 0 ? -180 : 180) : l.angle
    return {
      text: l.text,
      left: `calc(50% + ${x.toFixed(1)}px)`,
      top: `calc(50% + ${y.toFixed(1)}px)`,
      transform: `translate(-50%,-50%)${props.rotateLabels ? ` rotate(${turn}deg)` : ''}`,
    }
  }))

const hovered = ref(false)
const focused = ref(false)

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
    <template v-if="markStyle === 'line'">
      <div
        v-for="(a, i) in dots" :key="'d' + i"
        class="hw-line"
        :style="{ transform: `translate(-50%,-50%) rotate(${a}deg) translateY(-${dotR}px)` }"
      />
    </template>
    <template v-else>
      <div
        v-for="(a, i) in dots" :key="'d' + i"
        class="hw-dot"
        :style="{ width: dotD + 'px', height: dotD + 'px', transform: `translate(-50%,-50%) rotate(${a}deg) translateY(-${dotR}px)` }"
      />
    </template>
    <div
      v-for="(l, i) in placedLabels" :key="'l' + i"
      class="hw-numeral"
      :style="{ left: l.left, top: l.top, transform: l.transform, fontSize: labelPx + 'px', fontWeight: labelWeight }"
    >{{ l.text }}</div>
    <div
      v-if="tip != null"
      class="hw-tip"
      :class="{ 'is-on': dragging || hovered || focused }"
      aria-hidden="true"
      :style="{ '--tip-y': `-${spec.cap / 2 + 32}px` }"
    >{{ tip }}</div>

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
      @pointerenter="hovered = true"
      @pointerleave="hovered = false"
      @focus="focused = true"
      @blur="focused = false"
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
        <template v-else-if="variant === 'chrome'">
          <div class="hw-c-chrome" />
          <div class="hw-c-chrome-shade" />
          <div class="hw-c-bar" />
        </template>
        <template v-else-if="variant === 'trim'">
          <div class="hw-t-screw"><div class="hw-t-slot" /></div>
        </template>
        <template v-else>
          <div class="hw-m-chrome" />
          <div class="hw-m-chrome-shade" />
          <div class="hw-pip" />
        </template>
      </div>
      <!-- The centre screw holds the cap on; it does not turn with it. -->
      <div v-if="variant === 'chrome'" class="hw-c-screw" />
    </div>
  </div>
</template>

<style scoped>
.hw-dot {
  position: absolute; left: 50%; top: 50%; border-radius: 50%;
  background: var(--hw-mark, #f0eee9); box-shadow: var(--hw-mark-shadow, 0 1px 0 rgba(0,0,0,.8));
}
.hw-line {
  position: absolute; left: 50%; top: 50%; width: 1.5px; height: 7px; border-radius: .75px;
  background: var(--hw-mark, #f0eee9); box-shadow: var(--hw-mark-shadow, 0 1px 0 rgba(0,0,0,.8));
}
.hw-numeral {
  position: absolute;
  font-family: Oswald, 'Inter', system-ui, sans-serif; line-height: 1;
  letter-spacing: .03em; color: var(--hw-ink, #f4f2ee); text-shadow: var(--hw-ink-shadow, 0 1px 0 rgba(0,0,0,.9));
  white-space: nowrap; pointer-events: none;
}
.hw-tip {
  position: absolute; left: 50%; top: 50%; z-index: 3; pointer-events: none;
  transform: translate(-50%, calc(var(--tip-y) + 8px)); opacity: 0;
  transition: opacity 140ms ease, transform 140ms ease;
  padding: 5px 9px; border-radius: 3px;
  background: linear-gradient(180deg,#0d0f12,#07080a);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 4px 10px rgba(0,0,0,.45);
  font: 400 15px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .06em;
  color: #ffb45a; text-shadow: 0 0 6px rgba(255,140,40,.35); white-space: nowrap;
}
.hw-tip.is-on { opacity: 1; transform: translate(-50%, var(--tip-y)); }
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
.hw-cap--chrome { background: radial-gradient(120% 120% at 34% 20%,#3b3f45 0%,#1b1d20 46%,#0a0b0c 100%); box-shadow: 0 16px 24px rgba(0,0,0,.5), 0 4px 7px rgba(0,0,0,.7), inset 0 1px 1px rgba(255,255,255,.14); }
.hw-cap--trim { background: radial-gradient(circle at 50% 50%,#8c9194 0%,#6a6f73 70%,#4a4e52 100%); box-shadow: inset 0 1px 2px rgba(0,0,0,.55), 0 1px 0 rgba(255,255,255,.7); }
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
.hw-c-chrome, .hw-c-chrome-shade { inset: 14px; }
.hw-c-chrome { background: conic-gradient(from 0deg,#e7e9ea 0deg,#b6babe 44deg,#f4f5f5 90deg,#a8acb1 140deg,#e9eaec 186deg,#adb1b6 236deg,#f2f3f3 284deg,#b0b4b9 330deg,#e7e9ea 360deg); box-shadow: inset 0 0 0 1px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.7); }
.hw-c-chrome-shade { pointer-events: none; background: radial-gradient(circle at 36% 24%,rgba(255,255,255,.8),rgba(255,255,255,0) 48%), radial-gradient(circle at 68% 84%,rgba(0,0,0,.34),rgba(0,0,0,0) 52%), radial-gradient(circle,rgba(255,255,255,.28) 0%,rgba(255,255,255,0) 30%); }
.hw-rotor > .hw-c-bar { left: 50%; top: 8px; width: 3px; height: 32px; border-radius: 1.5px; transform: translateX(-50%); background: linear-gradient(180deg,#ffffff,rgba(0,0,0,.18)), #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 6px rgba(255,255,255,.12); }
.hw-c-screw { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; pointer-events: none; background: radial-gradient(circle at 40% 30%,#6d7277,#2b2e31); box-shadow: inset 0 1px 1px rgba(255,255,255,.3); }
.hw-t-screw { inset: 2px; background: radial-gradient(circle at 36% 30%,#f2f4f6,#9da2a6 62%,#71767a); box-shadow: inset 0 -1px 2px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.45); }
.hw-t-slot { position: absolute; left: 50%; top: 3px; bottom: 3px; width: 3px; margin-left: -1.5px; border-radius: 1.5px; background: rgba(0,0,0,.5); box-shadow: 0 1px 0 rgba(255,255,255,.5); }
.hw-rotor > .hw-pip { left: 50%; top: 9px; width: 7.5px; height: 7.5px; margin-left: -3.75px; background: radial-gradient(circle at 40% 30%,#26292e,#070809); box-shadow: inset 0 1px 1px rgba(255,255,255,.22), 0 0 0 .5px rgba(255,255,255,.3); }
</style>
