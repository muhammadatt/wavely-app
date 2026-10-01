<script setup>
import { ref } from 'vue'
import { useMeterFrame } from './ballistics.js'
import { columnKind, kindRuns } from '../../audio/hfSoftenerScope.js'

/**
 * HF Softener's activity scope: the waveform with what the Softener removed
 * painted on it, the way Pro-DS shows treated regions.
 *
 * WHY ON THE WAVEFORM AND NOT AS REDUCTION LANES. The first mockup hung the
 * Duck and EQ reductions from the top edge on a dB scale, and it was rejected
 * from review as not user-friendly: two lanes on their own axis are a second
 * picture to relate back to the audio. Drawn on the waveform, the removed
 * energy sits exactly on the "s" it came from — the grey shape is what you
 * hear, the coloured rim around it is what went, and its thickness is how
 * much. The Duck / EQ split lives in the readout under the scope.
 *
 * Layout is ClipperScope's, for the reasons argued there: the playhead at the
 * CENTRE, the kernel's measured history to its left, the timeline ahead of it
 * to its right, drawn dimmer because the Softener has not seen that audio yet
 * — it cannot be shaded, since the cut depends on what came just before. When
 * the ring is not live (bypass, stopped transport) the left half falls back to
 * the timeline too, so the picture always moves as one waveform.
 *
 * Three marks:
 *   accent rim    — removed by the Duck and EQ (output under input by ≥ 0.75 dB)
 *   plosive rim   — the same, inside a T/K/P burst window (guard lifted)
 *   dashed line   — where the waveform would have gone WITHOUT the lisp guard;
 *                   the gap between it and the grey is what the guard kept.
 *                   An estimate: the held dB applied to the output peak, which
 *                   is exact for the Duck and generous for the EQ's band cut.
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
const HELD_DB = 0.5
const STALE_MS = 300

// Scratch for the history half, sized for the largest ring any rate produces
// over the window (one column per 128 samples) — a frame allocates nothing.
const SCRATCH = 8192
const hIn = new Float32Array(SCRATCH)
const hOut = new Float32Array(SCRATCH)
const hHeld = new Float32Array(SCRATCH)
const hKind = new Uint8Array(SCRATCH)

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
      hKind[i] = columnKind(hIn[i], hOut[i], scope.burst[k])
    }
    const step = centreX / Math.max(1, scope.capacity - 1)
    drawHistory(ctx, m, centreX - (m - 1) * step, step, mid, half, ringLive ? 1 : 0.35)
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
 * The measured half: the output envelope in grey, then a rim from the output
 * out to the input on every treated run, then the guard's line inside it.
 */
function drawHistory(ctx, n, x0, step, mid, half, alpha) {
  if (n <= 0) return
  const xAt = (i) => x0 + i * step
  drawEnvelope(ctx, hOut, n, x0, step, mid, half, alpha)

  ctx.globalAlpha = alpha
  // Each column is a slice of time, so a run is widened by half a column at
  // each end — a one-column "s" onset would otherwise be a zero-width polygon.
  const pad = Math.max(step / 2, 0.5)
  for (const [kind, colour] of [[1, props.accent], [2, props.plosiveColor]]) {
    ctx.fillStyle = colour
    for (const [from, to] of kindRuns(hKind, n, kind)) {
      for (const sign of [-1, 1]) {
        ctx.beginPath()
        ctx.moveTo(xAt(from) - pad, mid + sign * ampToUnit(hIn[from]) * half)
        for (let i = from; i <= to; i++) ctx.lineTo(xAt(i), mid + sign * ampToUnit(hIn[i]) * half)
        ctx.lineTo(xAt(to) + pad, mid + sign * ampToUnit(hIn[to]) * half)
        ctx.lineTo(xAt(to) + pad, mid + sign * ampToUnit(hOut[to]) * half)
        for (let i = to; i >= from; i--) ctx.lineTo(xAt(i), mid + sign * ampToUnit(hOut[i]) * half)
        ctx.lineTo(xAt(from) - pad, mid + sign * ampToUnit(hOut[from]) * half)
        ctx.closePath()
        ctx.fill()
      }
    }
  }

  // The guard: where the output WOULD have been, on runs where it held back.
  ctx.strokeStyle = 'rgba(255,255,255,.9)'
  ctx.lineWidth = 1.25
  ctx.setLineDash([2, 2])
  for (const sign of [-1, 1]) {
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < n; i++) {
      if (hHeld[i] >= HELD_DB && hKind[i] !== 0) {
        const y = mid + sign * ampToUnit(hOut[i] * Math.pow(10, -hHeld[i] / 20)) * half
        if (pen) ctx.lineTo(xAt(i), y)
        else ctx.moveTo(xAt(i), y)
        pen = true
      } else {
        pen = false
      }
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
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
  let x = 6
  for (const [colour, text, dashed] of [
    [props.accent, 'REMOVED', false],
    [props.plosiveColor, 'PLOSIVE', false],
    ['rgba(255,255,255,.9)', 'GUARD KEPT', true],
  ]) {
    if (dashed) {
      ctx.strokeStyle = colour
      ctx.lineWidth = 1.25
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(x, y - 2)
      ctx.lineTo(x + 9, y - 2)
      ctx.stroke()
      ctx.setLineDash([])
      x += 13
    } else {
      ctx.fillStyle = colour
      ctx.fillRect(x, y - 5, 7, 6)
      x += 11
    }
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
