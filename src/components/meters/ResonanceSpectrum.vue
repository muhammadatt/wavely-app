<script setup>
import { computed, ref } from 'vue'
import { resonanceWeightDbAt } from '../../audio/resonanceParams.js'
import {
  addNode,
  dragNode,
  hzFromX,
  nodeAt,
  nodeOctaves,
  nudgeNode,
  removeNode,
  xFromHz,
} from './resonanceNodes.js'
import {
  createHeldAverage,
  createReadoutThrottle,
  createVuBallistics,
  grFraction,
  grFractionToDb,
  grScaleMarks,
  PEAK_FALL_PER_SEC,
  PEAK_HOLD_MS,
  useMeterFrame,
} from './ballistics.js'

/**
 * Per-frequency display for the Resonance Suppressor.
 *
 * REPLACES THE GAIN-REDUCTION BAR, and the reason is that a single number is
 * the wrong summary of this effect. A compressor pulls the whole signal down by
 * one amount, so one number describes it completely. This one cuts a handful of
 * narrow bands and leaves everything else alone — "6 dB" says nothing about
 * where, how wide, or whether it landed on the resonance or on a harmonic, and
 * those are the only questions the knobs can answer. The bar could not
 * distinguish a surgical 6 dB notch from 6 dB taken off half the spectrum.
 *
 * Two lanes over one shared log-frequency axis, so a peak in the lower lane and
 * the cut taken out of it line up vertically:
 *
 *   TOP     reduction, hanging from the zero line, on the same voltage-law
 *           scale the other panels' GR meters use — so a depth here reads the
 *           same as a depth there. A decaying peak-hold outline behind it shows
 *           where the effect has been working over the last second or so, which
 *           is what makes an intermittent resonance findable at all.
 *   BOTTOM  the spectrum this was decided from: the input, the reference
 *           threshold, and the output. The shaded sliver between input and
 *           output is what is being removed.
 *
 * THE CURVES COME FROM THE KERNEL, NOT FROM AN ANALYSER ON THE OUTPUT. A second
 * FFT on the output would show the result of the cut but could never show the
 * cepstral reference it was decided against — and that reference, plus
 * Selectivity above it, is the whole explanation of why any given peak was or
 * was not treated. Reading the kernel's own numbers also means the display
 * cannot disagree with the audio.
 */
const props = defineProps({
  /**
   * Returns the kernel's latest frame, or null. A function rather than a prop
   * value: this is a few hundred floats arriving at ~46 Hz, and routing that
   * through reactivity would make Vue diff a typed array to redraw a canvas
   * that re-renders itself anyway. Same arrangement as EqPlot's spectrumFn.
   */
  dataFn: { type: Function, required: true },
  /** Broadband peak reduction, negative dB — drives the numeric readouts. */
  reductionDb: { type: Number, default: 0 },
  accent: { type: String, default: '#8de0a8' },
  /** Detection threshold above the reference, in dB. */
  selectivityDb: { type: Number, default: 8 },
  /** Processing band. Outside it the display is washed out, as the effect is. */
  freqFloorHz: { type: Number, default: 40 },
  freqCeilHz: { type: Number, default: 20000 },
  /** Reduction that fills the top lane. Matches GainReductionBar's default. */
  fullScaleDb: { type: Number, default: 24 },
  /**
   * The panel is auditioning the difference rather than the result.
   *
   * Changes nothing about what is measured — the kernel reports the same
   * numbers either way — only which part of the picture is the thing being
   * heard. That part is the sliver between input and output, so it stops being
   * an annotation and becomes the subject.
   */
  delta: { type: Boolean, default: false },
  /**
   * Sensitivity weighting nodes, edited in place on this plot.
   *
   * They are not filters and they are not drawn as filters: a node moves the
   * DETECTION THRESHOLD over a span of the spectrum, so the thing it changes is
   * already on this plot as the dashed line. Editing them anywhere else would
   * mean drawing the threshold here and its controls somewhere else, which is
   * the arrangement this display was built to replace.
   */
  weightNodes: { type: Array, default: () => [] },
  height: { type: Number, default: 188 },
  /**
   * Accessible name for the plot. Not drawn — a canvas is opaque to a screen
   * reader, and this is the only thing that tells one what the element is.
   */
  title: { type: String, default: 'Spectral reduction' },
})

const emit = defineEmits(['update:weightNodes'])

// ── Geometry ────────────────────────────────────────────────────────────────

/** Gap between the lanes, carrying the divider rule. */
const LANE_GAP = 7
/** Strip along the bottom for the frequency numerals. */
const AXIS_H = 13
/**
 * Share of the plot given to the reduction lane.
 *
 * A fraction rather than a fixed depth, because the panel sizes this display to
 * whatever height it can spare and a fixed lane takes the whole cut out of the
 * spectrum: at 188 px the split was 56/112, and the same 56 at 140 px would
 * leave the spectrum 64 px to draw a harmonic comb, a reference and an output
 * curve in. Reduction needs less room than the spectrum — it is one curve
 * against a scale, not three against each other.
 */
const GR_SHARE = 0.36
/** Vertical clearance between two numerals on the reduction scale. */
const MIN_SCALE_GAP_PX = 11
/** Below this fraction of the scale the peak hold has nothing to say. */
const PEAK_VISIBLE = 0.025

