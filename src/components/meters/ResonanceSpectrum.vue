<script setup>
import { computed, ref } from 'vue'
import {
  zoneBounds,
  zoneSettings,
  zoneSettingsAt,
} from '../../audio/resonanceParams.js'
import {
  boundaryAt,
  hzFromX,
  moveBoundary,
  removeBoundary,
  splitZone,
  xFromHz,
  zoneIndexAt,
  zonePeakReductions,
} from './resonanceZoneEdit.js'
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
   * Sensitivity zones, edited in place on this plot.
   *
   * A zone is a span of the spectrum with its own detection threshold offset
   * and its own share of Depth. They are drawn and edited here because the
   * thing they change — the threshold — is already on this plot, and because a
   * span of the spectrum is a horizontal extent, which is what this axis is.
   */
  zones: { type: Array, default: () => [] },
  /** Which zone the controls below are editing. Selection is owned by the panel. */
  selectedZone: { type: Number, default: -1 },
  /**
   * Soloed zone, or -1.
   *
   * Drawn, because solo changes what is being heard and a display that did not
   * show it would disagree with the speakers — the same reason the DELTA badge
   * is repeated on this line. It arrives separately from `zones` rather than
   * baked into them so the knobs keep reading the stored settings.
   */
  soloZone: { type: Number, default: -1 },
  height: { type: Number, default: 188 },
  /**
   * Accessible name for the plot. Not drawn — a canvas is opaque to a screen
   * reader, and this is the only thing that tells one what the element is.
   */
  title: { type: String, default: 'Spectral reduction' },
})

const emit = defineEmits(['update:zones', 'update:selectedZone'])

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

/**
 * PEAK REDUCTION PER ZONE — the display's one number was still single-band.
 *
 * The detector became multiband and the readout did not: a single global
 * `PEAK 3.2k · -4.1 dB` describes a panel with one set of settings, and this one
 * has up to six. It is the same objection that got the gain-reduction meter
 * replaced by this plot in the first place — one number cannot distinguish a
 * surgical notch from the same depth spread across half the spectrum — quietly
 * reintroduced in the text line above it.
 *
 * So each zone gets its own reading, printed at the top of its own column, and
 * the line readout scopes to the SELECTED zone. Deepest cut inside the zone
 * rather than a mean: the mean over a whole zone is dominated by the bins the
 * effect is correctly leaving alone, so it reads near zero whatever is
 * happening, and "how deep is the deepest cut in this band" is the question the
 * knobs beneath are answering.
 *
 * Indexed by zone.
 */
const zonePeaks = ref([])

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

// ── Display averaging ───────────────────────────────────────────────────────

/**
 * How long the drawn curves take to reach a new reading, as a time constant.
 *
 * THE SAME QUANTITY THE SPECTRUM ANALYZER CALLS "AVERAGING", stated in the unit
 * that survives a change of frame rate. That slider is an AnalyserNode's
 * `smoothingTimeConstant`, a per-FFT pole applied once per read — so its
 * percentage only means anything alongside the interval it is applied over
 * (there, one animation frame, ~16.7 ms): alpha 0.50 is tau 24 ms, the 0.72
 * default is 51 ms, and alpha 0.80 is 75 ms.
 *
 * This plot is fed from the worklet every 1024 samples (~23 ms) and drawn on
 * rAF, two rates that need not agree, so a per-frame pole would drift with
 * either. Holding tau and deriving the coefficient from the elapsed time makes
 * the settling time the thing that is fixed, which is what the analyzer's knob
 * is understood to mean even though its own implementation cannot promise it.
 *
 * 75 ms = the analyzer at 80% averaging, which is what this was asked for:
 * unaveraged, the trace steps at the post rate and reads about like 50%.
 */
const DISPLAY_TAU_MS = 75

