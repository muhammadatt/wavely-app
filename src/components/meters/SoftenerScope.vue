<script setup>
import { ref } from 'vue'
import { useMeterFrame } from './ballistics.js'
import { kindRuns, shadeColumns } from '../../audio/hfSoftenerScope.js'

/**
 * HF Softener's activity scope: the waveform, with every stretch the
 * Softener worked on SHADED full height — the way most de-essers mark the
 * regions they treat.
 *
 * ⚠ IT WAS A RIM, AND THE RIM COULD NOT BE SEEN. The first version painted
 * only the removed energy, as a coloured edge between the input and output
 * envelopes — exact, but a few pixels thick on a typical 4–8 dB cut, and the
 * plosive and guard marks were thinner still. Full-height shading answers
 * the question the scope is for ("is it working, and where") at a glance;
 * how DEEP it cut is the shading's strength, and the exact figures are in the
 * readout above. Before that, reduction lanes on a dB axis were rejected as a
 * second picture to relate back to the audio.
 *
 * Layout is ClipperScope's, for the reasons argued there: the playhead at the
 * CENTRE, the kernel's measured history to its left, the timeline ahead of it
 * to its right, drawn dimmer because the Softener has not seen that audio yet
 * — it cannot be shaded, since the cut depends on what came just before. When
 * the ring is not live (bypass, stopped transport) the left half falls back to
 * the timeline too, so the picture always moves as one waveform.
 *
 * Marks (smoothed into regions by shadeColumns, hfSoftenerScope.js):
 *   accent wash    — de-essed by the Duck and EQ; stronger the deeper the cut
 *   plosive wash   — the same, inside a T/K/P burst window (guard lifted)
 *   bar on bottom  — the lisp guard held the cut back somewhere in the region
 */
const props = defineProps({
  /** Returns the effect's scope ring (hfSoftenerScope.js), or null. */
  dataFn: { type: Function, required: true },
  /**
   * `(offsetSeconds, seconds, columns) => Float32Array | null` — the timeline's
   * peak envelope around the playhead; see ClipperScope's envelopeFn.
   */
  envelopeFn: { type: Function, default: null },
  /** Total seconds across the face: twice the ring's history. */
  windowSeconds: { type: Number, default: 4 },
  accent: { type: String, default: '#e8b77f' },
  plosiveColor: { type: String, default: '#b9a6f2' },
  height: { type: Number, default: 140 },
  title: { type: String, default: 'HF Softener activity' },
})

const emit = defineEmits(['requestPlay'])

const canvasEl = ref(null)
const isIdle = ref(true)

// amplitude^0.45, ClipperScope's axis: a linear one puts quiet speech in the
// bottom few pixels, and this stays monotonic, so a rim drawn outside the grey
// is energy that genuinely left.
const SCALE_EXP = 0.45
const ampToUnit = (a) => Math.pow(Math.min(1, Math.max(0, a)), SCALE_EXP)

const LOOKAHEAD_COLUMNS = 512
const PREDICTED_ALPHA = 0.45
// Wash opacity: faint at the threshold, full at FULL_DB of cut.
const WASH_MIN = 0.16
const WASH_MAX = 0.5
const FULL_DB = 9
const BAR_H = 3
const STALE_MS = 300

// Scratch for the history half, sized for the largest ring any rate produces
// over the window (one column per 128 samples) — a frame allocates nothing.
const SCRATCH = 8192
const hIn = new Float32Array(SCRATCH)
const hOut = new Float32Array(SCRATCH)
const hHeld = new Float32Array(SCRATCH)
const hBurst = new Float32Array(SCRATCH)
const hDepth = new Float32Array(SCRATCH)
const hKind = new Uint8Array(SCRATCH)
const hGuard = new Uint8Array(SCRATCH)

let staleMs = 0
let lastHead = -1
let lastFilled = -1

useMeterFrame((dtMs) => draw(dtMs))