const grH = computed(() =>
  Math.round(Math.max(34, (props.height - LANE_GAP - AXIS_H) * GR_SHARE)))
const specTop = computed(() => grH.value + LANE_GAP)
const specH = computed(() => Math.max(40, props.height - specTop.value - AXIS_H))

/**
 * Spectrum window, dBFS.
 *
 * Fixed rather than auto-scaled. An analyser that rescales itself turns "the
 * resonance got quieter" into "everything moved", which is the one comparison
 * this display exists to support. The window is chosen for per-bin levels
 * rather than programme level: speech at -20 dBFS spreads across ~1000 bins, so
 * its formants land near -35 and its noise floor near -85. -102 to -12 puts
 * that in the middle with room for a tone, which reads at its true dBFS.
 */
const SPEC_DB_MIN = -102
const SPEC_DB_MAX = -12

/** Frequency grid. Same vocabulary as the EQ plot, so the two read alike. */
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

const canvasEl = ref(null)
/**
 * Measured width, republished every frame by draw(). No ResizeObserver: this
 * redraws continuously anyway, so a resize is picked up on the next frame and
 * an observer would only ever schedule a draw that was already scheduled.
 */
const width = ref(600)
/**
 * The frequency axis the last frame was drawn against.
 *
 * Plain object, not a ref: the pointer handlers read it, nothing renders from
 * it, and its whole purpose is that a hit test lands on the same axis the user
 * is looking at. The range comes from the kernel's frame, so it is not a
 * constant this component could hold on its own.
 */
const axis = { w: 600, minHz: 20, maxHz: 20000 }

// ── Colour ──────────────────────────────────────────────────────────────────

/**
 * Hex to rgba. Canvas has no color-mix(), and every tint on this plot is the
 * accent at some opacity, so the panel stays one colour when the accent changes.
 */
function tint(hex, alpha) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

// ── Readouts ────────────────────────────────────────────────────────────────

/**
 * The two numbers the bar used to carry, kept verbatim.
 *
 * Same ballistics, same gating, same refresh rate as GainReductionBar — the
 * plot answers "where", and these still answer "how much" and "how much on
 * average", which a plot of instantaneous depth is bad at.
 */
const averaged = createVuBallistics()
const heldAverage = createHeldAverage()
const readoutThrottle = createReadoutThrottle()
/**
 * A second throttle for the hotspot line.
 *
 * Not shared with the one above: a throttle is consumed by asking it, so two
 * readouts polling one instance would each see roughly half the ticks and the
 * pair would alternate rather than both refreshing at 10 Hz.
 */
const hotThrottle = createReadoutThrottle()
const readingDb = ref(0)
const averageDb = ref(0)
const hasAverage = ref(false)

/** Deepest live reduction and where it is, refreshed at readout rate. */
const hotHz = ref(0)
const hotDb = ref(0)

/** Frequency under the pointer, or null. */
const cursorX = ref(null)
const cursorText = ref('')

/**
 * Per-display-bin peak hold, and how long each bin has gone without a rise.
 *
 * Held in scale fractions rather than dB for the reason PEAK_FALL_PER_SEC
 * documents: on a voltage-law scale a fixed dB/s marker crawls at the deep end
 * and flicks at the shallow one. Sized on the first frame, because the bin
 * count is the kernel's to choose.
 *
 * ONE AGE PER BIN. This started as a single timer for the whole trace, on the
 * argument that per-bin ages would turn the hold into a comb of independently
 * aged spikes while one age keeps it legible as a curve. Measured, that is
 * simply wrong, and in the worst way: a shared timer resets whenever ANY of 192
 * bins rises, and on real material something always is, so the trace never
 * reached its decay phase at all. An intermittent 3 kHz ring left a mark still
 * sitting at full height three seconds after it stopped — the exact opposite of
 * what a peak hold is for. With per-bin ages the same mark reads 0.49, 0.37,
 * 0.16 over that interval.
 *
 * (A continuous decay with no plateau was measured too: it falls to zero
 * between events, which makes it a slow copy of the live trace rather than a
 * record of where the effect has been working.)
 */
let peakBins = null
let peakAges = null

/** Last frame identity, so a stopped transport reads as stale rather than live. */
let lastFrame = null
let staleMs = 0
/** Beyond this with no new frame, nothing is playing and the curves fade. */
const STALE_MS = 300

// ── Frame loop ──────────────────────────────────────────────────────────────

useMeterFrame((dtMs) => {
  const target = Math.abs(props.reductionDb)
  const fraction = averaged.push(grFraction(target, props.fullScaleDb), dtMs)
  averageDb.value = heldAverage.push(target, dtMs)
  hasAverage.value = heldAverage.active
  if (readoutThrottle.due(dtMs)) {
    readingDb.value = grFractionToDb(fraction, props.fullScaleDb)
  }
  draw(dtMs)
})

// ── Drawing ─────────────────────────────────────────────────────────────────

