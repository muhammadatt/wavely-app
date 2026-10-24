<script setup>
/**
 * MODULA KNOBS — every rotary in the kit, one gesture.
 *
 *   led    LARGE, an LED dot ring outside the cap, an accent pointer bar
 *          (the kit's GAIN, PHAT*SS's DRIVE)
 *   ticks  LARGE in a sunken well, a tick ring with every fifth tick long, an
 *          accent dot on a stepped cap (the kit's DRIVE, PHAT*SS's WARMTH)
 *   small  62 px, accent pointer bar (ATTACK / RELEASE / TONE / MIX)
 *   arc    MEDIUM, 108 px, an arc and 13 ticks with a dot on the cap; the
 *          only variant that fills BIPOLAR from its zero
 *   ring   the quiet one: a thin value arc on a dark track around a plain cap
 *          with one pointer line — no ticks, no dots, no well. For dense
 *          rows (the EQ's band strips), where eight arc knobs read as noise;
 *          fills BIPOLAR from its zero like the arc
 *   plain  the ring knob's cap and accent pointer with nothing round it — no arc,
 *          no track, no ring. For the smallest controls in a dense row, where
 *          the value is read off a caption and the ring would only be noise
 *   trim   30 px, a plain white pointer: the trims under the IN/OUT meters
 *
 * The value is never printed on the cap. The large knobs float it in a drag
 * tip; the small ones print it under the label (`showValue`).
 *
 * Rotation is −135° … +135° over the travel.
 *
 * ⚠ `size` IS THE OUTER SIZE, RING INCLUDED, FOR EVERY VARIANT — the box the knob
 * occupies in the layout. The cap sits inside it: 72 % of it for led (the ring
 * scales with the knob), 68 % for arc, size − 54 px for ticks, all of it for the
 * ringless variants. So the same `size` on two variants is the same footprint.
 */
import { computed, nextTick, ref } from 'vue'
import { useModulaDrag, DRAG_PROPS } from './useModulaDrag.js'
import { bipolarOriginPct } from '../knobs/knobGeometry.js'
import ModulaValueTip from './ModulaValueTip.vue'

const props = defineProps({
  ...DRAG_PROPS,
  variant: { type: String, default: 'small', validator: v => ['led', 'ticks', 'small', 'arc', 'ring', 'plain', 'trim'].includes(v) },
  /** Diameter of the knob body, px. Defaults per variant. */
  size: { type: Number, default: null },
  label: { type: String, default: '' },
  /** A second, quieter line under the label (the arc knob's note). */
  note: { type: String, default: '' },
  /** Print the value under the knob (small / trim / large). */
  showValue: { type: Boolean, default: false },
  /** Show the drag tip. On by default for every variant but trim. */
  showTip: { type: Boolean, default: null },
  color: { type: String, default: 'var(--m-accent)' },
  bipolar: { type: Boolean, default: false },
  /** Pixels of drag for the whole travel. */
  travelPx: { type: Number, default: null },
  /** LED/tick count around the ring. */
  segments: { type: Number, default: null },
  /**
   * Click the printed value to type an exact one (Enter commits, Escape
   * cancels). The knob's own double-click stays the reset — the kit's
   * gesture — so typing lives on the number, which is where the eye already is.
   */
  editable: { type: Boolean, default: false },
  /** Parse a typed entry (default: the leading number in it). */
  parseValue: { type: Function, default: null },
})
const emit = defineEmits(['update:modelValue'])

/** Outer size, ring included. */
const DEFAULT_SIZE = { led: 156, ticks: 156, small: 62, arc: 108, ring: 48, plain: 30, trim: 30 }
/** The cap diameter the shadows and pointer widths were written for. */
const DESIGN_CAP = { led: 112, ticks: 102, small: 62, arc: 108, ring: 48, plain: 32, trim: 30 }
const DEFAULT_TRAVEL = { led: 200, ticks: 200, small: 140, arc: 150, ring: 150, plain: 150, trim: 160 }
const outer = computed(() => props.size ?? DEFAULT_SIZE[props.variant])
/** The cap, which is what the knob's own geometry is measured on. */
const body = computed(() => {
  if (props.variant === 'led') return outer.value * DESIGN_CAP.led / DEFAULT_SIZE.led
  if (props.variant === 'ticks') return outer.value - 54
  return outer.value
})
/**
 * Size relative to the variant's design size. The cap shadows are written for
 * that size and multiplied by this, so a 44 px knob keeps a 62 px knob's
 * proportions instead of being mostly inner shadow. 1 px outlines stay 1 px.
 */
