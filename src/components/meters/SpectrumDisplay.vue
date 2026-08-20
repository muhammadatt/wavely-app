<script setup>
import { ref, watch } from 'vue'
import { useMeterFrame } from './ballistics.js'
import {
  applyTilt,
  createLogMapper,
  createSpectrumPeakHold,
  dominant,
  formatHz,
  noteFor,
} from '../../audio/dsp/spectrumDisplay.js'

/**
 * The analyzer's picture: one trace over a log frequency axis and a dB scale.
 *
 * Deliberately the conventional display rather than a new one. Every other
 * plot in this app answers a question specific to its plugin — the resonance
 * lanes, the EQ curve, the VoiceRx envelope — and each earned its shape. This
 * one exists so that someone who has used an analyzer before can read this file
 * without being taught anything: frequency left to right on a log axis, dBFS
 * bottom to top, the live trace filled, the peak hold outlined above it.
 *
 * WHAT IT DOES NOT DO IS AUTO-SCALE. The vertical window is a control, not a
 * fit. An analyzer that rescales itself turns "the hiss got quieter" into
 * "everything moved", which is the one comparison the display exists to
 * support — and it is the same reason the resonance display fixes its window.
 */
const props = defineProps({
  /**
   * Returns `{ db, binWidthHz }` or null. A function rather than a value: this
   * is thousands of floats at 60 Hz, and reactivity would diff a typed array to
   * redraw a canvas that redraws itself anyway.
   *
   * Null means "nothing new" — the last frame stays on screen, which is what
   * makes freezing a matter of withholding frames rather than a mode in here.
   */
  frameFn: { type: Function, required: true },
  /** Tilt, dB per octave, anchored at 1 kHz. */
  slope: { type: Number, default: 4.5 },
  /** Bottom of the dB window. The top is 0 dBFS. */
  floorDb: { type: Number, default: -100 },
  showPeakHold: { type: Boolean, default: true },
  /** Dims the plot and stops the hold from decaying, for a held reading. */
  frozen: { type: Boolean, default: false },
  accent: { type: String, default: '#5bc8ff' },
  height: { type: Number, default: 260 },
  /** Accessible name — a canvas is opaque to a screen reader without one. */
  title: { type: String, default: 'Spectrum analyzer' },
})

const CEILING_DB = 0
/** Strip along the bottom for the frequency numerals. */
const AXIS_H = 14
/** Strip along the right for the dB numerals. */
const SCALE_W = 30
/** Decade-ish ladder, matching the EQ plot and the resonance display. */
const GRID_HZ = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000]
/** Which of those get a numeral. Labelling all of them crowds the axis. */
const LABEL_HZ = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])

const canvasEl = ref(null)
const cursor = ref(null)

/**
 * Everything that survives between frames.
 *
 * Outside Vue's reactivity on purpose — these are the drawing buffers, they
 * change every frame, and nothing renders from them but the canvas.
 */
let mapper = null
let mapperKey = ''
let peaks = null
/** Last mapped, tilted frame. Kept so a frozen or silent transport still draws. */
let curve = null
/** True once any frame has arrived; before that the plot is empty, not flat. */
let haveFrame = false

const readout = ref({ hz: 0, db: -Infinity })

/**
 * A dB reading, or a floor marker when it is off the bottom of the window.
 *
 * A silent analyser reports numbers like -196 dB — arithmetically true, since
 * `getFloatFrequencyData` does not clamp to `minDecibels`, and read by anyone
 * looking at it as a broken readout rather than as silence. Below the window
 * the honest statement is that the display cannot see it.
 */
function readDb(db) {
  if (!Number.isFinite(db)) return `< ${props.floorDb} dB`
  return db < props.floorDb ? `< ${props.floorDb} dB` : `${db.toFixed(1)} dB`
}

function tint(hex, alpha) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Rebuild the resampler when the FFT changes shape.
 *
 * Keyed on the frame's own geometry rather than on a prop, so a resolution
 * change reaches the display on the first frame drawn at the new size — there
 * is no moment where a 16k frame is read through an 4k mapping.
 */
function ensureMapper(binCount, binWidthHz) {
  const key = `${binCount}/${binWidthHz}`
  if (mapperKey === key) return
  mapper = createLogMapper({ binCount, binWidthHz })
  mapperKey = key
  curve = new Float32Array(mapper.cells)
  peaks = createSpectrumPeakHold(mapper.cells, { floorDb: -200 })
  haveFrame = false
}