/**
 * Smoothed copies of the four continuous curves, and the frame view drawn from
 * them.
 *
 * `reductionHeld` is deliberately NOT smoothed and not copied here: it is the
 * maximum since the previous read, and averaging a maximum is the one operation
 * that destroys what it is for — a peak landing on a single frame is exactly
 * the event the hold exists to catch.
 *
 * Averaged in dB rather than in magnitude. AnalyserNode does the opposite, and
 * on a decaying trace the difference shows as a slightly faster fall there than
 * here; dB is what these arrays already carry, and converting twice per bin per
 * frame to inherit a detail of somebody else's implementation is not worth it.
 */
const SMOOTHED = ['mag', 'reference', 'output', 'reduction']
let smoothArrays = null
let smoothView = null

function smoothFrame(frame, dtMs) {
  const { bins } = frame
  if (!smoothArrays || smoothArrays.mag.length !== bins) {
    smoothArrays = {
      mag: new Float32Array(bins),
      reference: new Float32Array(bins),
      output: new Float32Array(bins),
      reduction: new Float32Array(bins),
    }
    // Seeded from the frame, not from zero: a fade up from silence on the first
    // frame after the window opens would read as the effect starting to work.
    for (const key of SMOOTHED) smoothArrays[key].set(frame[key])
    smoothView = { ...smoothArrays }
  }

  // Frame-rate independent one-pole. Clamped for the same reason the peak hold
  // clamps its step: a backgrounded tab returns with a dt of seconds, and
  // 1 - exp(-dt/tau) is 1 there, which would snap the trace rather than average
  // it — harmless, but it would land on whichever frame the tab woke up on.
  const coef = 1 - Math.exp(-Math.min(dtMs, 100) / DISPLAY_TAU_MS)
  for (const key of SMOOTHED) {
    const dst = smoothArrays[key]
    const src = frame[key]
    for (let d = 0; d < bins; d++) dst[d] += (src[d] - dst[d]) * coef
  }

  // Everything the drawing code reads that is not a smoothed curve — the bin
  // count, the axis, and the held curve — passes through untouched.
  smoothView.bins = bins
  smoothView.minHz = frame.minHz
  smoothView.maxHz = frame.maxHz
  smoothView.reductionHeld = frame.reductionHeld
  return smoothView
}


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

  // Averaged before anything reads it, so the curves, the peak hold's live
  // floor and the hotspot readout all describe the same trace. The held curve
  // inside it is still the kernel's raw maximum — see smoothFrame.
  const shown = frame ? smoothFrame(frame, dtMs) : null

  updatePeaks(shown, dtMs)
  if (shown) {
    drawSpectrum(ctx, w, shown, alpha)
    drawReduction(ctx, w, shown, alpha)
  }
  drawZones(ctx, w)
  drawZoneReadouts(ctx, w)

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
  // ONE LINE, STEPPED PER ZONE. Each zone carries its own Selectivity, so the
  // threshold is a staircase with the same crossfade at each boundary that the
  // kernel applies — this is the kernel's decision boundary drawn where the
  // decision is made.
  //
  // A READOUT, NOT THE EDITOR. It rides `reference[]`, so it moves with the
  // audio several times a second; the editable copy of the same number is a
  // knob under the plot, which does not.
  const spanOct = Math.log2(frame.maxHz / frame.minHz)
  const hzAt = d => frame.minHz * Math.pow(2, (d / (bins - 1)) * spanOct)
  const thresholdAt = d => zoneSettingsAt(props.zones, hzAt(d)).selectivity

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
    if (zonePeaks.value.length) zonePeaks.value = []
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
    // Arithmetic lives in resonanceZoneEdit so it can be tested without a
    // canvas, like every other zone geometry function.
    zonePeaks.value = zonePeakReductions(
      props.zones, reduction, bins, minHz, maxHz, props.soloZone,
    )
  }
  updateCursorText(frame)
}

// ── Sensitivity zones ───────────────────────────────────────────────────────