function draw(dtMs) {
  const canvas = canvasEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  const scope = props.dataFn?.() ?? null
  if (scope && (scope.head !== lastHead || scope.filled !== lastFilled)) {
    lastHead = scope.head
    lastFilled = scope.filled
    staleMs = 0
  } else {
    staleMs += dtMs
  }
  const haveRing = scope !== null && scope.filled > 0
  const ringLive = haveRing && staleMs < STALE_MS

  ctx.fillStyle = '#08060a'
  ctx.fillRect(0, 0, w, h)
  const mid = h / 2
  const half = mid - 3

  ctx.strokeStyle = 'rgba(255,255,255,.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid + 0.5)
  ctx.lineTo(w, mid + 0.5)
  ctx.stroke()

  const centreX = Math.round(w / 2)
  const halfSeconds = props.windowSeconds / 2
  const future = props.envelopeFn?.(0, halfSeconds, LOOKAHEAD_COLUMNS) ?? null
  const behind = ringLive ? null : (props.envelopeFn?.(-halfSeconds, halfSeconds, LOOKAHEAD_COLUMNS) ?? null)
  const frozen = !ringLive && !behind
  const lookStep = centreX / Math.max(1, LOOKAHEAD_COLUMNS - 1)

  if (ringLive || (frozen && haveRing)) {
    const m = Math.min(scope.filled, scope.capacity, SCRATCH)
    const start = (scope.head - m + scope.capacity) % scope.capacity
    for (let i = 0; i < m; i++) {
      const k = (start + i) % scope.capacity
      hIn[i] = scope.inPeak[k]
      hOut[i] = scope.outPeak[k]
      hHeld[i] = scope.held[k]
      hBurst[i] = scope.burst[k]
    }
    shadeColumns(hIn, hOut, hBurst, hHeld, m, hDepth, hKind, hGuard)
    const step = centreX / Math.max(1, scope.capacity - 1)
    drawHistory(ctx, m, centreX - (m - 1) * step, step, h, mid, half, ringLive ? 1 : 0.35)
  } else if (behind) {
    drawEnvelope(ctx, behind, LOOKAHEAD_COLUMNS, centreX - (LOOKAHEAD_COLUMNS - 1) * lookStep, lookStep, mid, half, PREDICTED_ALPHA)
  }
  if (future) {
    const futStep = (w - centreX) / Math.max(1, LOOKAHEAD_COLUMNS - 1)
    drawEnvelope(ctx, future, LOOKAHEAD_COLUMNS, centreX, futStep, mid, half, PREDICTED_ALPHA)
  }

  isIdle.value = !haveRing
  drawPlayhead(ctx, centreX, h)
  if (!isIdle.value) drawLegend(ctx, h)
}

/** A plain grey envelope — the timeline, where the Softener has not been. */
function drawEnvelope(ctx, peaks, n, x0, step, mid, half, alpha) {
  if (n <= 0) return
  ctx.globalAlpha = alpha
  ctx.fillStyle = 'rgba(200,205,215,.55)'
  ctx.beginPath()
  ctx.moveTo(x0, mid)
  for (let i = 0; i < n; i++) ctx.lineTo(x0 + i * step, mid - ampToUnit(peaks[i]) * half)
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(x0 + i * step, mid + ampToUnit(peaks[i]) * half)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1
}

/**
 * The measured half: the shading first, full height, then the output waveform
 * over it in grey so the audio stays readable through the wash.
 */
