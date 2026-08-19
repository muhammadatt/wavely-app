<script setup>
import { computed, ref } from 'vue'
import { useMeterFrame } from './ballistics.js'

/**
 * Scrolling scope for the Soft Clipper: the input envelope, the threshold, and
 * the part of each transient that crosses it.
 *
 * WHY THIS EXISTS. The peak-reduction bar answers "how much" and cannot answer
 * "on what" — and on this stage those come apart badly. Measured on a real
 * narration clip at the default, the blocks that clip take a MEDIAN of
 * 0.3-0.4 dB, which on a 12 dB meter face under VU ballistics looks like an
 * idle needle. The stage was audibly colouring passages while the only
 * instrument on the panel read zero, and that mismatch is exactly what made
 * the earlier over-processing so hard to pin down by ear. A scope shows the
 * crossings themselves, so "it is working here and not there" is visible
 * rather than inferred.
 *
 * THE THRESHOLD IS A CURVE, NOT A LINE, and that is the second reason. In
 * adaptive mode T rides the speaker's own level on a 3 s tracker; drawing it
 * over time is the only way the adaptive behaviour is observable at all —
 * including the warm-up, where it sits above full scale and the stage
 * deliberately does nothing.
 *
 * READ-ONLY IN ADAPTIVE, DRAGGABLE IN FIXED. In adaptive mode the curve is a
 * readout of a measurement — there is nothing to set, and making it look
 * grabbable would promise a control that cannot exist. In fixed mode it IS the
 * parameter, so it becomes a handle.
 */
const props = defineProps({
  /**
   * Returns the effect's scope ring, or null. A function rather than a value:
   * this is ~1400 floats at ~46 Hz feeding a canvas that redraws every frame
   * regardless, and putting it through reactivity would make Vue diff typed
   * arrays for nothing. Same arrangement as ResonanceSpectrum's dataFn.
   */
  dataFn: { type: Function, required: true },
  /** 'adaptive' | 'fixed' — decides whether the curve is a handle. */
  mode: { type: String, default: 'adaptive' },
  /** The fixed threshold in dBFS. Only meaningful (and only shown) in fixed mode. */
  fixedThresholdDb: { type: Number, default: -10 },
  /** Drag limits, matching the Fixed dBFS knob's own range. */
  minDb: { type: Number, default: -24 },
  maxDb: { type: Number, default: -1 },
  accent: { type: String, default: '#ff8f6b' },
  height: { type: Number, default: 150 },
  /** Canvas is opaque to a screen reader; this is what names it. */
  title: { type: String, default: 'Clipper scope' },
})

const emit = defineEmits(['update:fixedThresholdDb'])

const canvasEl = ref(null)
const isFixed = computed(() => props.mode === 'fixed')

/**
 * Vertical scale: amplitude^0.45, not linear.
 *
 * A linear axis puts the bottom of the fixed range (-24 dBFS) at 6% of the
 * half-height, which makes both the waveform down there and the drag itself
 * unusable — a whole third of the knob's travel squeezed into a few pixels.
 * The power curve puts it at 30% instead. It stays strictly monotonic, so a
 * peak drawn above the threshold line is a peak that genuinely crossed it,
 * which is the one thing this display must never get wrong.
 */
const SCALE_EXP = 0.45
const ampToUnit = (a) => Math.pow(Math.min(1, Math.max(0, a)), SCALE_EXP)
const unitToAmp = (u) => Math.pow(Math.min(1, Math.max(0, u)), 1 / SCALE_EXP)

const dbToLin = (db) => Math.pow(10, db / 20)
const linToDb = (a) => (a > 1e-6 ? 20 * Math.log10(a) : -120)

// Staleness: a stopped transport leaves the last picture up but dimmed, rather
// than blanking — the frozen scroll is still the truth about the moment it
// stopped, and a blank panel reads as broken.
const STALE_MS = 300
let staleMs = 0
let lastHead = -1

useMeterFrame((dtMs) => draw(dtMs))