/**
 * Zones are drawn as full-height dividers, not as a lane of their own.
 *
 * The lane this replaces held an editable value on a fixed scale, which was the
 * right answer to the problem before it — a handle riding the threshold curve
 * bounced with the audio and could not be aimed. But it cost 38 px of a display
 * that is the point of the panel, and it put a zone's settings in two places at
 * once. A multiband compressor solves the same problem with a divider: the zone
 * is a COLUMN of the display, its boundary is a line you drag, and its settings
 * live in one control row that follows the selection.
 *
 * So nothing here is a value editor. The dividers say where the zones are and
 * which one is selected; the knobs under the plot say what it does.
 */

/** How close the pointer must be to a divider to grab it, in pixels. */
const DIVIDER_HIT_PX = 7

/** Live drag, or null. Outside reactivity — it changes on pointer events. */
let drag = null
const dragging = ref(false)
/** Divider under the pointer, for the hover cursor. -1 for none. */
const hoverDivider = ref(-1)

const bounds = computed(() => zoneBounds(props.zones, 20, 20000))

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Dividers and the selected column.
 *
 * Drawn UNDER the curves rather than over them — a divider is a boundary in the
 * control, not a feature of the audio, and a bright line across a spectrum
 * trace reads as a notch in the trace. The selected column is the faintest tint
 * that survives a photograph, for the same reason: it has to say "this one"
 * without competing with the thing being looked at.
 */
function drawZones(ctx, w) {
  if (props.zones.length === 0) return
  const bottom = specTop.value + specH.value

  const paintColumn = (i, fill) => {
    const { loHz, hiHz } = bounds.value[i]
    const x0 = xFromHz(loHz, axis)
    const x1 = xFromHz(hiHz, axis)
    if (x1 <= x0) return
    ctx.fillStyle = fill
    ctx.fillRect(x0, 0, x1 - x0, grH.value)
    ctx.fillRect(x0, specTop.value, x1 - x0, bottom - specTop.value)
  }

  // A zone switched off is washed out across the whole column, which is what
  // the out-of-band wash used to do for the band limits. Same statement, and
  // now there is only one control that can make it.
  const solo = props.soloZone
  props.zones.forEach((zone, i) => {
    const silent = solo >= 0 ? i !== solo : !zoneSettings(zone).enabled
    if (silent) paintColumn(i, 'rgba(6,8,7,.62)')
  })
  if (props.selectedZone >= 0 && props.selectedZone < props.zones.length) {
    paintColumn(props.selectedZone, tint(props.accent, 0.07))
  }

  for (let i = 0; i < props.zones.length - 1; i++) {
    const x = Math.round(xFromHz(props.zones[i].hiHz, axis)) + 0.5
    const live = drag?.divider === i || hoverDivider.value === i
    ctx.fillStyle = live ? tint(props.accent, 0.95) : 'rgba(255,255,255,.34)'
    ctx.fillRect(x, 0, 1, grH.value)
    ctx.fillRect(x, specTop.value, 1, bottom - specTop.value)
    // Grips at both ends. A full-height hairline with nothing on it reads as a
    // grid rule; two 5 px tabs are what say it can be moved.
    ctx.fillStyle = live ? props.accent : 'rgba(255,255,255,.5)'
    ctx.fillRect(x - 1.5, 1, 4, 6)
    ctx.fillRect(x - 1.5, bottom - 7, 4, 6)
  }
}

/**
 * Each zone's deepest cut, printed at the top of its own column.
 *
 * In the REDUCTION lane, where reduction hangs from the top — so the number
 * sits at the origin of the thing it measures rather than floating over the
 * spectrum. Right-aligned to the divider on its right, which is where the eye
 * already is when reading a boundary, and inset so it never touches the line.
 *
 * Drawn only where it fits. A zone dragged narrow has no room for four
 * characters, and a number clipped by a divider or overlapping its neighbour is
 * worse than no number: it can be misread as the adjacent zone's. Below
 * MIN_READOUT_PX the column simply carries no reading, which is legible on its
 * own because the column is visibly too narrow to hold one.
 *
 * A silent zone reads OFF rather than a depth. See zonePeakReductions.
 */
const MIN_READOUT_PX = 30
const READOUT_INSET_PX = 4