function drawHistory(ctx, n, x0, step, h, mid, half, alpha) {
  if (n <= 0) return
  const xAt = (i) => x0 + i * step
  // Each column is a slice of time, so a column is drawn half a step either
  // side of its point — a one-column onset is still a visible stripe.
  const pad = Math.max(step / 2, 0.5)

  // One rect per device-independent pixel, at the deepest column landing in
  // it: columns are narrower than a pixel at most widths, and overlapping
  // translucent rects would stack their alpha into false depth.
  let px = -1
  let pxDepth = 0
  let pxKind = 0
  const flush = () => {
    if (pxKind === 0) return
    ctx.fillStyle = pxKind === 2 ? props.plosiveColor : props.accent
    ctx.globalAlpha = alpha * (WASH_MIN + (WASH_MAX - WASH_MIN) * Math.min(1, pxDepth / FULL_DB))
    ctx.fillRect(px, BAR_H, 1, h - 2 * BAR_H)
  }
  for (let i = 0; i < n; i++) {
    const x = Math.floor(xAt(i))
    if (x !== px) {
      flush()
      px = x
      pxDepth = 0
      pxKind = 0
    }
    if (hKind[i] !== 0) {
      pxDepth = Math.max(pxDepth, hDepth[i])
      pxKind = Math.max(pxKind, hKind[i])
    }
  }
  flush()
  // A solid edge along the top marks each region's extent at any depth.
  ctx.globalAlpha = alpha
  for (const [kind, colour] of [[1, props.accent], [2, props.plosiveColor]]) {
    ctx.fillStyle = colour
    for (const [from, to] of kindRuns(hKind, n, kind)) {
      ctx.fillRect(xAt(from) - pad, 0, xAt(to) - xAt(from) + 2 * pad, BAR_H)
    }
  }
  ctx.globalAlpha = 1

  drawEnvelope(ctx, hOut, n, x0, step, mid, half, alpha)

  // The guard: a bar along the bottom where it held the cut back.
  ctx.globalAlpha = alpha
  ctx.fillStyle = 'rgba(255,255,255,.85)'
  for (const [from, to] of kindRuns(hGuard, n, 1)) {
    ctx.fillRect(xAt(from) - pad, h - BAR_H, xAt(to) - xAt(from) + 2 * pad, BAR_H)
  }
  ctx.globalAlpha = 1
}

/** White, as in ClipperScope: every coloured pixel here means "removed". */
function drawPlayhead(ctx, x, h) {
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(255,255,255,.55)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x + 0.5, 0)
  ctx.lineTo(x + 0.5, h)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,.85)'
  ctx.beginPath()
  ctx.moveTo(x - 4.5, 0)
  ctx.lineTo(x + 5.5, 0)
  ctx.lineTo(x + 0.5, 6)
  ctx.closePath()
  ctx.fill()
}

function drawLegend(ctx, h) {
  const y = h - 7
  ctx.font = "600 8px 'JetBrains Mono',monospace"
  ctx.textAlign = 'left'
  // A dark backing, so the key reads over a shaded region.
  ctx.fillStyle = 'rgba(8,6,10,.75)'
  ctx.fillRect(2, y - 10, 196, 14)
  let x = 6
  for (const [colour, text, bar] of [
    [props.accent, 'DE-ESSED', false],
    [props.plosiveColor, 'PLOSIVE', false],
    ['rgba(255,255,255,.85)', 'GUARD', true],
  ]) {
    ctx.fillStyle = colour
    if (bar) ctx.fillRect(x, y - 3, 9, BAR_H)
    else ctx.fillRect(x, y - 5, 7, 6)
    x += bar ? 13 : 11
    ctx.fillStyle = 'rgba(255,255,255,.4)'
    ctx.fillText(text, x, y)
    x += ctx.measureText(text).width + 14
  }
}
</script>

<template>
  <div class="relative w-full" :style="{ height: `${height}px` }">
    <canvas
      ref="canvasEl"
      class="block w-full h-full rounded-[6px]"
      style="box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)"
      role="img"
      :aria-label="title"
    ></canvas>
    <button
      v-if="isIdle"
      type="button"
      class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-[12px] py-[5px] rounded-full"
      style="font:600 9.5px 'JetBrains Mono',monospace;letter-spacing:.06em;color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.14);background:rgba(8,6,10,.6)"
      @click="emit('requestPlay')"
    >
      ▶&nbsp; press play to see what it takes
    </button>
  </div>
</template>
