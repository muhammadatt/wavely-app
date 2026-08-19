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

const emit = defineEmits(['update:fixedThresholdDb', 'requestPlay'])

const canvasEl = ref(null)
const isFixed = computed(() => props.mode === 'fixed')

/**
 * True while the scope has nothing to draw — the transport is stopped and no
 * audio has ever reached the effect. Mirrored into a ref so the cursor can
 * say the idle label is clickable, which is the whole point of it being one.
 */
const isIdle = ref(true)

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

/**
 * dBFS gridlines.
 *
 * Without these the vertical axis is unreadable: it is amplitude^0.45, so it
 * is neither linear nor logarithmic and nothing on screen says where -6 is.
 * That matters twice over in fixed mode, where the drag has no other ruler —
 * the whole -24…-1 dBFS travel of the control is this axis.
 *
 * Spaced to cover the fixed range's ends and the middle where thresholds
 * actually land, rather than at even dB intervals, which the power law would
 * bunch against the top.
 */
const GRID_DB = [-1, -3, -6, -12, -24]

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

  drawGrid(ctx, w, mid, half)

  if (!scope || scope.filled === 0) {
    ctx.globalAlpha = 1
    isIdle.value = true
    drawIdleLabel(ctx, w, mid)
    return
  }
  isIdle.value = false

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

  drawLegend(ctx, w, h)
  drawThresholdChip(ctx, w, mid, half, scope, start, n)
}

/**
 * dBFS gridlines, mirrored about the centre, labelled on the upper half only —
 * the two halves are one signal drawn twice, so labelling both would imply
 * they were separate scales.
 */
function drawGrid(ctx, w, mid, half) {
  ctx.lineWidth = 1
  ctx.font = "600 8px 'JetBrains Mono',monospace"
  ctx.textAlign = 'left'

  for (const db of GRID_DB) {
    const dy = ampToUnit(dbToLin(db)) * half
    ctx.strokeStyle = 'rgba(255,255,255,.05)'
    ctx.beginPath()
    ctx.moveTo(0, Math.round(mid - dy) + 0.5)
    ctx.lineTo(w, Math.round(mid - dy) + 0.5)
    ctx.moveTo(0, Math.round(mid + dy) + 0.5)
    ctx.lineTo(w, Math.round(mid + dy) + 0.5)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255,255,255,.22)'
    ctx.fillText(String(db), 5, mid - dy - 3)
  }

  // Centre line last, brighter — it is zero, not a gridline.
  ctx.strokeStyle = 'rgba(255,255,255,.1)'
  ctx.beginPath()
  ctx.moveTo(0, mid + 0.5)
  ctx.lineTo(w, mid + 0.5)
  ctx.stroke()
}

// Hit rect of the idle label, in CSS pixels — see onPointerDown. Kept as a
// module-level box rather than recomputed on click so the target is exactly
// what was painted.
const idleHit = { x: 0, y: 0, w: 0, h: 0 }

function drawIdleLabel(ctx, w, mid) {
  const text = '▶  press play to see the signal'
  ctx.font = "600 9.5px 'JetBrains Mono',monospace"
  ctx.textAlign = 'center'
  const tw = ctx.measureText(text).width
  idleHit.w = tw + 24
  idleHit.h = 24
  idleHit.x = (w - idleHit.w) / 2
  idleHit.y = mid - 12 - 8

  // Given a border, because a bare line of text does not read as a button and
  // this one is the first thing on the panel worth clicking.
  ctx.strokeStyle = 'rgba(255,255,255,.12)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(idleHit.x + 0.5, idleHit.y + 0.5, idleHit.w, idleHit.h, 12)
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,.35)'
  ctx.fillText(text, w / 2, idleHit.y + 15.5)
  ctx.textAlign = 'left'
}

/**
 * Trace key.
 *
 * The shaded excess above the threshold IS the effect, and until now nothing
 * on the panel named it — the accent fill read as decoration rather than as
 * "this is the part being removed".
 */