function drawZoneReadouts(ctx, w) {
  const peaks = zonePeaks.value
  if (!peaks.length || peaks.length !== props.zones.length) return
  ctx.save()
  ctx.font = "600 8px 'JetBrains Mono',monospace"
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  for (let i = 0; i < props.zones.length; i++) {
    const { loHz, hiHz } = bounds.value[i]
    const x0 = xFromHz(loHz, axis)
    const x1 = Math.min(xFromHz(hiHz, axis), w)
    if (x1 - x0 < MIN_READOUT_PX) continue
    const db = peaks[i]
    const selected = i === props.selectedZone
    let text
    if (db === null) {
      text = 'OFF'
      ctx.fillStyle = 'rgba(255,255,255,.26)'
    } else if (db < 0.3) {
      // Below the threshold the hotspot line uses, so the two readouts agree
      // about when the effect is doing nothing. A dash rather than `-0.0`,
      // which reads as a measurement of zero rather than as idle.
      text = '–'
      ctx.fillStyle = 'rgba(255,255,255,.26)'
    } else {
      text = `-${db.toFixed(1)}`
      // The selected zone's number is the one the knobs below are editing, so
      // it is lit; the rest stay legible without competing with it.
      ctx.fillStyle = selected ? props.accent : 'rgba(255,255,255,.5)'
    }
    ctx.fillText(text, x1 - READOUT_INSET_PX, 3)
  }
  ctx.restore()
}

// ── Zone editing ────────────────────────────────────────────────────────────
//
// Every edit replaces the array; nothing mutates a zone in place. The kernel is
// handed a fresh copy on each change — see copyZones.

function commit(zones) {
  if (zones !== props.zones) emit('update:zones', zones)
}

function select(index) {
  if (index !== props.selectedZone) emit('update:selectedZone', index)
}

let nextZoneId = 1

function onDown(e) {
  if (e.button !== 0) return
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  canvasEl.value?.focus({ preventScroll: true })

  const divider = boundaryAt(props.zones, x, axis, DIVIDER_HIT_PX)
  if (divider >= 0) {
    drag = { divider }
    dragging.value = true
    canvasEl.value?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    return
  }
  // Anywhere else in the plot selects the zone under the pointer. Selection is
  // the ONLY thing a click in the display does now: the values moved to knobs,
  // so there is no gesture here that can change the sound by accident.
  select(zoneIndexAt(props.zones, x, axis, 20, 20000))
}

function onDrag(e, x) {
  if (!drag) return
  commit(moveBoundary(props.zones, drag.divider, hzFromX(x, axis), 20, 20000))
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
  const divider = boundaryAt(props.zones, x, axis, DIVIDER_HIT_PX)
  if (divider >= 0) {
    commit(removeBoundary(props.zones, divider))
    select(Math.min(props.selectedZone, props.zones.length - 2))
  } else {
    const before = props.zones
    const next = splitZone(before, hzFromX(x, axis), axis, `z${Date.now()}${nextZoneId++}`, 20, 20000)
    commit(next)
    if (next !== before) select(zoneIndexAt(next, x, axis, 20, 20000))
  }
  e.preventDefault()
}

/**
 * Keyboard equivalents for the two gestures the plot owns.
 *
 * Not a nicety. The rest of this panel is knobs and switches a keyboard can
 * reach; leaving the zone boundaries reachable by pointer alone would make them
 * the one thing in the plugin some people could not set.
 */
function onKeyDown(e) {
  const n = props.zones.length
  if (n === 0) return
  const i = props.selectedZone
  const shift = e.shiftKey
  switch (e.key) {
    case 'ArrowLeft':
      if (shift) {
        commit(moveBoundary(props.zones, i - 1,
          (props.zones[i - 1]?.hiHz ?? 0) * Math.pow(2, -1 / 12), 20, 20000))
      } else select(Math.max(0, i - 1))
      break
    case 'ArrowRight':
      if (shift) {
        commit(moveBoundary(props.zones, i,
          (props.zones[i]?.hiHz ?? 0) * Math.pow(2, 1 / 12), 20, 20000))
      } else select(Math.min(n - 1, i < 0 ? 0 : i + 1))
      break
    case 'Enter':
      commit(splitZone(props.zones, hzFromX(axis.w * 0.5, axis), axis,
        `z${Date.now()}${nextZoneId++}`, 20, 20000))
      break
    case 'Delete':
    case 'Backspace':
      if (i >= 0) {
        commit(removeBoundary(props.zones, i < n - 1 ? i : i - 1))
        select(Math.min(i, props.zones.length - 2))
      }
      break
    default: return
  }
  e.preventDefault()
}