function draw(dtMs) {
  const canvas = canvasEl.value
  if (!canvas) return

  // Setting width resets the context, so the DPR scale is re-applied per frame
  // rather than saved and restored — same as EqPlot.
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0) return
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  width.value = w

  const frame = props.dataFn?.() ?? null
  if (frame && frame !== lastFrame) {
    lastFrame = frame
    staleMs = 0
  } else {
    staleMs += dtMs
  }
  const live = frame !== null && staleMs < STALE_MS
  // Fades rather than blanks: a frozen last frame is still the truth about the
  // moment the transport stopped, and blanking it would make a paused plugin
  // look broken. Dimmed, it reads as "not moving".
  const alpha = live ? 1 : 0.3

  const minHz = frame?.minHz ?? 20
  const maxHz = frame?.maxHz ?? 20000
  const octaves = Math.log2(maxHz / minHz)
  const xFor = hz => (Math.log2(Math.max(hz, minHz) / minHz) / octaves) * w
  // Published for the pointer handlers. They need the same axis the curves were
  // drawn against, and it is derived here from the frame the kernel sent — a
  // second copy in the handlers could disagree with the picture by a frame.
  axis.w = w
  axis.minHz = minHz
  axis.maxHz = maxHz

  drawPlates(ctx, w)
  drawGrid(ctx, w, xFor, minHz, maxHz)

  updatePeaks(frame, dtMs)
  if (frame) {
    drawSpectrum(ctx, w, frame, alpha)
    drawReduction(ctx, w, frame, alpha)
  }
  drawWeightNodes(ctx, w, xFor, frame)

  drawOutOfBand(ctx, w, xFor, minHz, maxHz)
  drawGrScale(ctx, w)
  drawAxis(ctx, w, xFor, minHz, maxHz)
  drawCursor(ctx, w)
}

/** The two recessed lanes and the rule between them. */
function drawPlates(ctx, w) {
  ctx.fillStyle = 'rgba(0,0,0,.42)'
  ctx.fillRect(0, 0, w, grH.value)
  ctx.fillRect(0, specTop.value, w, specH.value)

  ctx.fillStyle = 'rgba(255,255,255,.07)'
  ctx.fillRect(0, grH.value + (LANE_GAP - 1) / 2, w, 1)
}

function drawGrid(ctx, w, xFor, minHz, maxHz) {
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  for (const hz of GRID_HZ) {
    if (hz < minHz || hz > maxHz) continue
    const x = Math.round(xFor(hz)) + 0.5
    if (x >= w) continue
    ctx.fillRect(x, 0, 1, grH.value)
    ctx.fillRect(x, specTop.value, 1, specH.value)
  }
}

/**
 * Reduction, hanging from the top of its lane.
 *
 * Downward because that is the direction of the thing: a cut. The filled area
 * is this frame; the outline behind it is the peak hold, which is what turns an
 * intermittent ring into something you can point at — a resonance that only
 * sounds on certain words is a flicker in the live fill and a standing shape in
 * the hold.
 */
