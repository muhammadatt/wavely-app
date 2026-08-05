<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { magnitudeResponseDb } from '../../../audio/dsp/biquad.js'
import { eqSections } from '../../../audio/eqProcessor.js'
import { getRole } from '../../../audio/eqBands.js'

/**
 * The EQ display, shared by both modes.
 *
 * Canvas for everything that is drawn per frame (grid, analyzer trace, curves)
 * and DOM elements for the band handles, so handles get pointer capture, focus
 * and hit-testing for free instead of a hand-rolled hit test against canvas
 * coordinates.
 *
 * THE COMPOSITE CURVE IS ANALYTIC, NOT MEASURED. It comes from
 * magnitudeResponseDb over the same sections the kernel installs, so no FFT runs
 * while a band is being dragged and what is on screen is the filter that is
 * running rather than a redrawn approximation. The analyzer trace is a separate,
 * independently disableable live FFT.
 *
 * EVERY ENABLED BAND IS IN THE CURVE, including ones VoxDoc has no control for.
 * A composite that omitted them would be a lie about what the user is hearing.
 */

const props = defineProps({
  bands: { type: Array, required: true },
  sampleRate: { type: Number, default: 44100 },
  accent: { type: String, default: '#8fd18f' },
  height: { type: Number, default: 200 },

  /** Draggable handles and click-to-create. Off in VoxDoc, where roles drive. */
  interactive: { type: Boolean, default: true },
  /** Band ids to show handles for. Null means all of them. */
  handleIds: { type: Array, default: null },
  selectedId: { type: String, default: null },

  /** Live post-EQ spectrum, or null. Called per frame; returns Float32Array dB. */
  spectrumFn: { type: Function, default: null },
  showAnalyzer: { type: Boolean, default: false },

  /**
   * VoxDoc overlay: the measured envelope, its per-region baselines and the
   * detection thresholds that form the tolerance ribbon.
   */
  deviation: { type: Object, default: null },
})

const emit = defineEmits([
  'create-band', 'select-band', 'move-band', 'remove-band', 'toggle-band', 'q-band',
])

const F_MIN = 20
const F_MAX = 20000
const LOG_SPAN = Math.log2(F_MAX / F_MIN)

const canvasEl = ref(null)
const wrapEl = ref(null)
const width = ref(600)
let rafId = null
let ro = null

// ── Axis mapping ────────────────────────────────────────────────────────────

/**
 * Gain axis auto-scales so small moves stay legible (spec §7.1).
 *
 * The deviation curve is scaled by a high percentile rather than its maximum.
 * At the top of the spectrum a dull recording has almost no energy, so the log
 * spectrum — and the cepstral envelope built from it — swings enormously over a
 * region the ear barely registers. Scaling to that would squash everything the
 * user actually needs to see into a few pixels around zero.
 */
const dbMax = computed(() => {
  let peak = 6
  for (const b of props.bands) {
    if (!b.enabled) continue
    peak = Math.max(peak, Math.abs(b.gainDb) + 2)
  }
  if (props.deviation) {
    const mags = []
    for (const r of props.deviation.regionResults ?? []) {
      if (!r.scanEnv || !r.baseline) continue
      for (let i = 0; i < r.scanEnv.length; i++) {
        mags.push(Math.abs(r.scanEnv[i] - r.baseline[i]))
      }
    }
    if (mags.length > 0) {
      mags.sort((a, b) => a - b)
      peak = Math.max(peak, mags[Math.floor(mags.length * 0.9)] + 2)
    }
  }
  return Math.min(18, Math.max(6, Math.ceil(peak / 3) * 3))
})

function xFor(hz) {
  return (Math.log2(Math.max(hz, F_MIN) / F_MIN) / LOG_SPAN) * width.value
}

function hzFor(x) {
  return F_MIN * Math.pow(2, (x / width.value) * LOG_SPAN)
}

function yFor(db) {
  return props.height / 2 - (db / dbMax.value) * (props.height / 2)
}

/**
 * As yFor, but pinned inside the plot.
 *
 * Used for measured curves, which — unlike a filter response — are not bounded
 * by anything. A curve that leaves the box takes the reader's eye with it and
 * makes the region it belongs to unreadable; pinning it at the edge says "off
 * the scale here" while keeping the rest legible.
 */
