<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
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
import { HISTORY_SECONDS, ResonanceHistory } from './resonanceHistory.js'
import { MARK_MIN_DB, findResonanceMarks } from './resonanceMarks.js'
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

/** Strip along the bottom for the frequency numerals. */
const AXIS_H = 13

/**
 * ONE LANE, WITH REDUCTION AS THE HERO. It was two, and the split was backwards.
 *
 * The reduction lane took 36% of the height and the spectrum 64%, on the
 * argument that reduction is one curve against a scale where the spectrum is
 * several against each other. True, and beside the point: the two lanes were
 * drawn on scales four times apart in sensitivity, and the big one could not
 * resolve the effect at all.
 *
 * The spectrum spans 90 dB (-102..-12); reduction spans `fullScaleDb` = 24 on a
 * voltage law. At the old 280 px that is 166 px and 94 px of lane, and per dB of
 * actual cut:
 *
 *     cut          3 dB    9 dB   12 dB     (3 = stock mean on real narration,
 *     reduction   19.9    50.8    62.6       9 = stock p90)
 *     spectrum     5.5    16.6    22.1
 *
 * So the SMALLER lane was 3-4x more legible per dB, and the shaded sliver
 * between input and output — the one thing in the spectrum lane that showed the
 * effect — rendered at about 5 px at the normal operating point, the same order
 * as the stroke widths around it. It said "something happened" and could not be
 * measured. 64% of the display was spent on the file and the decision boundary,
 * which is the EXPLANATION of a cut rather than its RESULT.
 *
 * Merged, reduction gets the full lane on its own scale and lands directly over
 * the peak that caused it instead of in a box above it. The two do not fight for
 * ink as much as it sounds: the spectrum window tops out at -12 dBFS while
 * per-bin speech peaks sit near -35, so the top quarter of the plot is normally
 * empty and that is exactly where reduction hangs. A cut deep enough to reach
 * into the trace is a cut deep enough to be worth seeing there.
 *
 * The output curve and the sliver are gone with the split — see drawSpectrum.
 */
const laneH = computed(() => Math.max(60, props.height - AXIS_H))
/** Vertical clearance between two numerals on the reduction scale. */
const MIN_SCALE_GAP_PX = 11
/** Below this fraction of the scale the peak hold has nothing to say. */
const PEAK_VISIBLE = 0.025
/**
 * Below this many dB the reduction trace is not drawn at all.
 *
 * The same figure the per-zone readouts and the hotspot line use, so the trace,
 * the number over the column and the text line all start saying something on the
 * same frame.
 */
const REDUCTION_VISIBLE_DB = 0.3

/**
 * The three overlays, and why they are not parameters.
 *
 * The default view (design 1c) is removal only: nothing on the plot but what is
 * being taken out. These fold context back in, and each is independent rather
 * than the design's single DETAIL button, because they answer different
 * questions and a user who wants the grid rarely wants a waterfall behind it.
 *
 * KEPT OUT OF `params`, like DELTA and SOLO. `applyResonanceRegion` spreads the
 * param object straight into the kernel, so anything living there is one
 * careless key away from being rendered into the timeline. These are purely
 * about what is drawn — the kernel neither sends nor receives them — so the
 * safest place for them is component state that has no route to the worklet at
 * all.
 *
 * PERSISTED, unlike DELTA and SOLO, and the difference is intent. A monitoring
 * mode is something you switch on to check one thing and switch off again, so
 * carrying it across sessions would be a trap. A preference for seeing the grid
 * is a preference; making someone re-set it every time they open the panel is
 * the trap.
 */
const OVERLAY_STORE_KEY = 'wavely.resotame.overlays'