function drawReduction(ctx, w, frame, alpha) {
  const { reduction, bins } = frame
  const xStep = w / (bins - 1)
  const yFor = db => grFraction(db, props.fullScaleDb) * grH.value

  ctx.globalAlpha = alpha
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, grH.value)
  ctx.clip()

  ctx.beginPath()
  ctx.moveTo(0, 0)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(reduction[d]))
  ctx.lineTo(w, 0)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, grH.value)
  grad.addColorStop(0, tint(props.accent, 0.62))
  grad.addColorStop(1, tint(props.accent, 0.18))
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const y = yFor(reduction[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.lineWidth = 1.5
  ctx.strokeStyle = props.accent
  ctx.stroke()

  // Peak hold, drawn only where there is a peak to hold. Running it across the
  // whole width would lay a white line along the zero datum on top of the live
  // trace, which reads as a border on the lane rather than as a measurement.
  if (peakBins) {
    ctx.beginPath()
    let open = false
    for (let d = 0; d < bins; d++) {
      if (peakBins[d] <= PEAK_VISIBLE) {
        open = false
        continue
      }
      const y = peakBins[d] * grH.value
      const x = d * xStep
      open ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      open = true
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,.32)'
    ctx.stroke()
  }

  ctx.restore()
  ctx.globalAlpha = 1
}

/**
 * Input, threshold and output over one another.
 *
 * The threshold is the reference plus Selectivity, added here rather than in the
 * kernel so the line moves with the knob on the frame it is turned instead of
 * on the next one out of the worklet. Everything at or under it is left alone;
 * everything over it is what the top lane is taking out.
 */
function drawSpectrum(ctx, w, frame, alpha) {
  const { mag, reference, output, bins } = frame
  const top = specTop.value
  const height = specH.value
  const bottom = top + height
  const xStep = w / (bins - 1)
  const yFor = (db) => {
    const t = (db - SPEC_DB_MIN) / (SPEC_DB_MAX - SPEC_DB_MIN)
    return bottom - Math.max(0, Math.min(1, t)) * height
  }

  ctx.globalAlpha = alpha
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, w, height)
  ctx.clip()

  // Input: filled, low contrast. It is the ground the other two are read
  // against, not a curve to be followed.
  ctx.beginPath()
  ctx.moveTo(0, bottom)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(mag[d]))
  ctx.lineTo(w, bottom)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,.07)'
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,.26)'
  ctx.stroke()

  // What is being removed: the sliver between input and output. Only visible
  // where the effect is doing something, which is the point of drawing it.
  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const x = d * xStep
    d === 0 ? ctx.moveTo(x, yFor(mag[d])) : ctx.lineTo(x, yFor(mag[d]))
  }
  for (let d = bins - 1; d >= 0; d--) {
    ctx.lineTo(d * xStep, yFor(output[d]))
  }
  ctx.closePath()
  ctx.fillStyle = tint(props.accent, props.delta ? 0.5 : 0.24)
  ctx.fill()

  // Threshold: dashed, because it is a decision boundary rather than a signal.
  //
  // TWO OF THEM ONCE A SENSITIVITY NODE EXISTS, and the pair is the whole
  // explanation of the feature. The dim line is the flat threshold Selectivity
  // asks for; the bright one is what the detector will actually use after the
  // nodes offset it, floored at zero the way the kernel floors it. The gap
  // between them is the node — its depth AND its width, drawn at the place the
  // decision is made rather than as a separate curve needing to be related back
  // to this one. With no nodes the two coincide and only one is drawn, so a
  // panel that has never touched this looks exactly as it did.
  const spanOct = Math.log2(frame.maxHz / frame.minHz)
  const hzAt = d => frame.minHz * Math.pow(2, (d / (bins - 1)) * spanOct)
  const nodes = liveNodes.value
  const thresholdAt = d => nodes.length
    ? Math.max(0, props.selectivityDb - resonanceWeightDbAt(nodes, hzAt(d)))
    : props.selectivityDb

  if (nodes.length) {
    // Shaded between the two, so the region a node reaches over is legible at a
    // glance and not only where the line happens to be steep.
    ctx.beginPath()
    for (let d = 0; d < bins; d++) {
      const y = yFor(reference[d] + props.selectivityDb)
      d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
    }
    for (let d = bins - 1; d >= 0; d--) {
      ctx.lineTo(d * xStep, yFor(reference[d] + thresholdAt(d)))
    }
    ctx.closePath()
    // Accent-tinted rather than grey, and not faint. The band is only as tall
    // as the offset it represents — 6 dB out of a 90 dB window is about five
    // pixels — so at low contrast a working node reads as a rendering seam.
    // Exaggerating the height would be a plot that lies about magnitude; making
    // five honest pixels legible is not.
    ctx.fillStyle = tint(props.accent, 0.3)
    ctx.fill()

    ctx.beginPath()
    for (let d = 0; d < bins; d++) {
      const y = yFor(reference[d] + props.selectivityDb)
      d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
    }
    ctx.setLineDash([2, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,.20)'
    ctx.stroke()
    ctx.setLineDash([])
  }

  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const y = yFor(reference[d] + thresholdAt(d))
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.setLineDash([3, 3])
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,.42)'
  ctx.stroke()
  ctx.setLineDash([])

  // Output: the one bright curve, and the kernel's own summary of it rather
  // than this frame's magnitude minus this frame's reduction. Those are drawn
  // from different FFT bins inside a display cell — see RESONANCE_DISPLAY_CURVES
  // — so subtracting them here would carve a notch nothing in the audio has.
  // Coincides with the input outline wherever nothing is being done, so any gap
  // between the two is the effect working.
  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const y = yFor(output[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.lineWidth = 1.6
  ctx.strokeStyle = props.accent
  ctx.stroke()

  ctx.restore()
  ctx.globalAlpha = 1
}

/** Out-of-band frequencies, washed out in both lanes with the limit marked. */
function drawOutOfBand(ctx, w, xFor, minHz, maxHz) {
  const wash = 'rgba(6,8,7,.72)'
  const edge = 'rgba(255,255,255,.14)'
  const bottom = specTop.value + specH.value

  const paint = (x0, x1) => {
    if (x1 <= x0) return
    ctx.fillStyle = wash
    ctx.fillRect(x0, 0, x1 - x0, grH.value)
    ctx.fillRect(x0, specTop.value, x1 - x0, bottom - specTop.value)
  }
  const rule = (x) => {
    ctx.fillStyle = edge
    ctx.fillRect(Math.round(x) + 0.5, 0, 1, grH.value)
    ctx.fillRect(Math.round(x) + 0.5, specTop.value, 1, bottom - specTop.value)
  }

  if (props.freqFloorHz > minHz) {
    const x = Math.min(xFor(props.freqFloorHz), w)
    paint(0, x)
    rule(x)
  }
  if (props.freqCeilHz < maxHz) {
    const x = Math.max(0, xFor(props.freqCeilHz))
    paint(x, w)
    rule(x)
  }
}

/**
 * Numerals down the right of the reduction lane.
 *
 * Thinned by pixel spacing, not by dB. The scale is a voltage law, so the top
 * of it is crowded — on a 56 px lane the bar's own -1, -3 and -5 land within
 * 15 px of each other and print as one smear. Keeping whichever marks survive
 * a minimum gap means the lane can be any height and the engraving still reads.
 */
function drawGrScale(ctx, w) {
  ctx.font = "600 7.5px 'JetBrains Mono',monospace"
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  let lastY = -Infinity
  for (const mark of grScaleMarks(props.fullScaleDb)) {
    if (!mark.label || mark.db === 0) continue
    const y = mark.fraction * grH.value
    if (y < MIN_SCALE_GAP_PX / 2 || y > grH.value - 3 || y - lastY < MIN_SCALE_GAP_PX) continue
    lastY = y
    ctx.fillStyle = 'rgba(255,255,255,.06)'
    ctx.fillRect(0, Math.round(y) + 0.5, w - 20, 1)
    ctx.fillStyle = 'rgba(255,255,255,.32)'
    ctx.fillText(`-${mark.label}`, w - 4, y)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function hzLabel(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

function drawAxis(ctx, w, xFor, minHz, maxHz) {
  ctx.font = "600 7.5px 'JetBrains Mono',monospace"
  ctx.fillStyle = 'rgba(255,255,255,.3)'
  ctx.textBaseline = 'bottom'
  const y = props.height - 2
  for (const hz of GRID_HZ) {
    if (hz < minHz || hz > maxHz) continue
    const x = xFor(hz)
    const label = hzLabel(hz)
    const tw = ctx.measureText(label).width
    // The top of the range would otherwise hang off the right edge.
    ctx.textAlign = x + tw / 2 > w ? 'right' : 'center'
    ctx.fillText(label, ctx.textAlign === 'right' ? w : x, y)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawCursor(ctx, w) {
  if (cursorX.value === null) return
  const x = Math.round(cursorX.value) + 0.5
  if (x < 0 || x > w) return
  ctx.fillStyle = 'rgba(255,255,255,.22)'
  ctx.fillRect(x, 0, 1, grH.value)
  ctx.fillRect(x, specTop.value, 1, specH.value)
}

/**
 * Peak hold and the hotspot readout.
 *
 * The hold falls as one shape rather than per bin with its own timer each: a
 * single fall rate across the whole trace keeps it readable as a curve, and a
 * per-bin timer array would have to be reallocated whenever the bin count moved.
 */
function updatePeaks(frame, dtMs) {
  const step = Math.min(dtMs, 100)

  const fall = (PEAK_FALL_PER_SEC * step) / 1000

  if (!frame) {
    // Nothing playing: let the hold run down rather than freezing a shape that
    // no longer describes anything, and drop the hotspot line.
    if (peakBins) {
      for (let d = 0; d < peakBins.length; d++) {
        peakBins[d] = Math.max(0, peakBins[d] - fall)
      }
    }
    hotDb.value = 0
    cursorText.value = ''
    return
  }

  const { reduction, reductionHeld, bins, minHz, maxHz } = frame
  if (!peakBins || peakBins.length !== bins) {
    peakBins = new Float32Array(bins)
    peakAges = new Float32Array(bins)
  }

  let hotFraction = 0
  let hotIndex = 0
  for (let d = 0; d < bins; d++) {
    // The hold is fed by the held curve, which is the only thing that value is
    // for: it catches a peak landing on a frame the reader never saw.
    const held = grFraction(reductionHeld[d], props.fullScaleDb)
    if (held > peakBins[d]) {
      // Strictly greater. Equal is not a rise — a bin sitting at zero against a
      // held zero would otherwise restart its plateau on every frame forever.
      peakBins[d] = held
      peakAges[d] = 0
    } else {
      peakAges[d] += step
      // Flat for the plateau every other peak marker in the app holds for, then
      // down at the rate they all fall at, never below the live reading.
      if (peakAges[d] >= PEAK_HOLD_MS) {
        peakBins[d] = Math.max(held, peakBins[d] - fall)
      }
    }

    const f = grFraction(reduction[d], props.fullScaleDb)
    if (f > hotFraction) {
      hotFraction = f
      hotIndex = d
    }
  }

  if (hotThrottle.due(dtMs)) {
    hotDb.value = reduction[hotIndex]
    hotHz.value = minHz * Math.pow(2, (hotIndex / (bins - 1)) * Math.log2(maxHz / minHz))
  }
  updateCursorText(frame)
}

// ── Sensitivity nodes ───────────────────────────────────────────────────────

/**
 * EQ-style nodes that are not filters, edited directly on the plot.
 *
 * A node offsets Selectivity — the threshold a bin must protrude above the
 * reference before it is treated — over a span of the spectrum. Positive is
 * MORE sensitive, because that is the direction the effect moves in: pushing a
 * node up makes the suppressor more willing to act there. It reads backwards as
 * a gain (up means quieter output) and correctly as what it is (up means more
 * treatment), and soothe2 names the same inversion when it calls its own
 * version "an inverse EQ".
 *
 * WHY HERE AND NOT IN A CONTROL STRIP. The quantity a node changes is the
 * dashed line on this plot, and the reason to place one is a peak in the curve
 * underneath it. A node editor anywhere else would mean reading a frequency off
 * this display and typing it into another control, which is the round trip the
 * display was built to remove.
 */

/** Which node the keyboard and the readout are talking about, or null. */
const selectedId = ref(null)
/** Live drag, or null. Held outside reactivity — it changes on pointer events. */
let drag = null
/** Set while dragging, so the cursor can say so. */
const dragging = ref(false)

/** Nodes that would actually change a threshold. Drawing keys off this. */
const liveNodes = computed(() => props.weightNodes.filter(
  n => n && n.enabled !== false && n.gainDb && n.freqHz > 0,
))

let nextNodeId = 1

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Where a node's handle sits: on the threshold curve it is bending.
 *
 * The curve moves with the audio, so the handle bobs — which is why nodeAt()
 * hit-tests on frequency alone.
 */
function nodeY(node) {
  const frame = lastFrame
  const top = specTop.value
  const height = specH.value
  if (!frame) return top + height * 0.5
  const { reference, bins, minHz, maxHz } = frame
  const t = Math.log2(clamp(node.freqHz, minHz, maxHz) / minHz) / Math.log2(maxHz / minHz)
  const d = clamp(Math.round(t * (bins - 1)), 0, bins - 1)
  const offset = Math.max(0, props.selectivityDb - resonanceWeightDbAt(liveNodes.value, node.freqHz))
  const db = reference[d] + offset
  const f = clamp((db - SPEC_DB_MIN) / (SPEC_DB_MAX - SPEC_DB_MIN), 0, 1)
  return top + height - f * height
}

function drawWeightNodes(ctx, w, xFor, frame) {
  if (props.weightNodes.length === 0) return
  const top = specTop.value
  const bottom = top + specH.value

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, top, w, specH.value)
  ctx.clip()

  for (const node of props.weightNodes) {
    const x = xFromHz(node.freqHz, axis)
    const y = nodeY(node)
    const selected = node.id === selectedId.value
    const off = node.enabled === false || !node.gainDb
    const colour = off
      ? 'rgba(255,255,255,.28)'
      : node.gainDb > 0 ? props.accent : '#ffb27a'

    // Stem to the floor of the lane. A handle on a moving curve is hard to
    // find when it is up against a loud partial; the stem is at the node's
    // frequency whatever the curve is doing, and it is what the eye follows
    // down to the peak the node was placed for.
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, y)
    ctx.lineTo(Math.round(x) + 0.5, bottom)
    ctx.setLineDash([1, 3])
    ctx.lineWidth = 1
    ctx.strokeStyle = off ? 'rgba(255,255,255,.14)' : tint(props.accent, 0.3)
    ctx.stroke()
    ctx.setLineDash([])

    // Width whisker: the node's sigma either side, in octaves. Drawn because
    // width is otherwise only readable off the shaded region, which vanishes
    // wherever the two thresholds meet the floor.
    const oct = nodeOctaves(node)
    const x0 = xFromHz(node.freqHz * Math.pow(2, -oct), axis)
    const x1 = xFromHz(node.freqHz * Math.pow(2, oct), axis)
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.lineWidth = selected ? 1.5 : 1
    ctx.strokeStyle = off ? 'rgba(255,255,255,.18)' : tint(props.accent, selected ? 0.55 : 0.34)
    ctx.stroke()
    for (const cap of [x0, x1]) {
      ctx.beginPath()
      ctx.moveTo(Math.round(cap) + 0.5, y - 3)
      ctx.lineTo(Math.round(cap) + 0.5, y + 3)
      ctx.stroke()
    }

    if (selected) {
      ctx.beginPath()
      ctx.arc(x, y, 8, 0, Math.PI * 2)
      ctx.fillStyle = tint(props.accent, 0.16)
      ctx.fill()
    }
    // Small, because it sits on top of the band it created and the band is
    // only a few pixels tall — a generous handle would hide the thing it is
    // there to adjust. The grab radius is unaffected: nodeAt() works in
    // frequency, so the target is wider than the dot.
    ctx.beginPath()
    ctx.arc(x, y, selected ? 4 : 3.2, 0, Math.PI * 2)
    ctx.fillStyle = colour
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0,0,0,.55)'
    ctx.stroke()
  }

  ctx.restore()
}

// ── Node editing ────────────────────────────────────────────────────────────
//
// Every edit replaces the array. The kernel is handed a new copy on each
// change and nothing mutates a node in place — see resWeightNodes.

function commit(nodes) {
  if (nodes !== props.weightNodes) emit('update:weightNodes', nodes)
}

function addNodeAt(freqHz) {
  const id = `w${nextNodeId++}`
  const next = addNode(props.weightNodes, freqHz, axis, id)
  if (next === props.weightNodes) return
  commit(next)
  selectedId.value = id
}

function dropNode(id) {
  commit(removeNode(props.weightNodes, id))
  if (selectedId.value === id) selectedId.value = null
}

function nudge(id, step) {
  commit(nudgeNode(props.weightNodes, id, step, axis))
}

function onDown(e) {
  if (e.button !== 0) return
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  canvasEl.value?.focus({ preventScroll: true })
  const node = nodeAt(props.weightNodes, x, axis)
  if (!node) {
    selectedId.value = null
    return
  }
  selectedId.value = node.id
  drag = {
    id: node.id,
    // Shift picks width rather than frequency. Width is the one property with
    // no natural direction on this axis, and the alternative was a third drag
    // target on a handle that is 8 px across.
    width: e.shiftKey,
    x,
    y: e.clientY,
    freqHz: node.freqHz,
    gainDb: node.gainDb,
    octaves: nodeOctaves(node),
  }
  dragging.value = true
  canvasEl.value?.setPointerCapture?.(e.pointerId)
  e.preventDefault()
}

function onDrag(e, x) {
  if (!drag) return
  commit(dragNode(props.weightNodes, drag, x - drag.x, e.clientY - drag.y, axis))
}

function onUp(e) {
  if (!drag) return
  drag = null
  dragging.value = false
  canvasEl.value?.releasePointerCapture?.(e.pointerId)
}

function onDblClick(e) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  const node = nodeAt(props.weightNodes, x, axis)
  if (node) dropNode(node.id)
  else addNodeAt(hzFromX(x, axis))
  e.preventDefault()
}

function onWheel(e) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const node = nodeAt(props.weightNodes, e.clientX - rect.left, axis)
  if (!node) return
  selectedId.value = node.id
  nudge(node.id, { widthFactor: Math.exp(-e.deltaY * 0.0012) })
}

/**
 * Keyboard equivalents for everything the pointer can do.
 *
 * Not a nicety. Putting the only editor for a parameter inside a canvas makes
 * it unreachable without a mouse, and the rest of this panel is knobs and
 * switches that are not — so this would be the one control in it that some
 * people simply could not use.
 */
function onKeyDown(e) {
  const nodes = props.weightNodes
  if (e.key === 'n' || e.key === 'N') {
    addNodeAt(hzFromX(axis.w * 0.5, axis))
    e.preventDefault()
    return
  }
  if (nodes.length === 0) return
  if (selectedId.value === null) {
    selectedId.value = nodes[0].id
    e.preventDefault()
    return
  }
  // Coarse by default and finer with Shift, the opposite of the usual pairing:
  // a node is placed by eye off the curve underneath it, so the first thing
  // anyone does with the arrows is travel, and the trim comes after.
  const step = e.shiftKey ? 1 : 4
  switch (e.key) {
    case 'ArrowLeft': nudge(selectedId.value, { octaves: -0.02 * step }); break
    case 'ArrowRight': nudge(selectedId.value, { octaves: 0.02 * step }); break
    case 'ArrowUp': nudge(selectedId.value, { db: 0.5 * step }); break
    case 'ArrowDown': nudge(selectedId.value, { db: -0.5 * step }); break
    case '[': nudge(selectedId.value, { widthFactor: 1 / 1.12 }); break
    case ']': nudge(selectedId.value, { widthFactor: 1.12 }); break
    case 'Delete':
    case 'Backspace': dropNode(selectedId.value); break
    default: return
  }
  e.preventDefault()
}

/**
 * What to say when this line has nothing else to say.
 *
 * The nodes live inside a canvas, so there is no control anywhere to suggest
 * they exist — a tooltip only helps someone who already suspects. This borrows
 * the idle state of a line that is otherwise blank, costs no height in a panel
 * that has none to give, and stops the moment the first node is placed.
 */
const idleHint = computed(() =>
  props.weightNodes.length ? '' : 'DBL-CLICK: SENSITIVITY NODE')

/** The selected or dragging node, in words. Shares the line with the cursor. */
const nodeText = computed(() => {
  const node = props.weightNodes.find(n => n.id === selectedId.value)
  if (!node) return ''
  const oct = nodeOctaves(node)
  const sign = node.gainDb > 0 ? '+' : ''
  return `SENS ${formatHz(node.freqHz)} · ${sign}${node.gainDb.toFixed(1)} dB · ${oct.toFixed(2)} oct`
})

// ── Pointer readout ─────────────────────────────────────────────────────────

function updateCursorText(frame) {
  if (cursorX.value === null) {
    cursorText.value = ''
    return
  }
  const { bins, minHz, maxHz, mag, reduction } = frame
  const t = Math.max(0, Math.min(1, cursorX.value / width.value))
  const d = Math.round(t * (bins - 1))
  const hz = minHz * Math.pow(2, t * Math.log2(maxHz / minHz))
  cursorText.value =
    `${formatHz(hz)}  ·  ${mag[d].toFixed(0)} dBFS  ·  ${reduction[d] > 0.05 ? `-${reduction[d].toFixed(1)}` : '0.0'} dB`
}

function onMove(e) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  cursorX.value = x
  onDrag(e, x)
}