function yForClamped(db) {
  const margin = 3
  const y = yFor(db)
  return Math.max(margin, Math.min(props.height - margin, y))
}

function dbFor(y) {
  return ((props.height / 2 - y) / (props.height / 2)) * dbMax.value
}

const GRID_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

function hzLabel(hz) {
  if (hz >= 1000) return `${hz / 1000}k`
  return String(hz)
}

/**
 * VoxDoc labels its axis with role names, not numbers (spec §6.1).
 *
 * The user's task is "flatten the wiggle into the ribbon", and naming the
 * regions is what makes that possible without knowing any frequencies — the
 * numbers are still there on hover. Labels alternate between two rows because
 * nine of them across a log axis collide badly in one, and the regions overlap
 * at their edges by design.
 */
const roleAxis = computed(() => {
  if (!props.deviation) return []
  return (props.deviation.regionResults ?? [])
    .filter(r => r.roleId)
    .map((r, i) => ({
      id: r.roleId,
      label: getRole(r.roleId)?.label ?? r.roleId,
      centerHz: Math.sqrt(r.scanLowHz * r.scanHighHz),
      detected: r.detected,
      row: i % 2,
    }))
})

// ── Curves ──────────────────────────────────────────────────────────────────

const CURVE_POINTS = 320
const CURVE_FREQS = Array.from({ length: CURVE_POINTS }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / (CURVE_POINTS - 1)))

const compositeDb = computed(() => {
  const sections = eqSections(props.sampleRate, props.bands)
  if (sections.length === 0) return new Float64Array(CURVE_POINTS)
  return magnitudeResponseDb(sections, CURVE_FREQS, props.sampleRate)
})

/**
 * Regions where the composite is beyond the extreme thresholds (spec §6.2).
 * A reading aid, not a constraint — non-blocking and identical in both modes.
 */
const EXTREME_HI = 10
const EXTREME_LO = -15

// ── Drawing ─────────────────────────────────────────────────────────────────

function draw() {
  const canvas = canvasEl.value
  if (!canvas) return

  // Setting canvas.width resets the context, so the DPR scale is re-applied
  // every frame rather than saved and restored.
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0) return
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  width.value = w

  drawGrid(ctx, w, h)
  if (props.showAnalyzer && props.spectrumFn) drawAnalyzer(ctx, w, h)
  if (props.deviation) drawDeviation(ctx, w, h)
  drawExtremes(ctx, h)
  drawComposite(ctx, h)
}

function drawGrid(ctx, w, h) {
  ctx.lineWidth = 1

  ctx.strokeStyle = 'rgba(255,255,255,.06)'
  for (const hz of GRID_HZ) {
    const x = Math.round(xFor(hz)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }

  const step = dbMax.value >= 12 ? 6 : 3
  ctx.font = '9px "JetBrains Mono", monospace'
  ctx.fillStyle = 'rgba(255,255,255,.22)'
  ctx.textBaseline = 'middle'
  for (let db = -dbMax.value; db <= dbMax.value; db += step) {
    const y = Math.round(yFor(db)) + 0.5
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    if (db !== 0) ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y)
  }
}

