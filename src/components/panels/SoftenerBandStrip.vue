<script setup>
/**
 * The HF Softener's frequency strip: the input's spectrum, the RANGE of the
 * cut (the most the EQ may take, with the Air lift after it), and the two
 * corners as handles on it — the SSL DeEss layout.
 *
 * ⚠ IT IS STATIC ON PURPOSE. It drew the live cut first — raw, then damped
 * with a held line and a glow — and both read as busy: two moving curves on a
 * strip whose job is setting where and how far. When it is cutting is the
 * activity scope's job (full-height shading on the waveform).
 *
 *   CUT (Band)      a solid flag hung from the top: where the EQ cuts.
 *   LISTEN (Detect) a dashed marker standing on the bottom: where the detector
 *                   starts listening.
 *
 * ⚠ TWO HANDLES, NOT ONE, AND NOT LINKED. They answer opposite problems: a
 * bright voice whose vowels trip the detector wants LISTEN up, and the same
 * voice's low "s" wants CUT down. One knob over both would trade one fix for
 * the other (see the dev log, "HF Softener — full entry"). They share a strip
 * so the pair reads as one control surface, not so they move together.
 *
 * Each handle is a slider for a keyboard and a screen reader: arrows step
 * 100 Hz (Shift 10), Home/End go to the ends, and double-click resets — the
 * kit's gesture.
 */
import { ref } from 'vue'
import SoftenerSpectrum from '../meters/SoftenerSpectrum.vue'