function onLeave() {
  // Only the readout goes. A drag in progress keeps running off the edge of the
  // plot, because the pointer is captured and letting go of a node because the
  // pointer crossed a boundary is how a drag ends up dropping it somewhere the
  // user did not aim for.
  cursorX.value = null
  cursorText.value = ''
}

function formatHz(hz) {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} kHz`
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`
  return `${Math.round(hz)} Hz`
}

/** Where the deepest cut is right now, or nothing when the effect is idling. */
const hotspotText = computed(() =>
  hotDb.value > 0.3 ? `PEAK ${formatHz(hotHz.value)} · -${hotDb.value.toFixed(1)} dB` : '',
)

/**
 * What the plot says, in a sentence, for anyone who cannot see it.
 *
 * A canvas is opaque to a screen reader, so replacing the gain-reduction bar
 * with this display took away a number that used to be plain text and gave
 * nothing back. The three facts that carried are where the deepest cut is, how
 * deep, and which band is being processed at all.
 *
 * Not a live region, and rounded to whole decibels: it is a description of the
 * element, read when someone reaches it, and it must not turn into a meter that
 * interrupts every tenth of a second. Whole dB also means the string stops
 * changing while the reading is merely wobbling.
 */
const plotSummary = computed(() => {
  const cut = hotDb.value > 0.3
    ? `Deepest cut ${Math.round(hotDb.value)} dB at ${formatHz(hotHz.value)}.`
    : 'No reduction.'
  const band = `Processing ${formatHz(props.freqFloorHz)} to ${formatHz(props.freqCeilHz)}.`
  const mode = props.delta ? ' Monitoring the removed signal only.' : ''
  const nodes = props.weightNodes.length
    ? ` ${props.weightNodes.length} sensitivity node${props.weightNodes.length > 1 ? 's' : ''}: `
      + props.weightNodes.map(n =>
        `${formatHz(n.freqHz)} ${n.gainDb > 0 ? '+' : ''}${n.gainDb.toFixed(1)} decibels`).join(', ')
      + '.'
    : ''
  return `${props.title}. ${cut} ${band}${mode}${nodes} ${NODE_HINT}`
})