function loadOverlays() {
  // Wrapped because a browser set to block site data throws on the accessor
  // itself rather than returning null, and a panel that will not open because
  // a preference could not be read is a worse failure than a lost preference.
  try {
    const raw = window.localStorage.getItem(OVERLAY_STORE_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const stored = loadOverlays()
const showGrid = ref(stored.grid === true)
const showHistory = ref(stored.history === true)
const showSpectro = ref(stored.spectro === true)

function toggleOverlay(which) {
  const ref_ = which === 'grid' ? showGrid : which === 'history' ? showHistory : showSpectro
  ref_.value = !ref_.value
  try {
    window.localStorage.setItem(OVERLAY_STORE_KEY, JSON.stringify({
      grid: showGrid.value, history: showHistory.value, spectro: showSpectro.value,
    }))
  } catch {
    // A viewer who cannot store the preference still gets it for this session.
  }
}

/**
 * The rolling waterfalls. Built lazily on the first frame that carries a bin
 * count, and recorded continuously whether or not an overlay is showing — see
 * resonanceHistory for why.
 */
let history = null

onBeforeUnmount(() => { history = null })

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
/** The header count and average. Text, so it reads on the readout cadence. */
const summaryThrottle = createReadoutThrottle()
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

/**
 * The named resonances, and why they are recomputed on their own clock.
 *
 * A mark is a pill sitting on the plot with a frequency and a depth in it, so
 * it has to hold still long enough to be read. Recomputing it every frame makes
 * the set flicker between neighbouring peaks of nearly equal depth and the
 * pills jump; the source design settles them roughly four times a second and
 * that is slow enough to read and fast enough to follow a phrase.
 */
const MARK_INTERVAL_MS = 280
/**
 * Hysteresis on a mark already placed.
 *
 * A resonance hovering at the threshold would otherwise have its pill picked up
 * and dropped every quarter second. Once named, a mark survives down to half
 * the floor before it goes.
 */
const MARK_KEEP_FRACTION = 0.5
let markAcc = MARK_INTERVAL_MS
let marks = []

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
 * Smoothed copies of the continuous curves that are DRAWN, and the frame view
 * drawn from them.
 *
 * `output` is not among them any more. The kernel still posts it and the merged
 * display no longer draws it, so smoothing it here was a per-bin pass every
 * frame feeding nothing.
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
const SMOOTHED = ['mag', 'reference', 'reduction']
let smoothArrays = null
let smoothView = null

function smoothFrame(frame, dtMs) {
  const { bins } = frame
  if (!smoothArrays || smoothArrays.mag.length !== bins) {
    smoothArrays = {
      mag: new Float32Array(bins),
      reference: new Float32Array(bins),
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

  // Averaged before anything reads it, so the trace, the peak hold's live floor
  // and the hotspot readout all describe the same curve. The held curve inside
  // it is still the kernel's raw maximum — see smoothFrame.
  const shown = frame ? smoothFrame(frame, dtMs) : null

  // Recorded before anything is drawn and whether or not an overlay is showing:
  // an overlay switched on to a blank plot cannot answer the question it was
  // switched on for. Fed the RAW frame rather than the smoothed one — the
  // smoothing exists to steady a curve being watched, and a waterfall row is a
  // record of an instant.
  if (frame) {
    if (!history) history = new ResonanceHistory(frame.bins, props.accent)
    else history.reshape(frame.bins, props.accent)
    history.advance(dtMs, frame)
  }

  // ORDER IS THE DESIGN. Everything before the reduction curve is ground for it;
  // nothing after it is allowed to cover it except the zone furniture, which is
  // the control surface rather than a reading.
  drawWaterfalls(ctx, w)
  if (showGrid.value) drawGrid(ctx, w, xFor, minHz, maxHz)
  drawZeroRail(ctx, w)

  updatePeaks(shown, dtMs)
  if (shown) drawReduction(ctx, w, shown, alpha)

  drawZones(ctx, w)
  drawZoneReadouts(ctx, w)
  drawMarks(ctx, w, alpha)

  if (showGrid.value) drawGrScale(ctx, w)
  drawAxis(ctx, w, xFor, minHz, maxHz)
  drawCursor(ctx, w)
}

/**
 * The two waterfall overlays, behind everything.
 *
 * Stretched over the whole plot, which means their vertical axis is TIME while
 * the curve above them is measured in decibels of reduction. That is the source
 * design's arrangement and it is deliberate: these are texture, not a second
 * reading, and the dark scrim over them is what says so. It is also why the
 * input spectrum CURVE and the threshold staircase have no home in this layout
 * — a level axis and a time axis cannot share one box, and 1c chose time.
 *
 * Both at once is allowed and legible, because they are different pictures: the
 * carve is mostly dark with white cut marks, the spectrogram is mostly lit.
 */
function drawWaterfalls(ctx, w) {
  if (!history || (!showHistory.value && !showSpectro.value)) return
  const h = laneH.value
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  if (showSpectro.value) {
    ctx.globalAlpha = showHistory.value ? 0.28 : 0.46
    ctx.drawImage(history.spectro, 0, 0, w, h)
  }
  if (showHistory.value) {
    ctx.globalAlpha = showSpectro.value ? 0.5 : 0.62
    ctx.drawImage(history.carve, 0, 0, w, h)
  }
  ctx.globalAlpha = 1
  // The scrim is what makes an underlay an underlay. Without it the waterfall
  // is as loud as the curve and the plot has two heroes.
  ctx.fillStyle = 'rgba(8,10,13,.42)'
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

/**
 * The 0 dB rail the reduction curve hangs from.
 *
 * Always drawn, grid or no grid. With the grid off it is the only horizontal
 * reference on the plot, and a curve hanging from nothing reads as a curve
 * floating; with the grid on it is the top line of the scale, brighter than the
 * rest because zero is where the effect is doing nothing and every trough is
 * measured from it.
 */
function drawZeroRail(ctx, w) {
  ctx.fillStyle = 'rgba(255,255,255,.16)'
  ctx.fillRect(0, 0.5, w, 1)
}

/** The recessed plate the whole plot sits in. */
function drawPlates(ctx, w) {
  ctx.fillStyle = 'rgba(0,0,0,.42)'
  ctx.fillRect(0, 0, w, laneH.value)
}

/**
 * Frequency rules up, reduction rules across.
 *
 * Only drawn when the GRID overlay is on. In the default view the plot carries
 * the 0 dB rail and nothing else, which is what "removal only" means — the
 * numbers are on the marks and in the header, not ruled across the plot.
 */
function drawGrid(ctx, w, xFor, minHz, maxHz) {
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  for (const hz of GRID_HZ) {
    if (hz < minHz || hz > maxHz) continue
    const x = Math.round(xFor(hz)) + 0.5
    if (x >= w) continue
    ctx.fillRect(x, 0, 1, laneH.value)
  }
  // Horizontals come from the same marks the numerals use, so a rule and its
  // number can never disagree about where a decibel is.
  for (const mark of grScaleMarks(props.fullScaleDb)) {
    if (mark.db === 0) continue
    const y = Math.round(mark.fraction * laneH.value) + 0.5
    if (y >= laneH.value - 2) continue
    ctx.fillRect(0, y, w, 1)
  }
}

/**
 * Reduction, hanging from the top of the plot. THE HERO CURVE.
 *
 * Downward because that is the direction of the thing: a cut. The filled area
 * is this frame; the outline behind it is the peak hold, which is what turns an
 * intermittent ring into something you can point at — a resonance that only
 * sounds on certain words is a flicker in the live fill and a standing shape in
 * the hold.
 *
 * FULL LANE HEIGHT, ON ITS OWN SCALE. It shares the plot with the spectrum but
 * not the spectrum's axis: this is `fullScaleDb` of reduction on a voltage law,
 * where the trace underneath is 90 dB of level. Two scales in one box is what
 * every plugin in this class does, and it works because the two are drawn as
 * opposites — reduction filled downward from the top in the accent, spectrum
 * filled upward from the bottom in grey. The numerals down the right belong to
 * this one; the spectrum carries none, so there is nothing to confuse them with.
 *
 * THE FILL IS LIGHTER THAN IT WAS BECAUSE IT NOW COVERS GROUND THAT HAS SOMETHING
 * UNDER IT. In its own lane it could be near-opaque; over the spectrum the same
 * ink hides the peak that explains the cut. The 1.5 px stroke is what carries
 * the reading, and the fill only says which side of it was removed.
 */
function drawReduction(ctx, w, frame, alpha) {
  const { reduction, bins } = frame
  const h = laneH.value
  const xStep = w / (bins - 1)
  const yFor = db => grFraction(db, props.fullScaleDb) * h

  ctx.globalAlpha = alpha
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()

  ctx.beginPath()
  ctx.moveTo(0, 0)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(reduction[d]))
  ctx.lineTo(w, 0)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  // DELTA is expressed here now the sliver is gone, and this is its natural
  // home rather than a substitute for one: in DELTA the removed signal is what
  // is being heard, so the curve bounding it is the thing to light up.
  const topAlpha = props.delta ? 0.58 : 0.40
  grad.addColorStop(0, tint(props.accent, topAlpha))
  grad.addColorStop(1, tint(props.accent, 0.05))
  ctx.fillStyle = grad
  ctx.fill()

  // DRAWN ONLY WHERE THERE IS A CUT, for the reason the peak hold already is.
  // In its own lane a continuous stroke along the top read as that lane's zero
  // datum; across the full plot it reads as a frame edge, or worse as activity —
  // a bright accent line spanning the width of a display where the effect is
  // doing nothing. Breaking it at the same 0.3 dB the per-zone readouts use
  // means the trace and the numbers appear together.
  // Each segment opens on the bin BEFORE it crosses the threshold and closes on
  // the one after, so a feature is drawn with its shoulders and comes back to
  // the datum at both ends. Starting at the first bin over the threshold instead
  // was tried: on a resonance a few bins wide the curve is already several dB
  // down by then, so the trace began mid-descent and drew a stub rather than a
  // trough.
  ctx.beginPath()
  let live = false
  for (let d = 0; d < bins; d++) {
    const over = reduction[d] >= REDUCTION_VISIBLE_DB
    if (!over && !live) continue
    if (!live) {
      const from = d > 0 ? d - 1 : d
      ctx.moveTo(from * xStep, yFor(reduction[from]))
      live = true
    }
    ctx.lineTo(d * xStep, yFor(reduction[d]))
    if (!over) live = false
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
      const y = peakBins[d] * h
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
 * The named resonances: a dot on the trace, and a pill under it.
 *
 * This is the one thing the per-zone readouts cannot say. A zone number tells
 * you which BAND is being worked; a mark tells you which FREQUENCY, which is
 * what someone reaches for the EQ with. The two coexist rather than replacing
 * each other — the numbers stay tied to the columns the knobs edit, and the
 * pills float wherever the peaks actually are.
 *
 * ALTERNATING VERTICAL OFFSET, because pills are wider than the resonances they
 * name. Two peaks a third of an octave apart put their labels on top of one
 * another at any real plot width; dropping every other pill by its own height
 * turns a collision into a stagger. The marks arrive in frequency order so that
 * alternation is left-to-right rather than arbitrary.
 *
 * Clamped away from both edges so a pill near 20 Hz or 20 kHz is not half cut
 * off by the plate — the dot stays at the true frequency, only the label moves,
 * because the dot is the measurement and the label is the annotation.
 */
const PILL_W = 96
const PILL_H = 20

function drawMarks(ctx, w, alpha) {
  if (!marks.length) return
  const h = laneH.value
  const yFor = db => grFraction(db, props.fullScaleDb) * h

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.textBaseline = 'middle'
  marks.forEach((m, i) => {
    const x = (m.pos) * w
    const yDot = yFor(m.db)
    // Below the dot normally; above it when the trough is deep enough that a
    // pill underneath would run off the bottom of the plot.
    const below = yDot + PILL_H + 16 < h
    const yPill = below ? yDot + 10 + (i % 2 ? PILL_H + 4 : 0)
      : yDot - PILL_H - 10 - (i % 2 ? PILL_H + 4 : 0)
    const cx = Math.max(PILL_W / 2 + 2, Math.min(w - PILL_W / 2 - 2, x))

    ctx.fillStyle = props.accent
    ctx.beginPath()
    ctx.arc(x, yDot, 3, 0, Math.PI * 2)
    ctx.fill()

    // A leader only when the label had to move sideways to fit, so the common
    // case carries no extra ink.
    if (Math.abs(cx - x) > 1) {
      ctx.strokeStyle = tint(props.accent, 0.35)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, yDot)
      ctx.lineTo(cx, yPill + PILL_H / 2)
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(8,10,13,.82)'
    ctx.beginPath()
    roundRect(ctx, cx - PILL_W / 2, yPill, PILL_W, PILL_H, 5)
    ctx.fill()
    ctx.strokeStyle = tint(props.accent, 0.4)
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.font = "600 10px 'JetBrains Mono',monospace"
    ctx.textAlign = 'left'
    ctx.fillStyle = `color-mix(in srgb, ${props.accent} 60%, #ffffff)`
    ctx.fillText(formatHz(m.hz), cx - PILL_W / 2 + 8, yPill + PILL_H / 2 + 0.5)
    ctx.textAlign = 'right'
    ctx.font = "500 10px 'JetBrains Mono',monospace"
    ctx.fillStyle = 'rgba(255,255,255,.55)'
    ctx.fillText(`-${m.db.toFixed(1)}`, cx + PILL_W / 2 - 8, yPill + PILL_H / 2 + 0.5)
  })
  ctx.restore()
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * ⚠ THE INPUT SPECTRUM CURVE AND THE THRESHOLD STAIRCASE ARE GONE, and this is
 * the real cost of the 1c layout rather than a simplification.
 *
 * 1c is "removal only": the plot's vertical axis is decibels of REDUCTION, and
 * the overlays that fold context back in are waterfalls whose vertical axis is
 * TIME. Neither is a level axis, so there is nowhere in this layout for a curve
 * measured in dBFS to be drawn — not behind the trace, not with an overlay on.
 * It is not a matter of ink.
 *
 * What that costs: the threshold staircase was the only place per-zone
 * Selectivity was legible WHILE the knob was being turned — the kernel's own
 * decision boundary, drawn where the decision is made. Under 1c, Selectivity is
 * judged by the cut it produces instead: the trace, the per-zone deepest-cut
 * numbers and the marks. That is a slower loop for setting a threshold, and it
 * is the deliberate trade the layout makes.
 *
 * If it turns out to matter, the way back is a fourth overlay carrying its own
 * level-axis lane rather than a curve squeezed into this one.
 */

/**
 * Numerals down the right, and the rules that carry them across.
 *
 * Thinned by pixel spacing, not by dB. The scale is a voltage law, so the top
 * of it is crowded — on a 56 px lane the bar's own -1, -3 and -5 land within
 * 15 px of each other and print as one smear. Keeping whichever marks survive
 * a minimum gap means the plot can be any height and the engraving still reads.
 *
 * FULL-WIDTH RULES, KEPT DELIBERATELY NOW THAT THEY CROSS THE SPECTRUM. They are
 * the reason the merged plot is worth having: judging the depth of a cut at
 * 3 kHz against numerals 500 px away on the right edge is not reading a
 * measurement, it is estimating one. Faint enough to sit under the trace — the
 * same weight as the frequency grid they cross.
 */
function drawGrScale(ctx, w) {
  ctx.font = "600 7.5px 'JetBrains Mono',monospace"
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  let lastY = -Infinity
  for (const mark of grScaleMarks(props.fullScaleDb)) {
    if (!mark.label || mark.db === 0) continue
    const y = mark.fraction * laneH.value
    if (y < MIN_SCALE_GAP_PX / 2 || y > laneH.value - 3 || y - lastY < MIN_SCALE_GAP_PX) continue
    lastY = y
    ctx.fillStyle = 'rgba(255,255,255,.05)'
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
  ctx.fillRect(x, 0, 1, laneH.value)
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
    if (marks.length) marks = []
    if (markSummary.value.count) markSummary.value = { count: 0, avgDb: 0 }
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

  // WHICH resonances are named is decided four times a second, so the pills hold
  // still long enough to read. HOW DEEP each one is, is re-read every frame from
  // the same curve everything else on the plot is drawn from.
  //
  // Both halves are needed. Recomputing the set every frame makes the pills
  // flicker between neighbouring peaks of nearly equal depth; leaving the depth
  // frozen for a quarter second makes the pill disagree with the trough directly
  // under it and with the per-zone number above it — reported as exactly that,
  // a pill reading -6.1 in a zone whose own readout said -5.6.
  markAcc += dtMs
  if (markAcc >= MARK_INTERVAL_MS) {
    markAcc = 0
    marks = findResonanceMarks(reduction, bins, minHz, maxHz)
  }
  if (marks.length) {
    const floor = MARK_MIN_DB * MARK_KEEP_FRACTION
    marks = marks.filter(m => {
      m.db = reduction[m.bin]
      return m.db >= floor
    })
  }

  let sum = 0
  for (let d = 0; d < bins; d++) sum += reduction[d]
  if (summaryThrottle.due(dtMs)) {
    markSummary.value = { count: marks.length, avgDb: sum / bins }
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
  const bottom = laneH.value

  const paintColumn = (i, fill) => {
    const { loHz, hiHz } = bounds.value[i]
    const x0 = xFromHz(loHz, axis)
    const x1 = xFromHz(hiHz, axis)
    if (x1 <= x0) return
    ctx.fillStyle = fill
    ctx.fillRect(x0, 0, x1 - x0, bottom)
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
    ctx.fillRect(x, 0, 1, bottom)
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
    let colour
    if (db === null) {
      text = 'OFF'
      colour = 'rgba(255,255,255,.3)'
    } else if (db < 0.3) {
      // Below the threshold the hotspot line uses, so the two readouts agree
      // about when the effect is doing nothing. A dash rather than `-0.0`,
      // which reads as a measurement of zero rather than as idle.
      text = '–'
      colour = 'rgba(255,255,255,.3)'
    } else {
      text = `-${db.toFixed(1)}`
      // The selected zone's number is the one the knobs below are editing, so
      // it is lit; the rest stay legible without competing with it.
      colour = selected ? props.accent : 'rgba(255,255,255,.62)'
    }

    // BACKED, BECAUSE THE MERGE PUT THESE ON TOP OF THE REDUCTION FILL. In two
    // lanes this row sat on bare plate; now the deepest cut in a zone is drawn
    // in the accent directly beneath its own number, also in the accent. The
    // plate colour behind each reading is what keeps it a number rather than a
    // slightly different shade of the fill.
    const right = x1 - READOUT_INSET_PX
    const tw = ctx.measureText(text).width
    ctx.fillStyle = 'rgba(8,10,9,.78)'
    ctx.fillRect(right - tw - 3, 1, tw + 6, 12)
    ctx.fillStyle = colour
    ctx.fillText(text, right, 3)
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
/**
 * The header's right-hand summary, refreshed on the marks' own clock.
 *
 * A count that flickers between three and four several times a second is worse
 * than no count, so it is republished only when the mark set is, and the
 * average comes from the same frame the marks were found in.
 */
const markSummary = ref({ count: 0, avgDb: 0 })

/** 1c's right-hand line: how many resonances are being worked, and how hard. */
const headerSummary = computed(() => {
  const { count, avgDb } = markSummary.value
  if (!count) return 'NO RESONANCES TRACKED'
  return `${count} RESONANCE${count === 1 ? '' : 'S'} TRACKED  ·  AVG -${avgDb.toFixed(2)} dB`
})

const overlayButtons = computed(() => [
  { key: 'grid', label: 'GRID', on: showGrid.value, title: 'Frequency and reduction rules' },
  {
    key: 'history',
    label: 'HISTORY',
    on: showHistory.value,
    title: `What has been carved over the last ${HISTORY_SECONDS} seconds`,
  },
  {
    key: 'spectro',
    label: 'SPECTRO',
    on: showSpectro.value,
    title: `Input spectrum over the last ${HISTORY_SECONDS} seconds`,
  },
])

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
    <!-- 1c's header: what was taken out, at the size of the thing the panel is
         for, with the overlay switches beside it.

         The old line led with a running reduction figure and an average, in
         12 px, sharing a row with a three-item curve legend. Under "removal
         only" the deepest cut IS the reading — there is no longer a second
         curve for it to be one of — so it gets the size, and the legend goes:
         two of the three curves it named no longer exist. -->
    <div class="flex items-end justify-between gap-[14px] mb-[7px]">
      <span class="flex items-end gap-[10px] shrink-0">
        <span class="flex flex-col">
          <span style="font:500 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.35)">
            DEEPEST CUT
          </span>
          <span class="flex items-baseline gap-[4px]">
            <span :style="{
                    font: `500 30px 'Inter',system-ui`,
                    lineHeight: '1',
                    color: `color-mix(in srgb, ${accent} 45%, #ffffff)`,
                    textShadow: `0 0 12px color-mix(in srgb, ${accent} 45%, transparent)`,
                  }">-{{ readingDb.toFixed(1) }}</span>
            <span style="font:500 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,.35)">dB</span>
          </span>
        </span>
        <!-- Second statement of a mode the title bar already shows, and worth
             the duplication: someone reading the plot to decide whether a cut is
             landing where they want has their eyes here, not on the title bar,
             and the trace being loud is otherwise unexplained. -->
        <span
          v-show="delta"
          class="px-[5px] py-[1px] rounded mb-[3px]"
          :style="{
            font: `700 8px 'JetBrains Mono',monospace`,
            letterSpacing: '.12em',
            color: `color-mix(in srgb, ${accent} 55%, #ffffff)`,
            background: `color-mix(in srgb, ${accent} 22%, transparent)`,
          }"
        >DELTA</span>
      </span>

      <span class="flex flex-col items-end gap-[5px] min-w-0">
        <span
          class="truncate"
          style="font:500 9px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)"
        >{{ headerSummary }}</span>

        <!-- The three overlays. Independent rather than the source design's one
             DETAIL button: they answer different questions, and someone who
             wants a grid rarely wants a waterfall behind it. Lit when on, in the
             accent, so the row reads at a glance as "what is folded in". -->
        <span class="flex items-center gap-[4px]">
          <button
            v-for="o in overlayButtons"
            :key="o.key"
            type="button"
            class="px-[7px] py-[3px] rounded-full transition-colors"
            :aria-pressed="String(o.on)"
            :title="o.title"
            :style="{
              font: `600 8px 'JetBrains Mono',monospace`,
              letterSpacing: '.1em',
              color: o.on ? `color-mix(in srgb, ${accent} 45%, #ffffff)` : 'rgba(255,255,255,.36)',
              background: o.on ? `color-mix(in srgb, ${accent} 20%, transparent)` : 'rgba(255,255,255,.05)',
              boxShadow: o.on ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 45%, transparent)` : 'inset 0 0 0 1px rgba(255,255,255,.06)',
            }"
            @click="toggleOverlay(o.key)"
          >{{ o.label }}</button>
        </span>
      </span>
    </div>

    <!-- Whatever the pointer is over, or the selected zone when it is over
         nothing. Its own line under the header row, right-aligned, so the text
         changing length moves nothing else. -->
    <div
      class="text-right truncate mb-1.5"
      style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.06em"
      :style="{ color: cursorText ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.32)' }"
    >{{ zoneText || cursorText || hotspotText || idleHint }}</div>

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
