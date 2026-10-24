<script setup>
/**
 * MODULA RANGE SLIDER — one sunken channel with two caps, for a span that is a
 * single idea (a band: "above 3k", "300–5k", "full band") rather than two
 * unrelated numbers. A log axis, like the band knobs it replaces.
 *
 * Drag a cap, or press on the channel to pull the nearer cap there; arrow keys,
 * Page and Home / End move the focused cap, and double-click on a cap returns it
 * to its default. The caps never cross: `hi` stays at least `minRatio` times
 * `lo`, which is the same floor the band filters enforce, so the control can
 * not show a span the audio would not produce.
 *
 * The axis is log unless a `taper` is given. A log axis from 1 Hz to 20 kHz
 * spends 46 % of its travel below 100 Hz, so a band control that needs the
 * bottom octaves reachable but not roomy brings its own taper (`toPct` /
 * `fromPct`, both over 0–1), as the console fader does.
 *
 * The span rule is a ratio (`hi / lo`), so it assumes a log-like axis.
 */
import { computed, ref } from 'vue'
import { clamp01, valueToPct, pctToValue } from '../knobs/knobGeometry.js'

const props = defineProps({
  lo: { type: Number, required: true },
  hi: { type: Number, required: true },
  min: { type: Number, default: 1 },
  max: { type: Number, default: 20000 },
  /** Lowest the high cap may take (defaults to `min`). */
  hiMin: { type: Number, default: null },
  /** `hi / lo` never falls below this. */
  minRatio: { type: Number, default: 1 },
  quantize: { type: Function, default: null },
  /** `{ toPct(v), fromPct(p) }` — a custom travel law; replaces the log axis. */
  taper: { type: Object, default: null },
  loDefault: { type: Number, default: null },
  hiDefault: { type: Number, default: null },
  color: { type: String, default: 'var(--m-accent)' },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
  /** Text beside the label: what the span currently means. */
  reading: { type: String, default: '' },
  /** Accessible names and the value text for each cap. */
  loLabel: { type: String, default: 'Low' },
  hiLabel: { type: String, default: 'High' },
  formatValue: { type: Function, default: v => String(Math.round(v)) },
  loTitle: { type: String, default: '' },
  hiTitle: { type: String, default: '' },
})
const emit = defineEmits(['update:lo', 'update:hi'])

const CAP = 16
const slot = ref(null)
const active = ref(null) // 'lo' | 'hi' while dragging

const toPct = v => (props.taper ? props.taper.toPct(v) : valueToPct(v, props.min, props.max, 'log'))
const fromPct = p => (props.taper ? props.taper.fromPct(p) : pctToValue(p, props.min, props.max, 'log'))

const loPct = computed(() => clamp01(toPct(props.lo)))
const hiPct = computed(() => clamp01(toPct(props.hi)))

function quantized(v) {
  const c = Math.max(props.min, Math.min(props.max, v))
  return props.quantize ? props.quantize(c) : c
}

function setCap(which, pct) {
  const raw = quantized(fromPct(clamp01(pct)))
  if (which === 'lo') {
    const v = Math.min(raw, props.hi / props.minRatio)
    const next = Math.max(props.min, props.quantize ? props.quantize(v) : v)
    if (next !== props.lo) emit('update:lo', next)
  } else {
    const v = Math.max(raw, props.lo * props.minRatio, props.hiMin ?? props.min)
    const next = Math.min(props.max, props.quantize ? props.quantize(v) : v)
    if (next !== props.hi) emit('update:hi', next)
  }
}

/** Pointer x as a 0–1 position along the cap travel. */
function pctAt(e) {
  const r = slot.value.getBoundingClientRect()
  return (e.clientX - r.left - CAP / 2) / Math.max(1, r.width - CAP)
}

function onDown(e) {
  if (props.disabled || e.button > 0) return
  e.preventDefault()
  const p = pctAt(e)
  const which = e.target.closest?.('[data-cap]')?.dataset.cap
    ?? (Math.abs(p - loPct.value) < Math.abs(p - hiPct.value) || (loPct.value === hiPct.value && p < loPct.value) ? 'lo' : 'hi')
  active.value = which
  slot.value.setPointerCapture?.(e.pointerId)
  slot.value.querySelector(`[data-cap="${which}"]`)?.focus({ preventScroll: true })
  setCap(which, p)
}