/**
 * How to work the nodes, in one string, used as both the tooltip and the tail
 * of the accessible name.
 *
 * The same sentence in both places on purpose: this is a canvas, so there is no
 * other way to discover that double-clicking it does anything, and a sighted
 * user hovering and a screen-reader user landing on it deserve the same
 * instruction rather than two that have to be kept in step.
 */
const NODE_HINT = 'Double-click to place a sensitivity node, again to remove it. '
  + 'Drag to move, shift-drag or scroll for width. '
  + 'Keyboard: n adds, arrows move, [ and ] set width, Delete removes.'

</script>

<template>
  <div>
    <!-- One line above the plot, carrying everything that is not the plot.
         It was two — readouts over the plot, legend and readout under it — and
         the panel could not afford both once the display went in. What went
         was the "SPECTRAL REDUCTION" title: the legend names all three curves,
         the scale down the right of the top lane names what it measures, and a
         title naming the panel a second time was the only line here that told
         you nothing you could not read off the plot. -->
    <div class="flex items-baseline gap-[14px] mb-1.5">
      <span class="flex items-baseline gap-[9px] shrink-0">
        <span :style="{
                font: `700 12px 'JetBrains Mono',monospace`,
                color: `color-mix(in srgb, ${accent} 65%, #ffffff)`,
                textShadow: `0 0 8px color-mix(in srgb, ${accent} 55%, transparent)`,
              }">{{ readingDb.toFixed(1) }} dB</span>
        <span style="font:600 9px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.38)">
          AVG {{ hasAverage ? averageDb.toFixed(1) : '—' }}
        </span>
        <!-- Second statement of a mode the header pill already shows, and
             worth the duplication: someone reading the plot to decide whether
             a cut is landing where they want has their eyes here, not on the
             title bar, and the sliver being loud is otherwise unexplained. -->
        <span
          v-show="delta"
          class="px-[5px] py-[1px] rounded"
          :style="{
            font: `700 8px 'JetBrains Mono',monospace`,
            letterSpacing: '.12em',
            color: `color-mix(in srgb, ${accent} 55%, #ffffff)`,
            background: `color-mix(in srgb, ${accent} 22%, transparent)`,
          }"
        >DELTA</span>
      </span>

      <span class="flex items-center gap-[11px] shrink-0"
            style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.06em;color:rgba(255,255,255,.32)">
        <span class="flex items-center gap-[4px]">
          <span :style="{ width: '10px', height: '2px', background: 'rgba(255,255,255,.3)' }"></span>INPUT
        </span>
        <span class="flex items-center gap-[4px]">
          <span :style="{
            width: '10px', height: '2px',
            backgroundImage: 'repeating-linear-gradient(90deg,rgba(255,255,255,.45) 0 3px,transparent 3px 6px)',
          }"></span>THRESHOLD
        </span>
        <span class="flex items-center gap-[4px]">
          <span :style="{ width: '10px', height: '2px', background: accent }"></span>OUTPUT
        </span>
        <!-- Only once there is one. With no nodes the two thresholds coincide
             and there is nothing on the plot for this word to point at. -->
        <span
          v-if="weightNodes.length"
          class="flex items-center gap-[4px]"
          :style="{ color: `color-mix(in srgb, ${accent} 50%, rgba(255,255,255,.5))` }"
        >
          <span :style="{
            width: '10px', height: '2px',
            background: `color-mix(in srgb, ${accent} 60%, transparent)`,
          }"></span>SENSITIVITY x{{ weightNodes.length }}
        </span>
      </span>

      <!-- Whatever the pointer is over, or where the deepest cut is when it is
           over nothing. Right-aligned into the space left over, so the text
           changing length moves nothing else on the line. -->
      <span
        class="flex-1 text-right truncate"
        style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.06em"
        :style="{ color: cursorText ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.32)' }"
      >{{ nodeText || cursorText || hotspotText || idleHint }}</span>
    </div>

    <div
      :style="{
        padding: '3px',
        borderRadius: '9px',
        background: '#0a0806',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.05)',
      }"
    >
      <!-- role="group" rather than "img" now that it is operable: an image is
           not something a screen reader offers to interact with, and this one
           holds the only editor for the sensitivity nodes. The label still
           carries the reading, because there is nothing else to read. -->
      <canvas
        ref="canvasEl"
        class="block w-full"
        tabindex="0"
        role="group"
        :aria-label="plotSummary"
        :title="NODE_HINT"
        :style="{ height: `${height}px`, borderRadius: '6px', cursor: dragging ? 'grabbing' : 'crosshair' }"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="onLeave"
        @dblclick="onDblClick"
        @wheel.prevent="onWheel"
        @keydown="onKeyDown"
      ></canvas>
    </div>
  </div>
</template>