function draw(dtMs) {
  const canvas = canvasEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  // Setting width resets the context, so the DPR scale is re-applied per frame
  // rather than saved and restored — same as the other canvas meters here.
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  const scope = props.dataFn?.() ?? null
  if (scope && scope.head !== lastHead) {
    lastHead = scope.head
    staleMs = 0
  } else {
    staleMs += dtMs
  }
  const live = scope !== null && staleMs < STALE_MS
  ctx.globalAlpha = live ? 1 : 0.35

  ctx.fillStyle = '#08060a'
  ctx.fillRect(0, 0, w, h)

  const mid = h / 2
  const half = mid - 2

  // Centre line
  ctx.strokeStyle = 'rgba(255,255,255,.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid + 0.5)
  ctx.lineTo(w, mid + 0.5)
  ctx.stroke()

  if (!scope || scope.filled === 0) {
    ctx.globalAlpha = 1
    drawIdleLabel(ctx, w, mid)
    return
  }

  // Oldest sample sits at x=0 and the newest at x=w, so the picture scrolls
  // leftward the way every scope does. When the ring is not yet full the
  // history is short, and it is drawn compressed into the full width rather
  // than left-aligned — a partially filled buffer should read as "less
  // history", not as a signal that stops halfway across.
  const n = scope.filled
  const start = (scope.head - n + scope.capacity) % scope.capacity
  const xStep = w / Math.max(1, n - 1)

  // ── Envelope, split at the threshold ──
  // Two passes over the same points: the body below the threshold in grey, and
  // only the part standing above it in accent. Drawing the whole envelope
  // accent-coloured wherever it clips would exaggerate the effect wildly —
  // 0.3 dB of reduction would light a full-height transient.
  ctx.fillStyle = 'rgba(200,205,215,.55)'
  ctx.beginPath()
  ctx.moveTo(0, mid)
  for (let i = 0; i < n; i++) {
    const p = scope.peak[(start + i) % scope.capacity]
    ctx.lineTo(i * xStep, mid - ampToUnit(p) * half)
  }
  for (let i = n - 1; i >= 0; i--) {
    const p = scope.peak[(start + i) % scope.capacity]
    ctx.lineTo(i * xStep, mid + ampToUnit(p) * half)
  }
  ctx.closePath()
  ctx.fill()

  // The excess above the threshold, mirrored top and bottom.
  ctx.fillStyle = props.accent
  for (const sign of [-1, 1]) {
    ctx.beginPath()
    let open = false
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % scope.capacity
      const p = scope.peak[idx]
      const t = scope.threshold[idx]
      const x = i * xStep
      if (p > t) {
        const yPeak = mid + sign * ampToUnit(p) * half
        const yT = mid + sign * ampToUnit(t) * half
        if (!open) { ctx.moveTo(x, yT); open = true }
        ctx.lineTo(x, yPeak)
        ctx.lineTo(x, yT)
      }
    }
    if (open) ctx.fill()
  }

  // ── Threshold ──
  // Drawn from the kernel's own per-point values, so in adaptive mode this is
  // the curve the audio was actually decided against rather than a redrawn
  // approximation of it.
  ctx.strokeStyle = props.accent
  ctx.lineWidth = isFixed.value ? 2 : 1.5
  ctx.globalAlpha = (live ? 1 : 0.35) * (isFixed.value ? 1 : 0.75)
  for (const sign of [-1, 1]) {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const t = scope.threshold[(start + i) % scope.capacity]
      const y = mid + sign * ampToUnit(t) * half
      if (i === 0) ctx.moveTo(i * xStep, y)
      else ctx.lineTo(i * xStep, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  drawLabel(ctx, w, h, mid, half, scope, start, n)
}

function drawIdleLabel(ctx, w, mid) {
  ctx.fillStyle = 'rgba(255,255,255,.25)'
  ctx.font = "600 9.5px 'JetBrains Mono',monospace"
  ctx.textAlign = 'center'
  ctx.fillText('press play to see the signal', w / 2, mid - 8)
  ctx.textAlign = 'left'
}

function drawLabel(ctx, w, h, mid, half, scope, start, n) {
  // The newest threshold is the one worth printing — in fixed mode it is the
  // parameter, in adaptive it is where the detector has currently landed.
  const latest = scope.threshold[(start + n - 1) % scope.capacity]
  const db = linToDb(latest)
  ctx.font = "600 9.5px 'JetBrains Mono',monospace"

  ctx.fillStyle = 'rgba(255,255,255,.38)'
  ctx.fillText(isFixed.value ? 'threshold — drag to set' : 'threshold — follows the voice', 10, 16)

  ctx.fillStyle = props.accent
  ctx.textAlign = 'right'
  ctx.fillText(`${db.toFixed(1)} dB`, w - 10, 16)
  ctx.textAlign = 'left'
}

// ── Drag, fixed mode only ───────────────────────────────────────────────────

function yToDb(clientY) {
  const canvas = canvasEl.value
  if (!canvas) return props.fixedThresholdDb
  const rect = canvas.getBoundingClientRect()
  const mid = rect.height / 2
  const half = mid - 2
  // Symmetric: grabbing either the upper or the lower trace sets the same
  // threshold, because they are two views of one number.
  const unit = Math.min(1, Math.abs(clientY - rect.top - mid) / half)
  const db = linToDb(unitToAmp(unit))
  return Math.min(props.maxDb, Math.max(props.minDb, db))
}

function onPointerDown(e) {
  if (!isFixed.value) return
  canvasEl.value?.setPointerCapture?.(e.pointerId)
  emit('update:fixedThresholdDb', yToDb(e.clientY))
}

function onPointerMove(e) {
  // Only while captured — `buttons` is 0 on a hover, so this needs no separate
  // dragging flag.
  if (!isFixed.value || e.buttons === 0) return
  emit('update:fixedThresholdDb', yToDb(e.clientY))
}

function onPointerUp(e) {
  canvasEl.value?.releasePointerCapture?.(e.pointerId)
}
</script>

<template>
  <div
    class="relative w-full overflow-hidden"
    :style="{
      height: height + 'px',
      borderRadius: '6px',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
    }"
  >
    <canvas
      ref="canvasEl"
      class="block w-full h-full"
      :style="{ cursor: isFixed ? 'ns-resize' : 'default' }"
      :aria-label="title"
      role="img"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    ></canvas>
  </div>
</template>