function onMove(e) {
  if (active.value) setCap(active.value, pctAt(e))
}

function onUp(e) {
  if (!active.value) return
  active.value = null
  try { slot.value.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
}

function onKey(which, e) {
  if (props.disabled) return
  const cur = which === 'lo' ? loPct.value : hiPct.value
  const map = { ArrowRight: 0.01, ArrowUp: 0.01, ArrowLeft: -0.01, ArrowDown: -0.01, PageUp: 0.1, PageDown: -0.1 }
  if (e.key in map) { e.preventDefault(); setCap(which, cur + map[e.key]) }
  else if (e.key === 'Home') { e.preventDefault(); setCap(which, 0) }
  else if (e.key === 'End') { e.preventDefault(); setCap(which, 1) }
}

function reset(which) {
  if (props.disabled) return
  const d = which === 'lo' ? props.loDefault : props.hiDefault
  if (d != null) setCap(which, toPct(d))
}

const leftCss = pct => `calc(${pct} * (100% - ${CAP}px))`
const fillStyle = computed(() => ({
  left: `calc(${loPct.value} * (100% - ${CAP}px) + ${CAP / 2}px)`,
  right: `calc((1 - ${hiPct.value}) * (100% - ${CAP}px) + ${CAP / 2}px)`,
  background: props.color,
}))
</script>

<template>
  <div class="m-rs" :class="{ 'is-disabled': disabled }">
    <div v-if="label || reading" class="m-rs-head">
      <span class="m-caption">{{ label }}</span>
      <span class="m-rs-reading">{{ reading }}</span>
    </div>
    <div
      ref="slot" class="m-rs-slot"
      @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
    >
      <div class="m-rs-chan"></div>
      <div class="m-rs-fill" :style="fillStyle"></div>
      <button
        type="button" data-cap="lo" class="m-rs-cap m-focusable" :style="{ left: leftCss(loPct) }"
        role="slider" :aria-label="loLabel" :aria-valuemin="min" :aria-valuemax="hi"
        :aria-valuenow="lo" :aria-valuetext="formatValue(lo)" :title="loTitle || undefined"
        :tabindex="disabled ? -1 : 0"
        @keydown="onKey('lo', $event)" @dblclick="reset('lo')"
      ></button>
      <button
        type="button" data-cap="hi" class="m-rs-cap m-focusable" :style="{ left: leftCss(hiPct) }"
        role="slider" :aria-label="hiLabel" :aria-valuemin="lo" :aria-valuemax="max"
        :aria-valuenow="hi" :aria-valuetext="formatValue(hi)" :title="hiTitle || undefined"
        :tabindex="disabled ? -1 : 0"
        @keydown="onKey('hi', $event)" @dblclick="reset('hi')"
      ></button>
    </div>
  </div>
</template>

<style scoped>
.m-rs { display: flex; flex-direction: column; gap: 6px; user-select: none; transition: opacity .15s ease; }
.m-rs.is-disabled { opacity: .4; pointer-events: none; }
.m-rs-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.m-rs-reading { font: 600 10px/1 var(--m-font-mono); letter-spacing: .06em; color: var(--m-ink-2); white-space: nowrap; }
.m-rs-slot { position: relative; height: 26px; cursor: ew-resize; touch-action: none; }
.m-rs-chan {
  position: absolute; left: 0; right: 0; top: 9px; height: 8px; border-radius: 5px;
  background: linear-gradient(180deg, #15171a, #212429);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85), 0 1px 0 rgba(255, 255, 255, .04);
}
.m-rs-fill { position: absolute; top: 9px; height: 8px; border-radius: 5px; opacity: .85; }
.m-rs-cap {
  position: absolute; top: 5px; width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%; cursor: grab;
  background: linear-gradient(160deg, #4c515a, #2a2d33);
  box-shadow: 0 6px 10px -4px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 1px rgba(0, 0, 0, .6);
}
.m-rs-cap:active { cursor: grabbing; }
</style>