const scaleK = computed(() => +(body.value / DESIGN_CAP[props.variant]).toFixed(3))

const { dragging, pct, handlers, setValue } = useModulaDrag(
  props, v => emit('update:modelValue', v),
  { axis: 'y', travelPx: () => props.travelPx ?? DEFAULT_TRAVEL[props.variant] },
)

const deg = computed(() => -135 + 270 * pct.value)
const origin = computed(() => (props.bipolar ? bipolarOriginPct(props.min, props.max, props.scale) : 0))
const lit = (f) => {
  const lo = Math.min(pct.value, origin.value) - 0.001
  const hi = Math.max(pct.value, origin.value) + 0.001
  return f >= lo && f <= hi
}
const text = computed(() => props.formatValue(props.modelValue))
// ── Type-in ─────────────────────────────────────────────────────────────────
const editing = ref(false)
const draft = ref('')
const inputEl = ref(null)
async function beginEdit() {
  if (!props.editable || props.disabled || props.readonly) return
  draft.value = String(Number(props.modelValue.toFixed(4)))
  editing.value = true
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}
function commitEdit() {
  if (!editing.value) return
  editing.value = false
  const raw = String(draft.value).trim()
  const v = props.parseValue ? props.parseValue(raw) : parseFloat(raw.replace(',', '.'))
  setValue(v)
}
function cancelEdit() { editing.value = false }

// Captions: which line comes first, and what the value line reads.
/** The two knobs captioned like the arc: label first, the value (or note) under it. */
const ringLike = computed(() => props.variant === 'ring' || props.variant === 'plain')
const labelFirst = computed(() => props.variant === 'small' || props.variant === 'arc' || ringLike.value)
const valueLine = computed(() => {
  if (props.variant === 'arc' || ringLike.value) return props.note || props.showValue ? (props.note || text.value) : null
  return props.showValue ? text.value : null
})
const valueClass = computed(() => ({
  small: 'm-note m-val-small', arc: 'm-note m-val-arc', ring: 'm-note m-val-arc', plain: 'm-note m-val-arc', trim: 'm-note', led: 'm-big-value', ticks: 'm-big-value',
}[props.variant]))
const valueEditable = computed(() => props.editable && !props.readonly && !((props.variant === 'arc' || ringLike.value) && props.note))

const tipOn = computed(() => (props.showTip ?? props.variant !== 'trim') && dragging.value)

// ── LED ring (led) ──────────────────────────────────────────────────────────
// The ring box IS the outer size; the LEDs sit 9 px (at the design size) inside
// its edge, and the dots and that inset scale with the knob.
const ledBox = computed(() => outer.value)
const ledDot = computed(() => Math.max(3, 6 * scaleK.value))
const leds = computed(() => {
  const n = props.segments ?? 21
  const c = ledBox.value / 2
  const r = c - 9 * scaleK.value
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1)
    const a = (-135 + 270 * f) * Math.PI / 180
    return { l: c + r * Math.sin(a), t: c - r * Math.cos(a), on: lit(f) }
  })
})

// ── Tick ring (ticks) ───────────────────────────────────────────────────────
const tickBox = computed(() => outer.value)
const ticks = computed(() => {
  const n = props.segments ?? 21
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1)
    return { deg: 45 + 270 * f, long: i % 5 === 0, on: lit(f) }
  })
})

// ── Arc (arc) ───────────────────────────────────────────────────────────────
const ARC = 197.92
const CIRC = 263.89
const arc = computed(() => {
  const lo = Math.min(pct.value, origin.value)
  const hi = Math.max(pct.value, origin.value)
  return { dash: `${((hi - lo) * ARC).toFixed(1)} ${CIRC}`, offset: (-lo * ARC).toFixed(1) }
})
// The ring's arc: r 44, 270° of it, so the dash is in its own units.
const RING_ARC = 207.35
const ringArc = computed(() => {
  const lo = Math.min(pct.value, origin.value)
  const hi = Math.max(pct.value, origin.value)
  return { dash: `${((hi - lo) * RING_ARC).toFixed(1)} 276.5`, offset: (-lo * RING_ARC).toFixed(1), empty: hi - lo < 0.002 }
})
const arcTicks = computed(() => Array.from({ length: 13 }, (_, i) => {
  const t = i / 12
  const a = (135 + t * 270) * Math.PI / 180
  return {
    x1: 50 + 48 * Math.cos(a), y1: 50 + 48 * Math.sin(a),
    x2: 50 + 44 * Math.cos(a), y2: 50 + 44 * Math.sin(a),
    on: lit(t),
  }
}))

