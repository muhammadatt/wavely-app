<script setup>
/**
 * The HF Softener's frequency strip: the input's spectrum and the DETECTOR's
 * band - what it listens to - as a shaded range with a LOW and a HIGH handle,
 * plus a LIVE / MONITOR toggle: MONITOR plays only that band.
 *
 * It shows the detector and nothing about the cut. It drew the cut's range
 * first (and the live cut before that, raw and then damped) and both were
 * dropped: when the Softener is cutting is the activity scope's job (full-height
 * shading on the waveform), and the EQ's own corner (Band) is off the panel and
 * stays at its default. What is left to place is where the detector
 * listens: raise LOW when bright vowels trip the cut, lower HIGH to keep air
 * and breath out of it. MONITOR makes that audible - the detector's own signal
 * is what you hear, so a vowel that leaks into the range is obvious.
 *
 * Each handle is a slider for a keyboard and a screen reader: arrows step
 * 100 Hz (Shift 10), Home/End go to the ends, and double-click resets - the
 * kit's gesture.
 */
import { computed, ref } from 'vue'
import SoftenerSpectrum from '../meters/SoftenerSpectrum.vue'

const props = defineProps({
  /** The detector's band: LOW is its high-pass corner, HIGH its low-pass (top of range = off). */
  detect: { type: Number, required: true },
  detectHigh: { type: Number, required: true },
  detectMin: { type: Number, required: true },
  detectMax: { type: Number, required: true },
  highMin: { type: Number, required: true },
  highMax: { type: Number, required: true },
  /** The closest the two may sit, as a ratio. */
  minRatio: { type: Number, default: 1.25 },
  detectDefault: { type: Number, default: null },
  highDefault: { type: Number, default: null },
  /** The strip's axis, Hz. */
  minHz: { type: Number, default: 500 },
  maxHz: { type: Number, default: 20000 },
  height: { type: Number, default: 150 },
  /** The grid layer's viewBox width, with `height`. */
  viewW: { type: Number, default: 360 },
  gridFreqs: { type: Array, default: () => [] },
  tapFn: { type: Function, default: null },
  listenColor: { type: String, default: 'var(--m-second)' },
  /** AUDITION: the monitor is playing the detector's band. */
  audition: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:detect', 'update:detectHigh', 'update:audition'])

const stripEl = ref(null)
const span = () => Math.log2(props.maxHz / props.minHz)
const pctFor = hz => (Math.log2(hz / props.minHz) / span()) * 100
const quantize = (hz, step) => Math.round(hz / step) * step
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Each handle stops short of the other by minRatio. The top of HIGH's range is
// "off", so while it sits there LOW has the whole of its own range.
const HANDLES = {
  detect: {
    min: () => props.detectMin,
    max: () => (props.detectHigh >= props.highMax ? props.detectMax : Math.min(props.detectMax, props.detectHigh / props.minRatio)),
    def: () => props.detectDefault,
    value: () => props.detect,
  },
  detectHigh: {
    min: () => Math.max(props.highMin, props.detect * props.minRatio),
    max: () => props.highMax,
    def: () => props.highDefault,
    value: () => props.detectHigh,
  },
}

function set(which, hz) {
  const h = HANDLES[which]
  const v = clamp(hz, h.min(), h.max())
  if (v !== h.value()) emit(`update:${which}`, v)
}

const dragging = ref(null)
const atTop = computed(() => props.detectHigh >= props.highMax)

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

const shade = computed(() => ({
  left: `${pctFor(props.detect)}%`,
  width: `${pctFor(props.detectHigh) - pctFor(props.detect)}%`,
  '--c': props.listenColor,
}))
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
      </svg>

      <!-- The detector's band, shaded: only what is inside is heard by it. -->
      <div class="sbs-shade" :style="shade"></div>

      <!-- LOW: where the detector starts listening (its high-pass corner). -->
      <div
        class="sbs-handle sbs-handle--lo"
        :class="{ 'is-dragging': dragging === 'detect', 'is-flip': flip(detect) }"
        :style="{ left: `${pctFor(detect)}%`, '--c': listenColor }"
        role="slider" tabindex="0"
        aria-label="Detector low corner"
        :aria-valuemin="HANDLES.detect.min()" :aria-valuemax="HANDLES.detect.max()" :aria-valuenow="detect"
        :aria-valuetext="fmtHz(detect)"
        title="LOW - where the detector starts listening. Raise it when bright vowels trip the cut: an ordinary S is compensated to read the same at any setting. Drag, or use the arrow keys; double-click to reset"
        @pointerdown="onDown('detect', $event)"
        @pointermove="onMove('detect', $event)"
        @pointerup="onUp" @pointercancel="onUp"
        @keydown="onKey('detect', $event)"
        @dblclick="onReset('detect')"
      >
        <span class="sbs-line"></span>
        <span class="sbs-tab"><b>LOW</b> {{ fmtHz(detect) }}</span>
      </div>

      <!-- HIGH: where it stops (its low-pass corner); at the top it is out of the circuit. -->
      <div
        class="sbs-handle sbs-handle--hi"
        :class="{ 'is-dragging': dragging === 'detectHigh', 'is-edge': atTop }"
        :style="{ left: `${pctFor(detectHigh)}%`, '--c': listenColor }"
        role="slider" tabindex="0"
        aria-label="Detector high corner"
        :aria-valuemin="HANDLES.detectHigh.min()" :aria-valuemax="highMax" :aria-valuenow="detectHigh"
        :aria-valuetext="atTop ? 'off' : fmtHz(detectHigh)"
        title="HIGH - where the detector stops listening. Lower it to keep air and breath out of the detector; at the top it is off. Drag, or use the arrow keys; double-click to reset"
        @pointerdown="onDown('detectHigh', $event)"
        @pointermove="onMove('detectHigh', $event)"
        @pointerup="onUp" @pointercancel="onUp"
        @keydown="onKey('detectHigh', $event)"
        @dblclick="onReset('detectHigh')"
      >
        <span class="sbs-line"></span>
        <span class="sbs-tab"><b>HIGH</b> {{ atTop ? 'OFF' : fmtHz(detectHigh) }}</span>
      </div>

      <!-- LIVE / MONITOR: the processed audio, or only what the detector hears. -->
      <div class="sbs-mode" role="group" aria-label="Output monitor" :style="{ '--c': listenColor }">
        <button
          type="button" class="sbs-mode-btn" :class="{ 'is-on': !audition }"
          :disabled="disabled" :aria-pressed="!audition"
          title="LIVE - the processed audio, as Apply will render it"
          @click="audition && emit('update:audition', false)"
        >LIVE</button>
        <button
          type="button" class="sbs-mode-btn" :class="{ 'is-on': audition }"
          :disabled="disabled" :aria-pressed="audition"
          title="MONITOR - play only what the detector hears (the shaded band). Use it to check that vowels and breath stay out of the range. Monitoring only; Apply always renders the processed audio"
          @click="!audition && emit('update:audition', true)"
        >MONITOR</button>
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
  user-select: none;
  outline: none;
}
/* At the top of the range the line would sit on the well's clipped edge, where
   only half the handle can be grabbed: pull it fully inside. */
.sbs-handle.is-edge { margin-left: -14px; }
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
.sbs-handle--lo .sbs-line,
.sbs-handle--hi .sbs-line {
  background: repeating-linear-gradient(to bottom, var(--c) 0 3px, transparent 3px 6px);
}
.sbs-shade {
  position: absolute;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--c) 13%, transparent);
  pointer-events: none;
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
.sbs-handle--hi .sbs-tab { top: 0; }
.sbs-handle--lo .sbs-tab { bottom: 0; }
/* HIGH's tab always hangs to the left, into the shaded range, and from the top
   so it cannot meet LOW's tab (bottom, to the right) when the two are close. */
.sbs-handle--hi .sbs-tab,
.sbs-handle.is-flip .sbs-tab {
  left: auto;
  right: 7px;
  border-radius: 4px 0 0 4px;
  padding: 3px 6px 3px 7px;
}
.sbs-handle:hover .sbs-line,
.sbs-handle.is-dragging .sbs-line { opacity: 1; width: 2px; left: 6px; }
.sbs-handle:focus-visible .sbs-tab { outline: 2px solid #7fe9f6; outline-offset: 1px; }

/* Two halves of one pill: the lit half is the mode you are hearing. */
.sbs-mode {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 999px;
  background: rgba(11, 14, 19, .8);
}
.sbs-mode-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--m-ink-3);
  font: 700 9px/1 var(--m-font-ui);
  letter-spacing: .14em;
  cursor: pointer;
}
.sbs-mode-btn:hover:not(:disabled):not(.is-on) { color: #fff; }
.sbs-mode-btn:disabled { cursor: default; }
.sbs-mode-btn:focus-visible { outline: 2px solid #7fe9f6; outline-offset: 1px; }
.sbs-mode-btn.is-on { color: #0b0e13; background: var(--c); box-shadow: 0 0 8px color-mix(in srgb, var(--c) 55%, transparent); }

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