function drawAnalyzer(ctx, w, h) {
  const spectrum = props.spectrumFn()
  if (!spectrum || spectrum.length === 0) return

  const binWidth = props.sampleRate / (spectrum.length * 2)
  ctx.beginPath()
  ctx.moveTo(0, h)
  let started = false
  for (let k = 1; k < spectrum.length; k++) {
    const hz = k * binWidth
    if (hz < F_MIN) continue
    if (hz > F_MAX) break
    // The analyser reports dBFS; map the useful window onto the plot so the
    // trace sits behind the curve as a texture rather than competing with it.
    const norm = (spectrum[k] + 100) / 90
    const y = h - Math.max(0, Math.min(1, norm)) * h
    const x = xFor(hz)
    if (!started) {
      ctx.lineTo(x, y)
      started = true
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.lineTo(w, h)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,.055)'
  ctx.fill()
}

/** The VoxDoc layer: measured envelope, baseline, and the threshold ribbon. */
function drawDeviation(ctx, w, h) {
  const dev = props.deviation
  for (const r of dev.regionResults ?? []) {
    if (!r.scanFreqs || !r.baseline) continue

    // Tolerance ribbon: the region's own detection threshold, drawn around the
    // baseline. Inside it, the tool has nothing to say — so "flat inside the
    // ribbon" and "no suggestions" are the same statement.
    ctx.fillStyle = 'rgba(255,255,255,.045)'
    ctx.beginPath()
    for (let i = 0; i < r.scanFreqs.length; i++) {
      const x = xFor(r.scanFreqs[i])
      const y = yFor(r.direction === 'dip' ? -r.thresholdDb : r.thresholdDb)
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    for (let i = r.scanFreqs.length - 1; i >= 0; i--) {
      ctx.lineTo(xFor(r.scanFreqs[i]), yFor(0))
    }
    ctx.closePath()
    ctx.fill()

    // Measured deviation from the baseline. This is the dry curve: it is
    // computed pre-EQ and does not move as bands change (spec §9.1).
    ctx.beginPath()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = r.detected ? 'rgba(255,180,120,.85)' : 'rgba(255,255,255,.26)'
    for (let i = 0; i < r.scanFreqs.length; i++) {
      const x = xFor(r.scanFreqs[i])
      const y = yForClamped(r.scanEnv[i] - r.baseline[i])
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Mark where the detection landed, so the number in the suggestion row has
    // a place on the picture.
    if (r.detected && Number.isFinite(r.centerHz)) {
      const x = xFor(r.centerHz)
      ctx.beginPath()
      ctx.arc(x, yForClamped(r.deviationDb), 3, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,180,120,.9)'
      ctx.fill()
    }
  }
}

function drawExtremes(ctx, h) {
  const db = compositeDb.value
  ctx.fillStyle = 'rgba(255,120,100,.10)'
  let runStart = -1
  for (let i = 0; i <= CURVE_POINTS; i++) {
    const hot = i < CURVE_POINTS && (db[i] > EXTREME_HI || db[i] < EXTREME_LO)
    if (hot && runStart === -1) runStart = i
    if (!hot && runStart !== -1) {
      const x0 = xFor(CURVE_FREQS[runStart])
      const x1 = xFor(CURVE_FREQS[i - 1])
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h)
      runStart = -1
    }
  }
}

function drawComposite(ctx, h) {
  const db = compositeDb.value

  ctx.beginPath()
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = xFor(CURVE_FREQS[i])
    const y = yFor(db[i])
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  const stroke = ctx.strokeStyle
  ctx.save()
  ctx.lineTo(xFor(F_MAX), yFor(0))
  ctx.lineTo(xFor(F_MIN), yFor(0))
  ctx.closePath()
  ctx.fillStyle = `color-mix(in srgb, ${props.accent} 14%, transparent)`
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = xFor(CURVE_FREQS[i])
    const y = yFor(db[i])
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.lineWidth = 2
  ctx.strokeStyle = props.accent
  ctx.stroke()
  ctx.strokeStyle = stroke
}

// ── Animation loop ──────────────────────────────────────────────────────────

function frame() {
  draw()
  rafId = requestAnimationFrame(frame)
}

function startLoop() {
  if (rafId === null) rafId = requestAnimationFrame(frame)
}

function stopLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

// The analyzer needs a frame loop; everything else only redraws on change, so
// the loop is not left running when nothing is moving.
watch(() => props.showAnalyzer, (on) => {
  if (on) startLoop()
  else {
    stopLoop()
    draw()
  }
})

watch(
  [() => props.bands, () => props.deviation, () => props.selectedId, dbMax],
  () => {
    if (rafId === null) draw()
  },
  { deep: true },
)

onMounted(() => {
  ro = new ResizeObserver(() => draw())
  ro.observe(wrapEl.value)
  draw()
  if (props.showAnalyzer) startLoop()
})

onBeforeUnmount(() => {
  stopLoop()
  ro?.disconnect()
})

// ── Handle interaction ──────────────────────────────────────────────────────

const shownHandles = computed(() => {
  const ids = props.handleIds
  return props.bands.filter(b => (ids === null ? true : ids.includes(b.id)))
})

function handleStyle(band) {
  return {
    left: `${(xFor(band.frequencyHz) / width.value) * 100}%`,
    top: `${yFor(band.gainDb)}px`,
  }
}

let drag = null

function onHandleDown(e, band) {
  if (!props.interactive) return
  e.stopPropagation()
  if (e.altKey) {
    emit('toggle-band', band.id)
    return
  }
  emit('select-band', band.id)
  drag = { id: band.id }
  e.target.setPointerCapture(e.pointerId)
}

function onHandleMove(e) {
  if (!drag) return
  const rect = canvasEl.value.getBoundingClientRect()
  emit('move-band', {
    id: drag.id,
    frequencyHz: hzFor(e.clientX - rect.left),
    gainDb: dbFor(e.clientY - rect.top),
  })
}

function onHandleUp(e) {
  if (!drag) return
  e.target.releasePointerCapture?.(e.pointerId)
  drag = null
}

function onHandleWheel(e, band) {
  if (!props.interactive) return
  e.preventDefault()
  // Scroll over a handle adjusts Q — the third dimension a two-axis drag
  // cannot reach.
  emit('q-band', { id: band.id, delta: e.deltaY > 0 ? -1 : 1 })
}

function onPlotDown(e) {
  if (!props.interactive) return
  // Clicking empty plot creates a band there. The fastest path to a band, and
  // it needs no menu.
  const rect = canvasEl.value.getBoundingClientRect()
  emit('create-band', {
    frequencyHz: hzFor(e.clientX - rect.left),
    gainDb: dbFor(e.clientY - rect.top),
  })
}
</script>

<template>
  <div ref="wrapEl" class="relative w-full select-none">
    <canvas
      ref="canvasEl"
      class="block w-full rounded-[3px]"
      :style="{ height: `${height}px`, background: 'rgba(0,0,0,.28)' }"
      @pointerdown="onPlotDown"
    />

    <!-- Band handles: DOM, not canvas, so pointer capture and focus are free. -->
    <button
      v-for="band in shownHandles"
      :key="band.id"
      type="button"
      class="absolute rounded-full border-2 -translate-x-1/2 -translate-y-1/2 transition-[box-shadow,opacity]"
      :style="{
        ...handleStyle(band),
        width: band.id === selectedId ? '14px' : '11px',
        height: band.id === selectedId ? '14px' : '11px',
        borderColor: accent,
        background: band.enabled ? accent : 'transparent',
        opacity: band.enabled ? 1 : 0.45,
        cursor: interactive ? 'grab' : 'default',
        boxShadow: band.id === selectedId ? `0 0 0 4px color-mix(in srgb, ${accent} 22%, transparent)` : 'none',
      }"
      :aria-label="`Band at ${Math.round(band.frequencyHz)} hertz, ${band.gainDb.toFixed(1)} decibels`"
      @pointerdown="onHandleDown($event, band)"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
      @wheel="onHandleWheel($event, band)"
      @dblclick.stop="emit('remove-band', band.id)"
    />

    <!-- Frequency axis: role names in VoxDoc, numbers in General -->
    <div
      v-if="roleAxis.length > 0"
      class="relative w-full mt-[3px]"
      style="height:22px"
    >
      <span
        v-for="r in roleAxis"
        :key="r.id"
        class="absolute whitespace-nowrap"
        :title="`${Math.round(r.centerHz)} Hz`"
        :style="{
          left: `${(xFor(r.centerHz) / width) * 100}%`,
          top: `${r.row * 11}px`,
          transform: 'translateX(-50%)',
          fontWeight: 700,
          fontSize: '8px',
          letterSpacing: '.07em',
          color: r.detected ? 'rgba(255,180,120,.8)' : 'rgba(255,255,255,.28)',
        }"
      >{{ r.label.toUpperCase() }}</span>
    </div>
    <div v-else class="relative w-full mt-[3px] h-[11px]">
      <span
        v-for="hz in GRID_HZ"
        :key="hz"
        class="absolute top-0"
        :style="{
          left: `${(xFor(hz) / width) * 100}%`,
          transform: hz === 20 ? 'none' : hz === 20000 ? 'translateX(-100%)' : 'translateX(-50%)',
          fontWeight: 600,
          fontSize: '8px',
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '.08em',
          color: 'rgba(255,255,255,.26)',
        }"
      >{{ hzLabel(hz) }}</span>
    </div>
  </div>
</template>