const aria = computed(() => ({
  role: 'slider',
  tabindex: props.disabled ? -1 : 0,
  'aria-label': props.ariaLabel || props.label || undefined,
  'aria-valuemin': props.min,
  'aria-valuemax': props.max,
  'aria-valuenow': props.modelValue,
  'aria-valuetext': text.value,
  'aria-disabled': props.disabled || undefined,
}))
</script>

<template>
  <div class="m-knob" :class="[`m-knob--${variant}`, { 'is-disabled': disabled, 'is-readonly': readonly }]" :style="{ '--k': scaleK }">
    <!-- The trim's index dot, over the knob. -->
    <div v-if="variant === 'trim'" class="m-trim-dot" aria-hidden="true"></div>

    <!-- LED ring ─────────────────────────────────────────────────────────── -->
    <div v-if="variant === 'led'" class="m-ring" :style="{ width: `${ledBox}px`, height: `${ledBox}px` }">
      <ModulaValueTip :text="text" :show="tipOn" />
      <div
        v-for="(l, i) in leds" :key="i" class="m-led"
        :style="{ left: `${l.l}px`, top: `${l.t}px`, width: `${ledDot}px`, height: `${ledDot}px`, margin: `${-ledDot / 2}px 0 0 ${-ledDot / 2}px`, background: l.on ? color : 'var(--m-led-off)', boxShadow: l.on ? `0 0 ${ledDot}px ${color}` : 'inset 0 1px 1px rgba(0,0,0,.6)' }"
      ></div>
      <div class="m-cap m-cap--led m-focusable" :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers">
        <div class="m-cap-inner" :style="{ inset: `${Math.round(body * 0.116)}px` }"></div>
        <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
          <div class="m-bar" :style="{ top: `${Math.round(body * 0.152)}px`, height: `${Math.round(body * 0.232)}px`, width: `${Math.max(2, 4 * scaleK).toFixed(1)}px`, marginLeft: `${(-Math.max(2, 4 * scaleK) / 2).toFixed(2)}px`, background: color, boxShadow: `0 0 ${ledDot}px ${color}` }"></div>
        </div>
      </div>
    </div>

    <!-- Tick ring in a well ───────────────────────────────────────────────── -->
    <div v-else-if="variant === 'ticks'" class="m-ring m-ring--well" :style="{ width: `${tickBox}px`, height: `${tickBox}px` }">
      <ModulaValueTip :text="text" :show="tipOn" />
      <div
        v-for="(t, i) in ticks" :key="i" class="m-tick"
        :style="{ height: `${tickBox / 2 - 8}px`, transform: `rotate(${t.deg}deg)` }"
      >
        <div :style="{ height: `${t.long ? 10 : 6}px`, background: t.on ? color : 'rgba(255,255,255,.13)', boxShadow: t.on ? `0 0 4px ${color}` : 'none' }"></div>
      </div>
      <div class="m-cap m-cap--ticks m-focusable" :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers">
        <div class="m-cap-inner m-cap-inner--step" :style="{ inset: `${Math.round(body * 0.108)}px` }"></div>
        <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
          <div class="m-dot" :style="{ top: `${Math.round(body * 0.137)}px`, width: '7px', height: '7px', marginLeft: '-3.5px', background: color, boxShadow: `0 0 6px ${color}` }"></div>
        </div>
      </div>
    </div>

    <!-- Medium arc ────────────────────────────────────────────────────────── -->
    <div
      v-else-if="variant === 'arc'" class="m-arc m-focusable"
      :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers"
    >
      <ModulaValueTip :text="text" :show="tipOn" :offset="34" />
      <div class="m-arc-well"></div>
      <svg viewBox="0 0 100 100" class="m-arc-svg">
        <circle cx="50" cy="50" r="42" fill="none" transform="rotate(135 50 50)" style="stroke:var(--m-led-off);stroke-width:3;stroke-linecap:round;stroke-dasharray:197.9 263.9" />
        <circle
          cx="50" cy="50" r="42" fill="none" transform="rotate(135 50 50)"
          :style="{ stroke: color, strokeWidth: 3, strokeLinecap: 'round', strokeDasharray: arc.dash, strokeDashoffset: arc.offset, filter: `drop-shadow(0 0 1px ${color})` }"
        />
        <template v-for="(t, i) in arcTicks" :key="i">
          <line :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" :style="{ stroke: t.on ? color : 'var(--m-led-off)', strokeWidth: 1.6, strokeLinecap: 'round' }" />
        </template>
      </svg>
      <div class="m-arc-cap">
        <div class="m-arc-face"></div>
        <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
          <div class="m-arc-dot" :style="{ background: color, boxShadow: `0 0 2px ${color}` }"></div>
        </div>
      </div>
    </div>

    <!-- Ring: a thin value arc and a plain cap ───────────────────────────── -->
    <div
      v-else-if="variant === 'ring'" class="m-ringk m-focusable"
      :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers"
    >
      <ModulaValueTip :text="text" :show="tipOn" size="sm" :offset="30" />
      <svg viewBox="0 0 100 100" class="m-arc-svg">
        <circle cx="50" cy="50" r="44" fill="none" transform="rotate(135 50 50)" style="stroke:var(--m-led-off);stroke-width:3.5;stroke-linecap:round;stroke-dasharray:207.3 276.5" />
        <circle
          cx="50" cy="50" r="44" fill="none" transform="rotate(135 50 50)"
          :style="{ stroke: color, strokeWidth: 3.5, strokeLinecap: 'round', strokeDasharray: ringArc.dash, strokeDashoffset: ringArc.offset, opacity: ringArc.empty ? 0 : 1, filter: `drop-shadow(0 0 4px ${color})` }"
        />
      </svg>
      <div class="m-ring-cap">
        <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
          <div class="m-ring-line" :style="{ background: color, boxShadow: `0 0 5px ${color}` }"></div>
        </div>
      </div>
    </div>

    <!-- Plain: the ring knob's cap and pointer, nothing round it ─────────── -->
    <div
      v-else-if="variant === 'plain'" class="m-plain m-focusable"
      :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers"
    >
      <ModulaValueTip :text="text" :show="tipOn" size="sm" :offset="24" />
      <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
        <div class="m-ring-line" :style="{ background: color, boxShadow: `0 0 5px ${color}` }"></div>
      </div>
    </div>

    <!-- Small and trim ─────────────────────────────────────────────────────── -->
    <div
      v-else class="m-cap m-cap--plain m-focusable"
      :style="{ width: `${body}px`, height: `${body}px` }" v-bind="aria" v-on="handlers"
      :title="variant === 'trim' ? 'Drag · double-click to reset' : undefined"
    >
      <ModulaValueTip :text="text" :show="tipOn" size="sm" :offset="variant === 'trim' ? 32 : 34" />
      <div v-if="variant !== 'trim'" class="m-cap-inner" :style="{ inset: `${Math.round(body * 0.116)}px` }"></div>
      <div class="m-rot" :style="{ transform: `rotate(${deg}deg)` }">
        <div
          v-if="variant === 'trim'" class="m-bar"
          style="top:4px;height:8px;width:2px;margin-left:-1px;border-radius:1px;background:var(--m-ink)"
        ></div>
        <div
          v-else class="m-bar"
          :style="{ top: `${Math.round(body * 0.13)}px`, height: `${Math.round(body * 0.24)}px`, width: `${Math.max(2, 3 * scaleK).toFixed(1)}px`, marginLeft: `${(-Math.max(2, 3 * scaleK) / 2).toFixed(2)}px`, background: color, boxShadow: `0 0 ${Math.max(3, 6 * scaleK).toFixed(1)}px ${color}` }"
        ></div>
      </div>
    </div>

    <!-- Captions ──────────────────────────────────────────────────────────── -->
    <div v-if="label && labelFirst" class="m-caption" :style="variant === 'arc' ? { color: 'rgba(255,255,255,.55)' } : null">{{ label }}</div>
    <template v-if="valueLine != null">
      <input
        v-if="editing" ref="inputEl" v-model="draft" class="m-val-input" :class="valueClass"
        :aria-label="`${ariaLabel || label || 'value'}, type a value`"
        @keydown.enter.prevent="commitEdit" @keydown.esc.prevent.stop="cancelEdit" @blur="commitEdit"
      >
      <button
        v-else-if="valueEditable" type="button" class="m-val-btn" :class="valueClass"
        :disabled="disabled" title="Click to type a value" @click="beginEdit"
      >{{ valueLine }}</button>
      <div v-else :class="valueClass">{{ valueLine }}</div>
    </template>
    <div v-if="label && !labelFirst && variant !== 'trim'" class="m-caption">{{ label }}</div>
  </div>