/**
 * The selected zone, in words, WITH ITS OWN DEEPEST CUT.
 *
 * This line used to fall back to a single global `PEAK <hz> · -<db>` covering
 * the whole spectrum. In practice it almost never appeared — a zone is
 * essentially always selected and `zoneText` wins the slot — so the panel's one
 * numeric reading was both hidden and, when it did show, describing all six
 * zones at once. Scoping it to the selection makes it agree with the knobs
 * underneath, which edit exactly that zone.
 *
 * The depth is dropped while the zone is silent or idle: `Z2 … · OFF · -0.0`
 * says the effect measured nothing there, where the truth is that it never
 * looked.
 */
const zoneText = computed(() => {
  const i = props.selectedZone
  const zone = props.zones[i]
  if (!zone) return ''
  const { loHz, hiHz } = bounds.value[i]
  const span = `Z${i + 1} ${formatHz(loHz)}–${formatHz(hiHz)}`
  if (!zoneSettings(zone).enabled) return `${span} · OFF`
  const db = zonePeaks.value[i]
  return db != null && db > 0.3 ? `${span} · -${db.toFixed(1)} dB` : span
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
  onDrag(e, x, e.clientY - rect.top)
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

/**
 * Where the deepest cut is anywhere, for the case where no zone is selected.
 *
 * Kept rather than deleted because a panel with the selection cleared still has
 * to say something, and "the deepest cut is here" is the one reading that needs
 * no zone to be meaningful. Every other case is served by zoneText.
 */
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
  const zones = props.zones.length
    ? ` ${props.zones.length} sensitivity zones: ` + props.zones.map((z, i) => {
      const { loHz, hiHz } = bounds.value[i]
      const s = zoneSettings(z)
      return s.enabled
        ? `${formatHz(loHz)} to ${formatHz(hiHz)}, selectivity ${s.selectivity.toFixed(1)} `
          + `decibels, depth ${Math.round(s.depth * 100)} percent, `
          + `sharpness ${Math.round(s.sharpness * 100)} percent`
        : `${formatHz(loHz)} to ${formatHz(hiHz)}, off`
    }).join('; ') + '.'
    : ''
  return `${props.title}. ${cut} ${band}${mode}${zones} ${ZONE_HINT}`
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
const ZONE_HINT = 'Drag in the zone lane to set a zone\u2019s sensitivity, or drag a '
  + 'boundary line to move it. Double-click to split a zone, or double-click a '
  + 'boundary to merge. Keyboard: left and right select, up and down set '
  + 'sensitivity, shift with left and right moves the boundary, Enter splits, '
  + 'Delete merges.'

/**
 * What to say when the readout line has nothing else to say.
 *
 * The zones are edited inside a canvas, so nothing else on the panel announces
 * that dragging one does anything. This borrows the idle state of a line that
 * would otherwise be blank, costs no height, and stops as soon as a zone is
 * moved off neutral.
 */
const idleHint = computed(() =>
  props.zones.length > 1 ? '' : 'DBL-CLICK TO SPLIT A ZONE')

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

      </span>

      <!-- Whatever the pointer is over, or where the deepest cut is when it is
           over nothing. Right-aligned into the space left over, so the text
           changing length moves nothing else on the line. -->
      <span
        class="flex-1 text-right truncate"
        style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.06em"
        :style="{ color: cursorText ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.32)' }"
      >{{ zoneText || cursorText || hotspotText || idleHint }}</span>
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
        :title="ZONE_HINT"
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