const props = defineProps({
  band: { type: Number, required: true },
  detect: { type: Number, required: true },
  bandMin: { type: Number, required: true },
  bandMax: { type: Number, required: true },
  detectMin: { type: Number, required: true },
  detectMax: { type: Number, required: true },
  bandDefault: { type: Number, default: null },
  detectDefault: { type: Number, default: null },
  /** The strip's axis, Hz. */
  minHz: { type: Number, default: 500 },
  maxHz: { type: Number, default: 20000 },
  height: { type: Number, default: 150 },
  /** The curve layer, drawn by the caller in a `viewW × height` viewBox. */
  viewW: { type: Number, default: 360 },
  /** The cut's range — what the settings allow, not what is happening. */
  curvePath: { type: String, default: '' },
  curveFill: { type: String, default: '' },
  zeroY: { type: Number, default: 0 },
  gridFreqs: { type: Array, default: () => [] },
  tapFn: { type: Function, default: null },
  accent: { type: String, default: 'var(--m-accent)' },
  listenColor: { type: String, default: 'var(--m-second)' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:band', 'update:detect'])

const stripEl = ref(null)
const span = () => Math.log2(props.maxHz / props.minHz)
const pctFor = hz => (Math.log2(hz / props.minHz) / span()) * 100
const quantize = (hz, step) => Math.round(hz / step) * step
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const HANDLES = {
  band: { min: () => props.bandMin, max: () => props.bandMax, def: () => props.bandDefault, value: () => props.band },
  detect: { min: () => props.detectMin, max: () => props.detectMax, def: () => props.detectDefault, value: () => props.detect },
}

function set(which, hz) {
  const h = HANDLES[which]
  const v = clamp(hz, h.min(), h.max())
  if (v !== h.value()) emit(`update:${which}`, v)
}

const dragging = ref(null)

function hzAt(clientX) {
  const r = stripEl.value.getBoundingClientRect()
  const t = clamp((clientX - r.left) / r.width, 0, 1)
  return props.minHz * Math.pow(2, t * span())
}

function onDown(which, e) {
  if (props.disabled) return
  e.preventDefault()
  e.stopPropagation()
  e.currentTarget.setPointerCapture(e.pointerId)
  e.currentTarget.focus({ preventScroll: true })
  dragging.value = which
}
function onMove(which, e) {
  if (dragging.value !== which) return
  set(which, quantize(hzAt(e.clientX), e.shiftKey ? 10 : 100))
}
function onUp(e) {
  if (!dragging.value) return
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  dragging.value = null
}
function onKey(which, e) {
  if (props.disabled) return
  const h = HANDLES[which]
  const step = e.shiftKey ? 10 : 100
  const k = e.key
  let v = null
  if (k === 'ArrowRight' || k === 'ArrowUp') v = h.value() + step
  else if (k === 'ArrowLeft' || k === 'ArrowDown') v = h.value() - step
  else if (k === 'PageUp') v = h.value() + 500
  else if (k === 'PageDown') v = h.value() - 500
  else if (k === 'Home') v = h.min()
  else if (k === 'End') v = h.max()
  if (v === null) return
  e.preventDefault()
  set(which, v)
}
function onReset(which) {
  const d = HANDLES[which].def()
  if (!props.disabled && d != null) set(which, d)
}

// One decimal on the 100 Hz grid the drag and arrows use; two after a Shift step.
const fmtHz = hz => `${(hz / 1000).toFixed(hz % 100 === 0 ? 1 : 2)} kHz`
const gridLabel = f => (f >= 1000 ? `${f / 1000}k` : String(f))

/** A tab sits right of its line, and flips left near the right edge. */
const flip = hz => pctFor(hz) > 78
</script>

<template>
  <div class="sbs" :class="{ 'is-disabled': disabled }">
    <div ref="stripEl" class="sbs-well" :style="{ height: `${height}px` }">
      <SoftenerSpectrum v-if="tapFn" :tap-fn="tapFn" :min-hz="minHz" :max-hz="maxHz" />
      <svg
        :viewBox="`0 0 ${viewW} ${height}`"
        class="sbs-curve"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          v-for="f in gridFreqs" :key="f"
          :x1="(pctFor(f) / 100) * viewW" :y1="0" :x2="(pctFor(f) / 100) * viewW" :y2="height"
          stroke="rgba(255,255,255,.06)" stroke-width="1" vector-effect="non-scaling-stroke"
        />
        <line :x1="0" :y1="zeroY" :x2="viewW" :y2="zeroY" stroke="rgba(255,255,255,.16)" stroke-width="1" vector-effect="non-scaling-stroke" />
        <path :d="curveFill" :fill="accent" fill-opacity="0.16" />
        <path :d="curvePath" :stroke="accent" stroke-width="2" fill="none" vector-effect="non-scaling-stroke" />
      </svg>

      <!-- LISTEN: a dashed marker standing on the bottom edge. -->
      <div
        class="sbs-handle sbs-handle--listen"
        :class="{ 'is-dragging': dragging === 'detect', 'is-flip': flip(detect) }"
        :style="{ left: `${pctFor(detect)}%`, '--c': listenColor }"
        role="slider" tabindex="0"
        aria-label="Listen from (detector corner)"
        :aria-valuemin="detectMin" :aria-valuemax="detectMax" :aria-valuenow="detect"
        :aria-valuetext="fmtHz(detect)"
        title="LISTEN — where the detector starts listening. Raise it when bright vowels trip the cut: an ordinary S is compensated to read the same at any setting. Drag, or use the arrow keys; double-click to reset"
        @pointerdown="onDown('detect', $event)"
        @pointermove="onMove('detect', $event)"
        @pointerup="onUp" @pointercancel="onUp"
        @keydown="onKey('detect', $event)"
        @dblclick="onReset('detect')"
      >
        <span class="sbs-line"></span>
        <span class="sbs-tab"><b>LISTEN</b> {{ fmtHz(detect) }}</span>
      </div>

      <!-- CUT: a solid flag hung from the top edge. -->
      <div
        class="sbs-handle sbs-handle--cut"
        :class="{ 'is-dragging': dragging === 'band', 'is-flip': flip(band) }"
        :style="{ left: `${pctFor(band)}%`, '--c': accent }"
        role="slider" tabindex="0"
        aria-label="Cut from (EQ band corner)"
        :aria-valuemin="bandMin" :aria-valuemax="bandMax" :aria-valuenow="band"
        :aria-valuetext="fmtHz(band)"
        title="CUT — where the EQ cuts, the band's lower corner. Lower it for an S that sits low (deeper voices, SH); raise it for a high, thin S. Drag, or use the arrow keys; double-click to reset"
        @pointerdown="onDown('band', $event)"
        @pointermove="onMove('band', $event)"
        @pointerup="onUp" @pointercancel="onUp"
        @keydown="onKey('band', $event)"
        @dblclick="onReset('band')"
      >
        <span class="sbs-line"></span>
        <span class="sbs-tab"><b>CUT</b> {{ fmtHz(band) }}</span>
      </div>
    </div>

    <div class="sbs-axis">
      <span
        v-for="f in gridFreqs" :key="f"
        :style="{ left: `${pctFor(f)}%`, transform: pctFor(f) > 97 ? 'translateX(-100%)' : 'translateX(-50%)' }"
      >{{ gridLabel(f) }}</span>
    </div>
  </div>
</template>

<style scoped>
.sbs { min-width: 0; }
.sbs.is-disabled { opacity: .55; }
.sbs-well {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.sbs-well > :deep(canvas) { position: absolute; inset: 0; width: 100%; height: 100%; }
.sbs-curve { position: absolute; inset: 0; width: 100%; height: 100%; }

.sbs-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  margin-left: -7px;
  cursor: ew-resize;
  touch-action: none;
  outline: none;
}
.sbs.is-disabled .sbs-handle { cursor: default; }
.sbs-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 6.5px;
  width: 1px;
  background: var(--c);
  opacity: .85;
}
.sbs-handle--listen .sbs-line {
  background: repeating-linear-gradient(to bottom, var(--c) 0 3px, transparent 3px 6px);
}
.sbs-tab {
  position: absolute;
  left: 7px;
  padding: 3px 7px 3px 6px;
  border-radius: 0 4px 4px 0;
  white-space: nowrap;
  font: 600 9px/1 var(--m-font-mono);
  letter-spacing: .06em;
  font-variant-numeric: tabular-nums;
  color: #0b0e13;
  background: var(--c);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .6);
}
.sbs-tab b { font-weight: 800; letter-spacing: .12em; margin-right: 3px; }
.sbs-handle--cut .sbs-tab { top: 0; }
.sbs-handle--listen .sbs-tab { bottom: 0; }
.sbs-handle.is-flip .sbs-tab {
  left: auto;
  right: 7px;
  border-radius: 4px 0 0 4px;
  padding: 3px 6px 3px 7px;
}
.sbs-handle:hover .sbs-line,
.sbs-handle.is-dragging .sbs-line { opacity: 1; width: 2px; left: 6px; }
.sbs-handle:focus-visible .sbs-tab { outline: 2px solid #7fe9f6; outline-offset: 1px; }

.sbs-axis {
  position: relative;
  height: 10px;
  margin-top: 4px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.sbs-axis span { position: absolute; top: 0; }
</style>