</template>

<style scoped>
.m-knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  user-select: none;
  transition: opacity 0.15s ease;
}
.m-knob--led, .m-knob--ticks { gap: 12px; }
.m-knob--arc, .m-knob--ring, .m-knob--plain { gap: 7px; }
.m-knob--trim { gap: 5px; }
.m-knob.is-disabled { opacity: 0.4; }
.m-knob:is(.is-disabled, .is-readonly) :is(.m-cap, .m-arc, .m-ringk, .m-plain) { cursor: default; }

.m-ring {
  position: relative;
  display: grid;
  place-items: center;
}
.m-ring--well {
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #232a33, #1b2027);
  box-shadow: inset 0 3px 8px rgba(0, 0, 0, 0.7), inset 0 -1px 0 rgba(255, 255, 255, 0.04);
}
.m-led {
  position: absolute;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
}
.m-tick {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  margin-left: -1px;
  transform-origin: 50% 0;
}
.m-tick > div {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 2px;
  border-radius: 1px;
}

.m-cap {
  position: relative;
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  flex: none;
}
.m-cap:active { cursor: grabbing; }
.m-cap--led {
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  /* The shadows are specified for the 112 px cap and scaled by --k, so a 50 px
     knob keeps the same proportions instead of being mostly inner shadow. */
  box-shadow: 0 calc(16px * var(--k, 1)) calc(26px * var(--k, 1)) calc(-12px * var(--k, 1)) rgba(0, 0, 0, 0.95), inset 0 calc(2px * var(--k, 1)) calc(2px * var(--k, 1)) rgba(255, 255, 255, 0.1), inset 0 calc(-7px * var(--k, 1)) calc(12px * var(--k, 1)) rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.7);
}
.m-cap--ticks {
  background: linear-gradient(160deg, #505c6e 0%, #353e4b 52%, #242b34 100%);
  box-shadow: 0 20px 32px -14px rgba(0, 0, 0, 0.95), inset 0 2px 2px rgba(255, 255, 255, 0.1), inset 0 -8px 14px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.7), 0 0 0 6px #232a33, 0 0 0 7px rgba(0, 0, 0, 0.6);
}
.m-cap--plain {
  /* Steel-tinted to sit on --m-panel (#3c4655 → #2c343f): the old neutral grey
     read as a dull patch on the blue-grey chassis. Lighter lip, darker foot. */
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  box-shadow: 0 calc(12px * var(--k, 1)) calc(20px * var(--k, 1)) calc(-10px * var(--k, 1)) rgba(0, 0, 0, 0.95), inset 0 calc(1.5px * var(--k, 1)) calc(1.5px * var(--k, 1)) rgba(255, 255, 255, 0.1), inset 0 calc(-5px * var(--k, 1)) calc(9px * var(--k, 1)) rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.7);
}
.m-knob--trim .m-cap--plain {
  box-shadow: 0 8px 14px -8px rgba(0, 0, 0, 0.95), inset 0 1px 1px rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.65);
}
.m-cap-inner {
  position: absolute;
  border-radius: 50%;
  background: linear-gradient(160deg, #3c4757, #27303b);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.m-cap-inner--step {
  background: linear-gradient(160deg, #3e4959, #28313c);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 1px 2px rgba(0, 0, 0, 0.6);
}
.m-rot {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.m-bar, .m-dot {
  position: absolute;
  left: 50%;
  border-radius: 2px;
}
.m-dot { border-radius: 50%; }

.m-arc {
  position: relative;
  touch-action: none;
  cursor: ns-resize;
}
/* FLAT AND TRANSPARENT: the face shows through. A recess read as the knob
   sunk into the panel and a raised bezel as a second disc; the separation from
   the track is the gap the smaller cap leaves. */
.m-arc-well {
  position: absolute;
  inset: 10%;
  border-radius: 50%;
  background: transparent;
}
.m-arc-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.m-ringk {
  position: relative;
  touch-action: none;
  cursor: ns-resize;
}
.m-ring-cap {
  position: absolute;
  inset: 17%;
  border-radius: 50%;
  /* The led knob's cap, at the strip's scale. */
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  box-shadow: 0 calc(6px * var(--k, 1)) calc(10px * var(--k, 1)) calc(-6px * var(--k, 1)) rgba(0, 0, 0, .95), inset 0 calc(1px * var(--k, 1)) calc(1px * var(--k, 1)) rgba(255, 255, 255, .1), inset 0 calc(-3px * var(--k, 1)) calc(5px * var(--k, 1)) rgba(0, 0, 0, .55), 0 0 0 1px rgba(0, 0, 0, .7);
}
.m-plain {
  position: relative;
  flex: none;
  border-radius: 50%;
  cursor: ns-resize;
  touch-action: none;
  /* The ring knob's cap, filling the whole box: nothing round it. */
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  box-shadow: 0 calc(6px * var(--k, 1)) calc(10px * var(--k, 1)) calc(-6px * var(--k, 1)) rgba(0, 0, 0, .95), inset 0 calc(1px * var(--k, 1)) calc(1px * var(--k, 1)) rgba(255, 255, 255, .1), inset 0 calc(-3px * var(--k, 1)) calc(5px * var(--k, 1)) rgba(0, 0, 0, .55), 0 0 0 1px rgba(0, 0, 0, .7);
}
.m-ring-line {
  position: absolute;
  left: 50%;
  top: 8%;
  width: max(2px, calc(3px * var(--k, 1)));
  height: 30%;
  transform: translateX(-50%);
  border-radius: 2px;
}
/* The RIMMED cap: a raised metal lip round a lighter dial face. Steel-tinted to
   sit on the chassis, with the led knob's soft outline and the gap to the track
   the smaller cap leaves. */
.m-arc-cap {
  position: absolute;
  /* 68% puts the track the same fraction of the cap's diameter away as the led
     knob's LED ring (about 9% clear), where 56% left it 22%. */
  left: 16%;
  top: 16%;
  width: 68%;
  height: 68%;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 38%, #404b5b 74%, #66758b 89%, #7a8aa1 94%, #394353 100%);
  box-shadow: inset 0 calc(1.5px * var(--k, 1)) calc(1px * var(--k, 1)) rgba(255, 255, 255, 0.18), inset 0 calc(-3px * var(--k, 1)) calc(6px * var(--k, 1)) rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.7), 0 calc(5px * var(--k, 1)) calc(9px * var(--k, 1)) rgba(0, 0, 0, 0.4);
}
.m-arc-face {
  position: absolute;
  /* Rim width: the old Knob.vue's, 9% of a 68% cap (6.1% of the knob) — the
     cap is 68% again, so it is the same 9%. */
  inset: 9%;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(160deg, #5b687c, #414d5f);
  box-shadow: 0 0 0 1.5px #37414f, inset 0 1px 0 rgba(255, 255, 255, 0.12);
}
.m-arc-dot {
  position: absolute;
  top: 16%;
  left: 50%;
  transform: translateX(-50%);
  width: 10%;
  height: 10%;
  border-radius: 50%;
}

.m-trim-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--m-ink-4); }
.m-val-small { font-size: 11px; }
.m-val-arc { color: var(--m-ink-4); letter-spacing: .14em; }
.m-val-btn {
  border: none;
  background: transparent;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 4px;
  cursor: text;
}
.m-val-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .06); color: var(--m-ink); }
.m-val-btn:disabled { cursor: default; }
.m-val-input {
  width: 7ch;
  padding: 2px 4px;
  margin: -2px 0;
  border: none;
  outline: none;
  border-radius: 4px;
  text-align: center;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well), 0 0 0 1px var(--m-second);
  color: var(--m-ink);
}
.m-big-value {
  font: 500 22px/1 var(--m-font-mono);
  color: var(--m-ink);
}
.m-focusable:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 3px;
}
</style>