useMeterFrame((dtMs) => {
  // Frozen means frozen, whatever arrives. Today's caller withholds frames
  // while frozen, so this is belt and braces — but the prop documents the
  // behaviour, and a future caller that keeps feeding frames would otherwise
  // find the hold quietly decaying under a held reading.
  const frame = props.frozen ? null : props.frameFn?.()
  if (frame?.db?.length) {
    ensureMapper(frame.db.length, frame.binWidthHz)
    const mapped = mapper.map(frame.db, -200)
    applyTilt(mapped, mapper.centers, props.slope)
    curve.set(mapped)
    peaks.push(curve, dtMs)
    haveFrame = true
    readout.value = dominant(curve, mapper.centers)
  }
  draw()
})

// The tilt is applied to each frame as it arrives, so a change to it only shows
// on the next one — but a held peak was tilted by the old slope and would sit
// at the wrong height forever. Cheaper and more honest to start it again.
watch(() => props.slope, () => peaks?.reset())

function resetPeaks() {
  peaks?.reset()
}
defineExpose({ resetPeaks })

// ── Drawing ─────────────────────────────────────────────────────────────────

function draw() {
  const canvas = canvasEl.value
  if (!canvas) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0) return

  // Setting width resets the context, so the DPR scale is re-applied per frame
  // rather than saved and restored — same as EqPlot and ResonanceSpectrum.
  const dpr = window.devicePixelRatio || 1
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  const plotW = Math.max(10, w - SCALE_W)
  const plotH = Math.max(10, h - AXIS_H)
  const minHz = mapper?.minHz ?? 20
  const maxHz = mapper?.maxHz ?? 20000
  const octaves = Math.log2(maxHz / minHz)
  const xFor = hz => (Math.log2(Math.min(Math.max(hz, minHz), maxHz) / minHz) / octaves) * plotW
  const yFor = (db) => {
    const t = (db - props.floorDb) / (CEILING_DB - props.floorDb)
    return plotH - Math.max(0, Math.min(1, t)) * plotH
  }

  ctx.fillStyle = 'rgba(0,0,0,.45)'
  ctx.fillRect(0, 0, plotW, plotH)

  drawGrid(ctx, plotW, plotH, xFor, yFor, minHz, maxHz)

  if (haveFrame) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, plotW, plotH)
    ctx.clip()
    // Dimmed rather than blanked while frozen: what is on screen is still the
    // truth about the moment it was taken, and blanking it would make a held
    // reading look like a broken one.
    ctx.globalAlpha = props.frozen ? 0.72 : 1
    if (props.showPeakHold) drawPeaks(ctx, plotW, plotH, xFor, yFor)
    drawTrace(ctx, plotW, plotH, xFor, yFor)
    ctx.globalAlpha = 1
    ctx.restore()
  }

  drawDbScale(ctx, w, plotW, plotH, yFor)
  drawFreqAxis(ctx, plotW, plotH, xFor, minHz, maxHz)
  drawCursor(ctx, plotW, plotH, xFor, yFor, minHz, octaves)
}

function drawGrid(ctx, w, h, xFor, yFor, minHz, maxHz) {
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  for (const hz of GRID_HZ) {
    if (hz < minHz || hz > maxHz) continue
    const x = Math.round(xFor(hz)) + 0.5
    if (x >= w) continue
    ctx.fillRect(x, 0, 1, h)
  }
  for (let db = 0; db >= props.floorDb; db -= 10) {
    const y = Math.round(yFor(db)) + 0.5
    // 0 dBFS is the one line that means something absolute, so it is drawn as a
    // ceiling rather than as another gridline.
    ctx.fillStyle = db === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.045)'
    ctx.fillRect(0, y, w, 1)
  }
}

/**
 * The live trace: filled to the floor, with a bright edge.
 *
 * The fill is what makes the shape readable at a glance; the edge is what makes
 * a narrow peak visible when the fill under it is only a pixel or two wide.
 */