function drawLegend(ctx, w, h) {
  const y = h - 9
  ctx.font = "600 8px 'JetBrains Mono',monospace"
  ctx.textAlign = 'left'
  let x = 6

  for (const [colour, text] of [
    ['rgba(200,205,215,.55)', 'SIGNAL'],
    [props.accent, 'REMOVED'],
  ]) {
    ctx.fillStyle = colour
    ctx.fillRect(x, y - 5, 7, 6)
    x += 11
    ctx.fillStyle = 'rgba(255,255,255,.34)'
    ctx.fillText(text, x, y)
    x += ctx.measureText(text).width + 14
  }

  // Mode hint on the same line, right-aligned — it says what the threshold
  // curve is, and belongs with the key rather than floating over the trace.
  ctx.fillStyle = 'rgba(255,255,255,.3)'
  ctx.textAlign = 'right'
  ctx.fillText(
    isFixed.value ? 'THRESHOLD — DRAG TO SET' : 'THRESHOLD — FOLLOWS THE VOICE',
    w - 6, y,
  )
  ctx.textAlign = 'left'
}

/**
 * The threshold's value, printed on a chip riding the upper threshold line.
 *
 * It used to sit in the top-right corner, as far from the line it describes as
 * the canvas allows. In fixed mode that line is the control, so the number and
 * the grab target should be the same object — a value floating in a corner
 * gives a draggable line no affordance at all beyond a cursor change on hover.
 */
function drawThresholdChip(ctx, w, mid, half, scope, start, n) {
  const latest = scope.threshold[(start + n - 1) % scope.capacity]
  const label = `${linToDb(latest).toFixed(1)} dB`

  ctx.font = "700 9px 'JetBrains Mono',monospace"
  const tw = ctx.measureText(label).width
  const cw = tw + (isFixed.value ? 22 : 12)
  const ch = 15
  const cx = w - cw - 5
  // Clamped so the chip stays on the face during the warm-up, when the
  // threshold deliberately sits above full scale.
  const cy = Math.min(mid - ch - 1, Math.max(1, mid - ampToUnit(latest) * half - ch / 2))

  ctx.fillStyle = '#08060a'
  ctx.strokeStyle = props.accent
  ctx.globalAlpha = isFixed.value ? 0.9 : 0.5
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(cx + 0.5, cy + 0.5, cw, ch, 7)
  ctx.fill()
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.fillStyle = props.accent
  ctx.textAlign = 'left'
  ctx.fillText(label, cx + 7, cy + 11)

  // Grip dots, fixed mode only — the one visual difference between a readout
  // and a handle.
  if (isFixed.value) {
    ctx.fillStyle = props.accent
    ctx.globalAlpha = 0.65
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx + cw - 11, cy + 4 + i * 3, 6, 1.5)
    }
    ctx.globalAlpha = 1
  }
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
  // The idle label is a button. It is the first thing anyone reads on this
  // panel and the only instruction it gives, so it should carry out that
  // instruction rather than merely state it. Checked before the drag: while
  // idle there is no threshold curve drawn, so there is nothing to grab.
  if (isIdle.value) {
    const rect = canvasEl.value?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (
      x >= idleHit.x && x <= idleHit.x + idleHit.w &&
      y >= idleHit.y && y <= idleHit.y + idleHit.h
    ) emit('requestPlay')
    return
  }
  if (!isFixed.value) return
  canvasEl.value?.setPointerCapture?.(e.pointerId)
  emit('update:fixedThresholdDb', yToDb(e.clientY))
}

function onPointerMove(e) {
  // Only while captured — `buttons` is 0 on a hover, so this needs no separate
  // dragging flag.
  if (isIdle.value || !isFixed.value || e.buttons === 0) return
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
      :style="{ cursor: isIdle ? 'pointer' : isFixed ? 'ns-resize' : 'default' }"
      :aria-label="title"
      role="img"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    ></canvas>
  </div>
</template>