function drawTrace(ctx, w, h, xFor, yFor) {
  const cells = mapper.cells
  const xStep = w / (cells - 1)

  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let d = 0; d < cells; d++) ctx.lineTo(d * xStep, yFor(curve[d]))
  ctx.lineTo(w, h)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, tint(props.accent, 0.45))
  grad.addColorStop(1, tint(props.accent, 0.05))
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  for (let d = 0; d < cells; d++) {
    const y = yFor(curve[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.lineWidth = 1.5
  ctx.strokeStyle = props.accent
  ctx.stroke()
}

/** The hold, as a thin outline above the fill. */
function drawPeaks(ctx, w, h, xFor, yFor) {
  const cells = mapper.cells
  const xStep = w / (cells - 1)
  ctx.beginPath()
  for (let d = 0; d < cells; d++) {
    const y = yFor(peaks.values[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,.34)'
  ctx.stroke()
}

function drawDbScale(ctx, w, plotW, plotH, yFor) {
  ctx.font = '600 8.5px "JetBrains Mono", monospace'
  ctx.fillStyle = 'rgba(255,255,255,.34)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  // Every 20 dB, not every 10: at 100 dB of range the 10 dB ladder puts a
  // numeral every 24 px, which reads as a column of digits rather than a scale.
  for (let db = 0; db >= props.floorDb; db -= 20) {
    const y = yFor(db)
    if (y > plotH - 5) continue
    ctx.fillText(String(db), plotW + 6, Math.max(6, y))
  }
}

function drawFreqAxis(ctx, w, plotH, xFor, minHz, maxHz) {
  ctx.font = '600 8.5px "JetBrains Mono", monospace'
  ctx.fillStyle = 'rgba(255,255,255,.34)'
  ctx.textBaseline = 'top'
  for (const hz of GRID_HZ) {
    if (!LABEL_HZ.has(hz) || hz < minHz || hz > maxHz) continue
    const x = xFor(hz)
    // The end labels are pulled inside the plot instead of being centred on
    // their line, where half of each would be clipped off.
    ctx.textAlign = x < 12 ? 'left' : x > w - 12 ? 'right' : 'center'
    ctx.fillText(formatHz(hz), Math.min(Math.max(x, 1), w - 1), plotH + 3)
  }
}

/**
 * Crosshair and readout under the pointer.
 *
 * The number is read off the drawn trace rather than measured again, so it
 * cannot disagree with the picture — and it names the note as well as the
 * frequency, because a room mode or a hum harmonic is usually easier to act on
 * by name than by hertz.
 */
function drawCursor(ctx, plotW, plotH, xFor, yFor, minHz, octaves) {
  const c = cursor.value
  if (!c || !mapper) return

  const hz = minHz * 2 ** ((c.x / plotW) * octaves)
  const cell = Math.max(0, Math.min(mapper.cells - 1,
    Math.round((c.x / plotW) * (mapper.cells - 1))))
  const db = haveFrame ? curve[cell] : null

  const x = Math.round(xFor(hz)) + 0.5
  ctx.fillStyle = 'rgba(255,255,255,.18)'
  ctx.fillRect(x, 0, 1, plotH)

  if (db !== null) {
    ctx.beginPath()
    ctx.arc(x, yFor(db), 2.5, 0, Math.PI * 2)
    ctx.fillStyle = props.accent
    ctx.fill()
  }

  const text = `${formatHz(hz)} Hz · ${noteFor(hz)}${db === null ? '' : ` · ${readDb(db)}`}`
  ctx.font = '600 9.5px "JetBrains Mono", monospace'
  ctx.textBaseline = 'top'
  const tw = ctx.measureText(text).width
  const tx = Math.min(Math.max(x + 8, 4), plotW - tw - 4)
  ctx.fillStyle = 'rgba(0,0,0,.6)'
  ctx.fillRect(tx - 4, 4, tw + 8, 15)
  ctx.fillStyle = 'rgba(255,255,255,.8)'
  ctx.textAlign = 'left'
  ctx.fillText(text, tx, 7)
}

function onMove(e) {
  const canvas = canvasEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const plotW = rect.width - SCALE_W
  cursor.value = x >= 0 && x <= plotW ? { x } : null
}
</script>

<template>
  <div class="w-full">
    <canvas
      ref="canvasEl"
      class="block w-full"
      :style="{ height: height + 'px' }"
      role="img"
      :aria-label="title"
      @pointermove="onMove"
      @pointerleave="cursor = null"
    />
    <!-- The loudest thing on screen, named. Outside the canvas so it is
         selectable text — a frequency you want to type into a filter. -->
    <div
      class="mt-[6px] flex items-baseline justify-between"
      style="font:600 9px 'JetBrains Mono',monospace;letter-spacing:.12em;color:rgba(255,255,255,.34)"
    >
      <span>PEAK</span>
      <span v-if="readout.db > floorDb" :style="{ color: accent }">
        {{ formatHz(readout.hz) }} Hz · {{ noteFor(readout.hz) }} · {{ readDb(readout.db) }}
      </span>
      <!-- Nothing above the floor anywhere on the axis: naming the loudest of a
           set of readings that are all off-scale would point at noise. -->
      <span v-else>—</span>
    </div>
  </div>
</template>
