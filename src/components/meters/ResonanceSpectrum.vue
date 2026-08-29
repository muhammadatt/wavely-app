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
  zoneDotAt,
  zoneDotX,
  ZONE_DOT_R,
} from './resonanceZoneEdit.js'
import { ResonanceHistory } from './resonanceHistory.js'
import { bright, tint } from '../../ui/accent.js'
import { MARK_MIN_DB, findExceedanceRuns, findResonanceMarks } from './resonanceMarks.js'
import {
  NODE_R,
  addNode,
  biasCurvePoints,
  canAddFocusNode,
  focusScope,
  makeFocusNode,
  moveNode,
  nodeAt,
  nodePoint,
  removeNode,
  scaleNodeSpan,
  setNodeParam,
  toggleNode,
} from './resonanceFocusNodes.js'
import { RESONANCE_FOCUS_RANGES } from '../../audio/resonanceFocus.js'
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
 * ONE lane over a log-frequency axis, showing REMOVAL ONLY: reduction hanging
 * from the zero rail on the same voltage-law scale the other panels' GR meters
 * use — so a depth here reads the same as a depth there — with a decaying
 * peak-hold outline behind it, which is what makes an intermittent resonance
 * findable at all, and the deepest resonances named by frequency.
 *
 * Three overlays fold context back in, none of them on by default: GRID (the
 * rules), HISTORY (the last few seconds of carve as a waterfall) and SPECTRUM
 * (the input curve and the detection threshold this frame was decided from).
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
   * Zone whose removal is being auditioned alone, or -1.
   *
   * Drawn, because it changes what is being heard and a display that did not
   * show it would disagree with the speakers — the same reason the DELTA badge
   * is repeated on this line. It arrives separately from `zones` rather than
   * baked into them so the knobs keep reading the stored settings.
   */
  deltaZone: { type: Number, default: -1 },
  /**
   * The detection threshold OFFSET at one frequency, in dB, or null.
   *
   * ⚠ IT EXISTS BECAUSE THE THRESHOLD HAS TWO POSSIBLE AUTHORS NOW. This plot
   * adds the offset to the kernel's reference itself, so the dotted threshold
   * line tracks the knob on the frame it is turned rather than a frame later —
   * and it used to read that offset out of `props.zones`. Under the focus
   * targeting model the zones are empty, so `zoneSettingsAt` returned the stock
   * constant and the threshold FROZE: the dotted line stopped following the
   * Threshold knob, and — the same `threshold[]` array feeding the exceedance
   * runs and the FOUND trace — crossings were reported against a threshold of
   * 20 whatever the panel was set to, so the display kept finding resonances
   * with the knob wound fully off.
   *
   * Null keeps the zone lookup, so the shipping path is untouched by
   * construction. See resonanceFocus.js's focusThresholdFn for why a function
   * rather than a curve: it is called per display bin per frame, and the
   * caller hoists its own normalisation out of that loop.
   */
  selectivityFn: { type: Function, default: null },
  /**
   * Focus nodes, edited on this plot, or null under the zone model.
   *
   * ⚠ NULL RATHER THAN AN EMPTY ARRAY, because the two mean different things
   * here: null is "this panel is not running the focus model", where `[]` is
   * "it is, and nothing has been placed yet" — a state with its own drawing and
   * its own gestures. Distinguishing them is what keeps the zone path free of
   * every focus branch below.
   *
   * They live here rather than on a strip of their own because the thing they
   * bias — the detection threshold — is already read against this spectrum, and
   * a targeting control beside the picture it aims at is a second instrument to
   * cross-reference. See resonanceFocusNodes.js for why the curve nonetheless
   * cannot ride the threshold line itself.
   */
  focusNodes: { type: Array, default: null },
  /** Which focus node the panel is editing, or -1. */
  selectedFocusNode: { type: Number, default: -1 },
  height: { type: Number, default: 188 },
  /**
   * Accessible name for the plot. Not drawn — a canvas is opaque to a screen
   * reader, and this is the only thing that tells one what the element is.
   */
  title: { type: String, default: 'Spectral reduction' },
  /**
   * Which overlays are folded in — `{ grid, history, spectrum }`.
   *
   * A prop rather than state here because the switches are in the panel
   * header, beside the readouts they belong with. Absent, everything is off,
   * which is the default view. See `ui/resonanceOverlays.js`.
   */
  overlays: { type: Object, default: () => ({}) },
})

/**
 * The two figures the header prints, published on their own throttles.
 *
 * ⚠ THEY ARE MEASURED HERE AND DRAWN ELSEWHERE, and that split is deliberate
 * rather than awkward. Both come out of the frame loop below — the deepest cut
 * off the same ballistics the trace is drawn with, the count and average out of
 * the very frame the marks were found in — so computing them anywhere else
 * would mean a second reader of the kernel's port, describing a different
 * instant from the picture beside it. What moved up is the markup, not the
 * measurement.
 *
 * Emitted rather than exposed so the panel can hold them like any other value.
 * At ~10 Hz apiece, and only when a figure actually changes.
 */
const emit = defineEmits([
  'update:zones', 'update:selectedZone', 'update:reading',
  'update:focusNodes', 'update:selectedFocusNode',
])

/** Running the focus targeting model rather than zones. */
const focusMode = computed(() => props.focusNodes !== null)

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
 * The SPECTRUM overlay's inks, and the rule behind them.
 *
 * ⚠ WHITE IS THE FILE; THE ACCENT IS THE EFFECT. That is the split, and it is
 * what decides the crossings' colour rather than "the two displays no longer
 * overlap". The input curve and its fill are the material — what was recorded —
 * and they stay in the neutral the whole overlay was drawn in. A crossing is not
 * material: it is the detector saying THIS one, which is the effect acting, and
 * it was the only effect-side thing on the plate drawn in the file's colour.
 *
 * That rule also settles the question the overlap raised. The crossing and the
 * reduction trace share a hue because they are ONE EVENT AT TWO STAGES — what
 * was found, and what was done about it — and with the two bands unable to
 * collide, sharing it now buys the reading it was always meant to: a mint shape
 * at 3 kHz in the lower band under a mint cut at 3 kHz in the upper one is
 * plainly the same resonance. That is the frequency alignment which IS a valid
 * comparison between them; their magnitudes are not, since one is margin and the
 * other reduction.
 *
 * ⚠ THEY MUST STILL BE TOLD APART, AND THE GLOW IS WHAT DOES IT. The trace is a
 * soft gradient under a lit outline over a glow — this file's rule is that the
 * glow belongs to the thing actually emitting, which is the cut. The crossing is
 * FLAT: a harder fill, a sharp edge, no glow. Same hue, different material.
 *
 * ⚠ THE FOUND-HISTORY STRIP GOES WITH IT. It is the same measurement at a
 * different age — the decayed hold of these very crossings — so leaving it white
 * while the live one turned mint would have said they were different quantities.
 *
 * ⚠ THE THRESHOLD DASH IS LEFT WHITE AND IT IS ARGUABLY WRONG. `reference +
 * Selectivity` is the effect's own decision boundary, so by the rule above it
 * belongs in the accent. It is kept neutral because it is read AGAINST the input
 * curve — the two are compared to each other constantly — and putting the pair
 * in two different colour families makes that comparison harder, not easier. The
 * rule is a good one; this is the edge it does not cleanly cover.
 *
 * Alphas rather than colour strings, because the accent arrives as a prop and
 * `tint` has to be applied where it is known.
 */
const SPEC_FILL = 'rgba(255,255,255,.085)'
const SPEC_STROKE = 'rgba(255,255,255,.40)'
const SPEC_THRESHOLD = 'rgba(255,255,255,.52)'
/**
 * The crossing, in the accent.
 *
 * Higher than the fill it replaced (.50 white) because a saturated hue at the
 * same alpha reads dimmer than neutral over a near-black plate — mint carries
 * about three quarters of white's luminance — so holding the step over the
 * ground costs a little alpha back.
 */
const SPEC_CROSS_FILL_A = 0.62
const SPEC_CROSS_EDGE_PX = 2
/** The strip: the same crossings, decayed. Quieter, because it is the past. */
const SPEC_HISTORY_FILL_A = 0.34
const SPEC_HISTORY_EDGE_A = 0.62

/**
 * The SPECTRUM overlay's band and the dBFS window drawn into it.
 *
 * ⚠ IT USED TO SPAN THE WHOLE LANE, WHICH PUT IT UNDER THE TRACE EVERYWHERE
 * THAT MATTERED. Reported from use: the identified resonances cannot be read
 * against the spectrum while the reduction trace is over it, and better shading
 * did not fix it. It could not — the collision is structural, not a matter of
 * ink. On the old -102..-12 window over the full lane, input at -25 dBFS drew at
 * y=39 px, -35 at y=68 and -45 at y=98, all of it inside the trace's top half.
 * The peaks, the threshold and every crossing were in the one region the trace
 * occupies; only content below about -55 dBFS, which is the part nobody is
 * looking at, ever cleared it.
 *
 * The overlay now starts where the reduction lane ends, so the two CANNOT
 * overlap — one constant governs the split and the spectrum's top is derived
 * from it rather than stated separately.
 *
 * ⚠ THE WINDOW HAD TO NARROW WITH IT, and that is the price. Half the height at
 * the old 90 dB window would be 1.48 px/dB, halving the crossing shading this
 * display was rebuilt around. -85..-15 is 70 dB in the same space: 1.91 px/dB,
 * a 36% loss rather than 50%. What is given up at each end is content nobody
 * reads — below -85 is under the per-bin noise floor of any narration (the
 * waterfall's own ramp is calibrated at -95..-25 against a floor near -85), and
 * above -15 is above anything a per-bin level reaches on speech, where the
 * threshold at stock Selectivity sits nearer -20. Both ends clamp rather than
 * clip, so a curve that runs out of window flattens along the edge instead of
 * disappearing.
 *
 * ⚠ Lowering REDUCTION_LANE_FRAC buys this resolution back directly — the two
 * readings share one axis and every pixel one gives up the other takes.
 */
const SPEC_DB_MIN = -85
const SPEC_DB_MAX = -15

/**
 * How solid the reduction trace's fill is, at the rail and at the foot.
 *
 * ⚠ THESE CAME DOWN — 0.34/0.03 — BECAUSE THE FILL IS WHAT MAKES LOW
 * FREQUENCIES DOMINATE, AND IT DOES SO ASYMMETRICALLY. Reported from use: low
 * resonances take over the display. They do, and the cause is mostly not the dB
 * scale, it is WIDTH on a log axis. A resonance of fixed bandwidth in Hz paints
 * far more of the plot down low — at 192 cells over 9.64 octaves, a 30 Hz-wide
 * mode at 120 Hz covers 7.2 cells where a 150 Hz-wide feature at 6 kHz covers
 * 0.7. Ten to one, before depth is considered at all.
 *
 * That is what makes moving weight from the fill to the outline the right lever
 * rather than a cosmetic one: A NARROW FEATURE IS MOSTLY PERIMETER AND A WIDE
 * ONE IS MOSTLY INTERIOR. Measured on this geometry, the LF example above has
 * 653 px² of interior against 187 px² of outline — 3.5:1 — while the 6 kHz
 * feature has 12 px² against 35 px², or 0.34:1. Ink taken out of the interior
 * costs the wide shape about ten times what it costs the narrow one, so the two
 * come closer together WITHOUT touching the geometry: every cut is still drawn
 * at exactly the height its decibels earn, and the trace still agrees with
 * DEEPEST CUT, the per-zone figures and the GR scale.
 *
 * The two rejected alternatives both fixed the smaller half of the problem by
 * lying about the larger. A frequency TILT would draw 6 dB at 5 kHz taller than
 * 6 dB at 100 Hz, contradicting every numeral on the panel, and unlike the
 * Spectrum Analyzer's tilt there is no expected slope for reduction to be
 * flattened against. AUTO-SCALING to the loudest resonance would turn "the
 * resonance got quieter" into "everything moved" — this file's own argument for
 * a fixed window — and would leave the picture unchanged when Depth is turned
 * down, which is the tuning loop this display exists to serve.
 *
 * DELTA keeps a heavier fill because there the removed signal is the thing being
 * heard, so the region bounding it is the subject rather than an annotation.
 */
const REDUCTION_FILL_ALPHA = 0.14
const REDUCTION_FILL_ALPHA_DELTA = 0.3
/** At the foot of the lane. Near zero either way; it keeps the gradient a gradient. */
const REDUCTION_FILL_ALPHA_FOOT = 0.015

/**
 * How much of the lane the reduction reading spans.
 *
 * ⚠ THE LAW IS UNCHANGED — this scales the drawing, not the scale. Reduction is
 * still `grFraction`, the same voltage law every gain-reduction meter in the app
 * uses, so the trace has exactly the shape it had; it is drawn into a shorter
 * box. That distinction is what makes this safe to turn: raising `fullScaleDb`
 * instead would have been a different curve (and barely helped — 24 to 36 dB
 * takes a 3 dB cut from 57 px to 48, because this law's compression is almost
 * all in its numerator), and lowering GR_CURVE would have moved every other
 * meter in the app.
 *
 * IT IS ALSO THE SPLIT. The SPECTRUM overlay starts where this ends and derives
 * its band from this constant, so the two readings tile by construction and
 * cannot collide — which is what finally made the identified resonances legible
 * against the spectrum, after shading them in the accent and then in white had
 * both failed. Every pixel this gives up the spectrum takes: at 0.35 the
 * spectrum has 174 px for its 70 dB window, or 2.48 px per dB.
 *
 * It is FIXED rather than following which overlays are on: a reading that
 * changes scale because an unrelated switch was thrown is one nobody can trust
 * twice.
 *
 * Everything measured in reduction goes through `reductionH` — the trace, its
 * peak hold, the marks, the rules and the numerals, and the hit test behind the
 * marks. ⚠ THE HIT TEST ESPECIALLY: it is the one that fails silently, as dots
 * that cannot be clicked where they are drawn.
 */
const REDUCTION_LANE_FRAC = 0.35
const reductionH = computed(() => laneH.value * REDUCTION_LANE_FRAC)

/**
 * THE FOUND-HISTORY STRIP, along the floor of the SPECTRUM overlay.
 *
 * The decaying hold — what has crossed the line in the last couple of seconds —
 * used to be shaded in place, hanging off the threshold like the live crossing
 * does. Reported from use: useful, but distracting and unclear, because it was
 * ATTACHED TO A MOVING BASELINE. The threshold rides `reference[]` at ~46 Hz, so
 * a held shape drawn from it is a still quantity on a bouncing datum — the eye
 * reads the movement, which belongs to the reference, as movement of the
 * history, which has none.
 *
 * On the floor it has a baseline that cannot move. It stops being part of the
 * spectrum's shape and becomes what it always was: a strip saying where the
 * detector has recently found something.
 *
 * ⚠ THE LIVE CROSSING STAYS ON THE THRESHOLD, and that split is the point. The
 * live shading answers "is this peak over the line RIGHT NOW", which is only
 * meaningful drawn against the line; the strip answers "has anything been over
 * it lately", which is meaningful anywhere and better somewhere still.
 *
 * 36 px is cheap: it covers -102 to -90 dBFS of the overlay's window, which is
 * below the noise floor of any recording this tool is pointed at. Clamped at the
 * same 8 dB the margin lane clamps at, so the two agree about what a big
 * crossing looks like.
 */
/**
 * The FOUND strip's own band, at the bottom of the lane.
 *
 * ⚠ IT IS A RESERVED BAND NOW, NOT 36 PX SITTING INSIDE THE SPECTRUM'S. Reported
 * from use: the strip and the shaded crossings wash each other out where they
 * overlap. They did, and hue could not fix it — they are deliberately the same
 * colour, being one quantity at two ages — while dimming one only made the
 * weaker of the two harder to read.
 *
 * ⚠ AND MOVING IT ELSEWHERE IN THE BAND WOULD NOT HAVE WORKED EITHER, which is
 * what makes the reservation necessary rather than lazy. A crossing follows the
 * spectrum's own contour: it spans from the threshold up to a peak, so a LOUD
 * crossing sits high in the band and a QUIET one sits near the floor. Against a
 * -85..-15 window, low-frequency peaks near -30 dBFS put their crossings in the
 * top third while high-frequency peaks near -70 put theirs in the bottom fifth.
 * A strip at the floor collides with the HF crossings; a strip under the
 * reduction lane would collide with the LF ones. There is no free row.
 *
 * A FRACTION rather than pixels, which also fixes something already on record:
 * the plot is resizable, and the strip was the one element that did not grow
 * with it.
 */
const FOUND_BAND_FRAC = 0.13
const foundBandH = computed(() => laneH.value * FOUND_BAND_FRAC)

/**
 * The deepest crossing the FOUND strip can draw.
 *
 * ⚠ THIS IS ALL THAT SURVIVES OF THE MARGIN LANE, which was a full band plotting
 * `input - threshold` against a flat rail and is now deleted. The strip carries
 * the same quantity — margin, in dB, referenced to nothing but the threshold —
 * so it keeps the property the lane was built for and the absolute SPECTRUM
 * cannot have: a crossing draws at its true depth wherever it happens, because
 * the level it happens at has left the picture. A 3 dB margin at 12 kHz on a bin
 * sitting at -95 dBFS is a 3 dB shape here, where on the absolute window both
 * curves clamp to the floor and it disappears.
 *
 * What the lane had and the strip does not is the below-threshold half — how
 * close something is to crossing — and a per-bin curve rather than a
 * silhouette. Neither survived contact with use: the lane read as a derived
 * quantity and had to be understood before it said anything, where a shaded peak
 * on the spectrum does not.
 *
 * Crossings past 8 dB clamp, with the ceiling drawn, so a strip pinned flat
 * reads as out of room rather than as a measurement. 8 dB because that is where
 * a crossing stops being a resonance worth ranking and becomes simply a large
 * one; the trace above states what was done about it.
 */
const HELD_STRIP_MAX_DB = 8

/**
 * The three overlays.
 *
 * THE FLAGS COME IN AS A PROP AND THE BUTTONS ARE SOMEWHERE ELSE. They were
 * owned here, next to the drawing code that reads them, which was right while
 * the switches were here too; the readouts and the switches have since moved up
 * into the panel header, and a control in one component writing state in
 * another is the arrangement this codebase keeps having to undo. What decides
 * where they live is the storage key, and that is in `ui/resonanceOverlays.js`
 * now — including why they are not parameters, which is the important half.
 */
const showGrid = computed(() => props.overlays?.grid === true)
const showHistory = computed(() => props.overlays?.history === true)
const showSpectrum = computed(() => props.overlays?.spectrum === true)
/**
 * The FOUND strip — recent crossings, decaying, along the floor.
 *
 * Its own switch rather than part of SPECTRUM because it answers a different
 * question and is readable without it: SPECTRUM says which peak is over the
 * line right now and where it sits in the file, FOUND says what has been over
 * the line lately, at true depth, regardless of level.
 */
const showFound = computed(() => props.overlays?.found === true)
/**
 * The reduction reading — the trace, its peak hold, the rail it hangs from, the
 * marks that sit on it and the numerals that measure it.
 *
 * ⚠ THE ONE OVERLAY THAT DEFAULTS ON, because it is not really an overlay: it is
 * the plot, and the other four are context folded in around it. It is a switch
 * at all for one reason, reported from use — placing zone boundaries means
 * reading the SPECTRUM, and a green fill twenty times the size of anything under
 * it is painted straight over that. Being able to put the hero down for a moment
 * is what makes the other overlays usable.
 */
const showRemoved = computed(() => props.overlays?.removed !== false)

/**
 * The rolling carve history. Built lazily on the first frame that carries a bin
 * count, and recorded continuously whether or not the overlay is showing — see
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
/**
 * THE PLATE, THE RING AND THE RADIUS COME FROM THE DESIGN SYSTEM, and they were
 * the part of the brief the display had not taken.
 *
 * `--bg-canvas-flat` for the recess, `--color-border-1` for the hairline around
 * it, `--radius-lg` for the corner. Every canvas in the brief is drawn as a
 * recessed plate with a rounded clip and a single hairline ring — the system's
 * own rule that "inset hairlines do the structural work; drop shadows are
 * reserved for things that genuinely float" — and this plot was a square box
 * filled with flat black instead, which is the one thing on the faceplate that
 * did not look machined.
 */
const PLATE_INK = '#080a0d'
const PLATE_RING = 'rgba(255,255,255,.06)'
const PLATE_RADIUS = 12
/** The brief's veil over anything the effect is not touching. `--bg-scrim`. */
const VEIL = 'rgba(5,7,9,.66)'
/** Pill backing, from the brief's mark labels. */
const PILL_INK = 'rgba(10,14,16,.8)'

/**
 * The pale end of the accent — the brief's MINT_HI, #cdf4dc, against its
 * MINT #8de0a8.
 *
 * Derived from the accent rather than pasted in so the panel's prop still
 * governs the whole plot: at the accent this panel is given the two agree to
 * within a couple of levels per channel. It carries every stroke and numeral
 * that is meant to read as lit — the hero curve's outline, the header figure,
 * the frequency on a mark pill — where the accent itself carries fills.
 */
// bright() and tint() live in ui/accent.js — the header row derives the same
// two colours from the same accent, and this component used to be the only
// copy of them.

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

/**
 * THE PLOT NO LONGER DIMS WHEN THE TRANSPORT STOPS.
 *
 * It used to fade to 0.3 once no new frame had arrived for 300 ms, on the
 * argument that a frozen last frame is still true about the moment playback
 * stopped and dimming reads as "not moving" where blanking reads as broken.
 * That is right about the fading and wrong about what the plot is FOR: with the
 * resonance marks now revealed by clicking one, a stopped transport is exactly
 * when someone reads the display — playback stops, and then you go and find out
 * what that ring at 3 kHz was. A picture you have to squint at, whose marks are
 * dimmed to a third while you aim at them, is at its faintest precisely when it
 * is being studied.
 *
 * What says the transport is stopped is the transport. The curves hold their
 * last frame, which is the reading being examined.
 */

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
 * 103 ms = the analyzer at 85% averaging, which is what this was asked for:
 * tau = 16.7 ms / -ln(0.85). It was 75, i.e. 80%; unaveraged, the trace steps
 * at the post rate and reads about like 50%.
 */
const DISPLAY_TAU_MS = 103

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
const SMOOTHED = ['mag', 'reference', 'detect', 'reduction']
let smoothArrays = null
let smoothView = null

function smoothFrame(frame, dtMs) {
  const { bins } = frame
  if (!smoothArrays || smoothArrays[SMOOTHED[0]].length !== bins) {
    // ⚠ ALLOCATED FROM `SMOOTHED`, NOT FROM A SECOND LIST BESIDE IT. This was
    // an object literal naming the curves again, and adding `detect` to SMOOTHED
    // without adding it here threw on the first frame — `undefined.set(...)`,
    // every frame, for every user of the panel. Two hand-maintained copies of
    // one list is the whole defect; deriving one from the other removes it by
    // construction rather than by remembering.
    smoothArrays = {}
    for (const key of SMOOTHED) smoothArrays[key] = new Float32Array(bins)
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
  publishReading()
})

/**
 * Hand the header its two figures, when either has moved.
 *
 * After `draw`, because that is what republishes the mark summary — before it,
 * the count beside the plot would be one frame behind the marks on it. Guarded
 * on the values rather than on the throttles because the throttles fire on
 * their own clock whether or not anything changed, and a panel-level ref
 * assigned 10 times a second with the same number is 10 needless renders.
 */
let lastReading = null

function publishReading() {
  const { count, avgDb } = markSummary.value
  const deepestDb = readingDb.value
  if (lastReading
    && lastReading.deepestDb === deepestDb
    && lastReading.count === count
    && lastReading.avgDb === avgDb) return
  lastReading = { deepestDb, count, avgDb }
  emit('update:reading', lastReading)
}

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
    if (!history) history = new ResonanceHistory(frame.bins)
    else history.reshape(frame.bins)
    history.advance(dtMs, frame)
  }

  // ORDER IS THE DESIGN. Everything before the reduction curve is ground for it;
  // nothing after it is allowed to cover it except the zone furniture, which is
  // the control surface rather than a reading.
  drawCarveHistory(ctx, w)
  if (showGrid.value) drawGrid(ctx, w, xFor, minHz, maxHz)
  // SPECTRUM first, FOUND over it: with both on they share the floor, and the
  // strip is a finding where the curve down there is context.
  if (shown && (showSpectrum.value || showFound.value)) updateDetection(shown, dtMs)
  if (showSpectrum.value && shown) drawSpectrum(ctx, w, shown)
  // After SPECTRUM, so the strip sits over the input curve where the two meet
  // near the floor — the strip is a finding and the curve there is context.
  if (showFound.value && shown) drawFoundHistory(ctx, w, shown)

  // ⚠ THE PEAK HOLD ADVANCES WHETHER OR NOT THE TRACE IS SHOWING, for the reason
  // the waterfall records itself continuously: a reading switched back on to a
  // cold hold cannot answer the question it was switched on for.
  updatePeaks(shown, dtMs)
  if (showRemoved.value) {
    drawZeroRail(ctx, w)
    if (shown) drawReduction(ctx, w, shown)
  }

  drawZones(ctx, w)
  drawZoneReadouts(ctx, w)
  // ⚠ AFTER THE ZONE FURNITURE AND BEFORE THE MARKS. The focus curve is the
  // control surface under this model — the same rank the zone dividers hold
  // under the other — so it goes where they go. The marks stay on top of it
  // because a named resonance is what a node is usually aimed AT, and a curve
  // covering the thing it is pointed at would be exactly backwards.
  if (focusMode.value) drawFocus(ctx, w)
  // The marks sit ON the trace — their vertical position IS the reduction — so
  // with it hidden they would be dots in empty space rather than annotations.
  if (showRemoved.value) drawMarks(ctx, w)

  if (showGrid.value && showRemoved.value) drawGrScale(ctx, w)
  drawCursor(ctx, w)
  drawPlateRing(ctx, w)
  drawAxis(ctx, w, xFor, minHz, maxHz)
}

/**
 * The carve waterfall, behind everything.
 *
 * Stretched over the whole plot, which means its vertical axis is TIME while the
 * curve above it is measured in decibels of reduction. That is deliberate: this
 * is texture, not a second reading, and the dark scrim over it is what says so.
 * It also means it does not compete with the SPECTRUM overlay's level axis —
 * one is a picture of the last few seconds, the other of this instant, and with
 * both on the scrim keeps the waterfall the ground of the two.
 */
function drawCarveHistory(ctx, w) {
  if (!history || !showHistory.value) return
  const h = laneH.value
  ctx.save()
  clipPlate(ctx, w)
  ctx.imageSmoothingEnabled = true
  // The brief's own underlay weights: half opacity under a 42% scrim. It was
  // 0.62 with the same scrim, tuned against a ramp that held the plate colour
  // far longer; the heat ramp reaches mint sooner and by design goes brighter
  // than mint at the top, so it needs the brief's number rather than the old
  // one to stay ground.
  ctx.globalAlpha = 0.5
  ctx.drawImage(history.carve, 0, 0, w, h)
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
  ctx.save()
  clipPlate(ctx, w)
  ctx.fillStyle = 'rgba(255,255,255,.16)'
  ctx.fillRect(0, 0.5, w, 1)
  ctx.restore()
}

/** The recessed plate the whole plot sits in. */
function drawPlates(ctx, w) {
  ctx.beginPath()
  roundRect(ctx, 0, 0, w, laneH.value, PLATE_RADIUS)
  ctx.fillStyle = PLATE_INK
  ctx.fill()
}

/**
 * The plate's clip, shared by everything drawn inside it.
 *
 * Every layer has to use the same rounded path or the corner is squared off by
 * whichever one clips to a rectangle — the waterfall does it with an image, the
 * zone columns with a fillRect, and either is enough to make the ring look like
 * it is drawn over the artwork rather than around it.
 */
function clipPlate(ctx, w) {
  ctx.beginPath()
  roundRect(ctx, 0, 0, w, laneH.value, PLATE_RADIUS)
  ctx.clip()
}

/**
 * The hairline around the plate, drawn last so nothing paints over it.
 *
 * One rule at `--color-border-1`, inset half a pixel so it lands on the pixel
 * grid rather than straddling it. This is the whole of the plate's elevation:
 * the design system reserves drop shadows for things that float, and a recess
 * does not.
 */
function drawPlateRing(ctx, w) {
  ctx.beginPath()
  roundRect(ctx, 0.5, 0.5, w - 1, laneH.value - 1, PLATE_RADIUS - 0.5)
  ctx.strokeStyle = PLATE_RING
  ctx.lineWidth = 1
  ctx.stroke()
}

/**
 * Frequency rules up, reduction rules across.
 *
 * Only drawn when the GRID overlay is on. In the default view the plot carries
 * the 0 dB rail and nothing else, which is what "removal only" means — the
 * numbers are on the marks and in the header, not ruled across the plot.
 */
function drawGrid(ctx, w, xFor, minHz, maxHz) {
  ctx.save()
  clipPlate(ctx, w)
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
    const y = Math.round(mark.fraction * reductionH.value) + 0.5
    if (y >= reductionH.value - 2) continue
    ctx.fillRect(0, y, w, 1)
  }
  ctx.restore()
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
function drawReduction(ctx, w, frame) {
  const { reduction, bins } = frame
  const h = reductionH.value
  const xStep = w / (bins - 1)
  const yFor = db => grFraction(db, props.fullScaleDb) * h

  ctx.save()
  clipPlate(ctx, w)

  ctx.beginPath()
  ctx.moveTo(0, 0)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(reduction[d]))
  ctx.lineTo(w, 0)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  // DELTA is expressed here now the sliver is gone, and this is its natural
  // home rather than a substitute for one: in DELTA the removed signal is what
  // is being heard, so the curve bounding it is the thing to light up.
  const topAlpha = props.delta ? REDUCTION_FILL_ALPHA_DELTA : REDUCTION_FILL_ALPHA
  grad.addColorStop(0, tint(props.accent, topAlpha))
  grad.addColorStop(1, tint(props.accent, REDUCTION_FILL_ALPHA_FOOT))
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
  // THE BRIEF'S OUTLINE: 1.6 px in the pale tint, over a glow of the accent.
  // The glow is what makes a one-pixel line read as lit rather than as drawn,
  // and it is the only place on the plate that carries one — the design system
  // spends its accent glow on the things that are actually emitting (`--glow-
  // accent-sm` on meter segments and knob arcs), which here is the cut.
  ctx.lineWidth = 1.6
  ctx.strokeStyle = bright(props.accent)
  ctx.shadowColor = tint(props.accent, 0.8)
  ctx.shadowBlur = 10
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'

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
    // The pale end of the ramp rather than white, so the hold reads as the
    // trace's own shadow rather than as a second, colder measurement.
    ctx.strokeStyle = 'rgba(205,244,220,.32)'
    ctx.stroke()
  }

  ctx.restore()
}

/**
 * The named resonances: a dot on the trace, and a pill on the one you click.
 *
 * This is the one thing the per-zone readouts cannot say. A zone number tells
 * you which BAND is being worked; a mark tells you which FREQUENCY, which is
 * what someone reaches for the EQ with. The two coexist rather than replacing
 * each other — the numbers stay tied to the columns the knobs edit, and the
 * dots float wherever the peaks actually are.
 *
 * ⚠ THE PILLS USED TO BE DRAWN FOR EVERY MARK, ALL THE TIME, AND THAT WAS TOO
 * MUCH IN MOTION. Up to four labels, each re-placed four times a second as the
 * mark set is republished, each carrying a depth that changes every frame,
 * sitting on top of the one curve the panel exists to show. Reported as
 * distracting, and the mechanism is that a label is a fixed-size object on a
 * plot whose features are not: four of them cover a real fraction of the plate
 * whatever the audio is doing, so the display was at its busiest exactly when
 * the effect was working hardest.
 *
 * THE DOTS STAY. They are 3.4 px and they sit on the trace rather than over it,
 * they are what says a peak has been identified as a resonance rather than as
 * ripple, and they are the target you aim at — a reveal whose trigger is
 * invisible is not discoverable at all. What is deferred is the ANNOTATION.
 *
 * SELECTION IS BY FREQUENCY, NOT BY INDEX, and that is what makes it survive
 * the mark set being recomputed 4x a second: the same ring is the same
 * resonance whether it comes back as marks[0] or marks[2]. It is matched to the
 * nearest mark within a sixth of an octave, which is wide enough to hold a peak
 * that wanders with the voice and narrow enough that two named resonances
 * cannot be confused for one another (findResonanceMarks already keeps them
 * further apart than that).
 *
 * A SELECTION WHOSE RESONANCE HAS GONE QUIET IS KEPT, NOT DROPPED. An
 * intermittent ring is the whole reason the peak hold exists, and dropping the
 * label the moment its resonance falls under the threshold would mean the one
 * kind of resonance that is hardest to catch is also the one whose name will
 * not stay on screen. The pill simply disappears with the mark and comes back
 * with it.
 *
 * Clamped away from both edges so a pill near 20 Hz or 20 kHz is not half cut
 * off by the plate — the dot stays at the true frequency, only the label moves,
 * because the dot is the measurement and the label is the annotation.
 */
const PILL_W = 98
const PILL_H = 22

/** How close a click has to land to a dot to name it, in pixels. */
const MARK_HIT_PX = 12

/**
 * The named resonance, held as a frequency. Display state, like the overlays.
 *
 * NOT persisted, and the difference from the overlay toggles is the same one
 * that separates them from DELTA and SOLO: a preference for seeing the grid is
 * a preference, but "I am looking at this particular ring" is about one moment
 * in one file, and restoring it into a different file next session would put a
 * label on a resonance nobody asked about.
 */
const selectedMarkHz = ref(null)
/** True while the pointer is over a dot, for the cursor. */
const hoverMark = ref(false)

/** Within this many octaves, a mark and a remembered frequency are the same. */
const MARK_MATCH_OCTAVES = 1 / 6

function markIndexNear(hz) {
  if (hz === null) return -1
  let best = -1
  let bestOct = MARK_MATCH_OCTAVES
  marks.forEach((m, i) => {
    const oct = Math.abs(Math.log2(m.hz / hz))
    if (oct < bestOct) {
      bestOct = oct
      best = i
    }
  })
  return best
}

/**
 * The mark under a point, or -1.
 *
 * Measured to the DOT rather than to the column, because the dot is what is
 * drawn and a hit target that is not the thing you can see is a hit target
 * nobody can aim at. Circular: the dots sit on a curve, so a wide-and-short
 * target would claim clicks from the plate above a shallow cut.
 */
function markAt(x, y) {
  const h = reductionH.value
  const w = width.value
  let best = -1
  let bestD = MARK_HIT_PX * MARK_HIT_PX
  marks.forEach((m, i) => {
    const dx = m.pos * w - x
    const dy = grFraction(m.db, props.fullScaleDb) * h - y
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

function drawMarks(ctx, w) {
  if (!marks.length) return
  const h = reductionH.value
  const yFor = db => grFraction(db, props.fullScaleDb) * h
  const named = markIndexNear(selectedMarkHz.value)

  ctx.save()
  ctx.textBaseline = 'middle'

  // Dots first, all of them, so the named one is not drawn under a neighbour's
  // pill.
  marks.forEach((m, i) => {
    const x = m.pos * w
    const yDot = yFor(m.db)
    ctx.fillStyle = tint(props.accent, i === named ? 1 : 0.9)
    ctx.beginPath()
    ctx.arc(x, yDot, 3.4, 0, Math.PI * 2)
    ctx.fill()
    // A halo on the named one, so the pill has something to belong to and the
    // dot stays findable while the label is read.
    if (i === named) {
      ctx.strokeStyle = tint(props.accent, 0.45)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, yDot, 7, 0, Math.PI * 2)
      ctx.stroke()
    }
  })

  if (named >= 0) {
    const m = marks[named]
    const x = m.pos * w
    const yDot = yFor(m.db)
    // Below the dot normally; above it when the trough is deep enough that a
    // pill underneath would run off the bottom of the plot. The alternating
    // row offset is gone with the other pills — there is only one now, so it
    // has nothing to collide with.
    const below = yDot + PILL_H + 16 < h
    const yPill = below ? yDot + 10 : yDot - PILL_H - 10
    const cx = Math.max(PILL_W / 2 + 2, Math.min(w - PILL_W / 2 - 2, x))

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

    ctx.fillStyle = PILL_INK
    ctx.beginPath()
    roundRect(ctx, cx - PILL_W / 2, yPill, PILL_W, PILL_H, 6)
    ctx.fill()
    ctx.strokeStyle = tint(props.accent, 0.4)
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.font = "600 11px 'JetBrains Mono',monospace"
    ctx.textAlign = 'left'
    ctx.fillStyle = bright(props.accent)
    ctx.fillText(formatHz(m.hz), cx - PILL_W / 2 + 8, yPill + PILL_H / 2 + 0.5)
    ctx.textAlign = 'right'
    ctx.font = "500 10px 'JetBrains Mono',monospace"
    ctx.fillStyle = 'rgba(255,255,255,.5)'
    ctx.fillText(`-${m.db.toFixed(1)}`, cx + PILL_W / 2 - 8, yPill + PILL_H / 2 + 0.5)
  }

  ctx.restore()
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
 * THE SPECTRUM OVERLAY: the input in absolute dBFS, with the threshold staircase
 * across it.
 *
 * ⚠ IT WAS REPLACED BY THE MARGIN LANE AND THEN BROUGHT BACK, and the reason is
 * the one job the margin cannot do. Margin says how far each bin is from the
 * line; it says nothing about the SHAPE of the file, because subtracting the
 * reference is precisely what removes it. But zone boundaries are placed against
 * that shape — where the fundamental region ends, where sibilance starts, where
 * this particular voice's energy actually sits — and that is a reading of the
 * spectrum, not of the margin.
 *
 * So the spectrum earns its own switch, and the crossings are shaded onto it
 * rather than being given a lane of their own — see the note in the drawing
 * below. What did get a switch is FOUND, the decayed strip along the floor,
 * because "which peak is over the line now" and "what has been over it lately"
 * are different questions and either is readable without the other.
 *
 * The threshold is `reference + Selectivity`, added here rather than in the
 * kernel so the staircase moves with the knob on the frame it is turned instead
 * of on the next one out of the worklet. It is a READOUT, NOT AN EDITOR: it
 * rides `reference[]` at ~46 Hz, and a handle on a curve that bounces cannot be
 * aimed — the editable copy of the same number is a knob under the plot.
 */
function drawSpectrum(ctx, w, frame) {
  // `threshold` is not read off the frame: it is the shared per-frame array
  // updateDetection builds, so the staircase here and the strip's own depths
  // cannot disagree about where the line is.
  const { mag, detect, bins } = frame
  // The middle of three tiled bands: the reduction lane above, the FOUND strip
  // below, and this filling exactly what is left. Both edges are DERIVED from
  // the two fractions rather than stated here — a constant of its own would let
  // them drift back into overlapping from an edit that looks unrelated.
  const bottom = laneH.value - foundBandH.value
  const band = bottom - laneH.value * REDUCTION_LANE_FRAC
  const xStep = w / (bins - 1)
  const yFor = (db) => {
    const t = (db - SPEC_DB_MIN) / (SPEC_DB_MAX - SPEC_DB_MIN)
    return bottom - Math.max(0, Math.min(1, t)) * band
  }

  ctx.save()
  clipPlate(ctx, w)

  // The band's ceiling. It marks where one scale stops and the next starts — without it the input curve
  // running along the top of its window reads as a measurement against the
  // reduction numerals down the right rather than as a curve out of headroom.
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  ctx.fillRect(0, bottom - band, w, 1)

  // Input: filled, low contrast. It is the ground the threshold is read against,
  // not a curve to be followed.
  ctx.beginPath()
  ctx.moveTo(0, bottom)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(mag[d]))
  ctx.lineTo(w, bottom)
  ctx.closePath()
  ctx.fillStyle = SPEC_FILL
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = SPEC_STROKE
  ctx.stroke()

  // THE CROSSINGS, SHADED — the part of the input that is over the line.
  //
  // ⚠ THIS IS WHAT MAKES THE OVERLAY READABLE ON ITS OWN, and it was removed
  // once for a reason that no longer holds. It kept being masked by the
  // reduction trace painted over it, and the answer at the time was to replace
  // the whole overlay with a margin lane — `input - threshold` against a flat
  // rail, in a band the trace could not reach. That lane is deleted: it was a
  // derived quantity and read as one, needing to be understood before it said
  // anything, where a shaded peak needs no explanation. It is the peak, and the
  // part of it over the line is filled in. The two real fixes were separating
  // the bands so the trace cannot paint over this, and making REMOVED a switch.
  //
  // The decayed copy of these crossings is the FOUND strip along the floor, at
  // true depth on its own scale — which is the one thing the margin lane had
  // that an absolute window cannot do.
  // ⚠ RUNS FOUND ON `detect`, DRAWN AGAINST `crossTop`, AND THE TWO ARE
  // DELIBERATELY DIFFERENT CURVES. The kernel decides on the max-filtered
  // magnitude, so that is what says WHERE it is acting — finding runs on the raw
  // curve reported no crossing on bins being cut several dB, which is the bug
  // this pair fixes. But drawing the fill up to `detect` would paint a plateau
  // standing above the visible peak, since a max filter is flat across its
  // window: the shape would not belong to any curve on screen. So the fill hugs
  // the input where it is over the line and closes to zero thickness where it is
  // not, which `crossTop` is: `max(mag, threshold)`, clamped so the polygon can
  // never invert into a bowtie inside a run.
  for (let d = 0; d < bins; d++) {
    crossTop[d] = mag[d] > threshold[d] ? mag[d] : threshold[d]
  }
  // THE FILL SPANS THE DETECTOR'S REACH; THE EDGE FOLLOWS THE VISIBLE PEAK.
  //
  // ⚠ ONE CALL DID BOTH AND IT PAINTED A BRIGHT LINE ALONG THE THRESHOLD.
  // Reported from use as the Selectivity line lighting up green whenever a
  // resonance came near it, and that is exactly what it was: `detect` is a max
  // filter, so its run extends about `spacing` bins past where the visible curve
  // crosses. Through those flanks `crossTop` clamps to the threshold, the fill
  // has no height — and the stroke, drawn along the run's whole length, landed
  // as a 2 px lit line sitting on the decision boundary. A crossing drawn where
  // the curve is visibly below the line is the one thing this shading must not
  // say.
  //
  // Splitting the two calls fixes it without giving the reach back: the filled
  // region still covers everything the kernel is acting on (invisible where it
  // has no height, which is correct — nothing of the peak is above the line
  // there), and the lit edge is found on `mag`, so it exists only along the part
  // of the curve a reader can see is over the threshold.
  //
  // ⚠ FOUND REMAINS THE AUTHORITATIVE ONE. Below about 1 kHz a display cell is
  // narrower than an FFT bin and `mag` is INTERPOLATED rather than maxed, so a
  // low-frequency crossing can be real, present in the strip, and still have no
  // edge here. The strip reads `detect` and never interpolates it.
  fillRuns(ctx, findExceedanceRuns(detect, threshold, bins), crossTop, xStep, yFor,
    { fill: tint(props.accent, SPEC_CROSS_FILL_A) })
  fillRuns(ctx, findExceedanceRuns(mag, threshold, bins), mag, xStep, yFor,
    { stroke: bright(props.accent), width: SPEC_CROSS_EDGE_PX })

  // Threshold: dashed, because it is a decision boundary rather than a signal.
  // Drawn last so it stays crisp along the bottom of every shaded region — the
  // fills would otherwise soften the one edge the reader measures against.
  //
  // ONE LINE, STEPPED PER ZONE. Each zone carries its own Selectivity, so the
  // threshold is a staircase — with the same crossfade at each boundary that the
  // kernel applies, since it is read through the same zone lookup. This is the
  // one place those steps are visible — measured against the threshold rather
  // than in absolute level, every zone's line would be the same line.
  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const y = yFor(threshold[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.setLineDash([3, 3])
  ctx.lineWidth = 1
  ctx.strokeStyle = SPEC_THRESHOLD
  ctx.stroke()
  ctx.setLineDash([])

  ctx.restore()
}

/**
 * The decaying hold, as a silhouette standing on the floor of its own band.
 * See FOUND_BAND_FRAC for why it has one.
 *
 * Drawn after the input's own fill, which is painted up from the same floor and
 * would otherwise bury it, and before the live shading, which is the thing that
 * should win where the two coincide.
 *
 * ⚠ NOT ON THE REDUCTION SCALE, and it must not be put on it. This is margin —
 * how far over the line the input got — where the trace above is reduction, how
 * much was taken out. They are cause and effect, related by the kernel's depth,
 * knee and ceiling rather than equal, so a shared axis would invite reading a
 * difference between them that is mostly the transfer between the two
 * quantities. Aligning them in FREQUENCY is the comparison that means something:
 * the detector has been finding something here, is the trace doing anything
 * about it.
 */
function drawFoundHistory(ctx, w, frame) {
  const { bins } = frame
  const bottom = laneH.value
  const xStep = w / (bins - 1)
  const top = bottom - foundBandH.value
  const pxPerDb = foundBandH.value / HELD_STRIP_MAX_DB
  const yFor = db => bottom - Math.max(0, Math.min(HELD_STRIP_MAX_DB, db)) * pxPerDb

  // Its own save and clip: it is called from `draw` now rather than from inside
  // drawSpectrum, so it cannot inherit that one's.
  ctx.save()
  clipPlate(ctx, w)

  ctx.beginPath()
  ctx.moveTo(0, bottom)
  for (let d = 0; d < bins; d++) ctx.lineTo(d * xStep, yFor(excessHold[d]))
  ctx.lineTo(w, bottom)
  ctx.closePath()
  ctx.fillStyle = tint(props.accent, SPEC_HISTORY_FILL_A)
  ctx.fill()

  // The silhouette's own outline, so a low, broad stretch of history still reads
  // as a shape rather than as a change in the plate's tone.
  ctx.beginPath()
  for (let d = 0; d < bins; d++) {
    const y = yFor(excessHold[d])
    d === 0 ? ctx.moveTo(0, y) : ctx.lineTo(d * xStep, y)
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = tint(props.accent, SPEC_HISTORY_EDGE_A)
  ctx.stroke()

  // The clamp, which is also the band's ceiling — one line doing both jobs,
  // because the strip fills its band exactly. Without it a strip pinned flat
  // reads as a measurement rather than as a value that has run out of room.
  ctx.fillStyle = 'rgba(255,255,255,.05)'
  ctx.fillRect(0, top, w, 1)

  ctx.restore()
}

/**
 * Shade the runs of `top` that are over the threshold curve, in absolute space.
 *
 * The stroke is the INPUT SIDE ONLY. Closing it around the region draws a
 * capsule, which reads as an object in its own right rather than as the stretch
 * of input curve that happens to be over the line — and the threshold side
 * already has the dashed rail coming over the top of it.
 */
function fillRuns(ctx, runs, top, xStep, yFor, { fill, stroke, width }) {
  // `fill` and `stroke` are deliberately separate calls at the one site that
  // wants both — see the note there. Passing both here is still supported and
  // still draws the same path twice; it is just not what the crossings use.
  for (const run of runs) {
    // Out along the top, closing at the two interpolated crossings — where the
    // curves meet, so the shape tapers to a point rather than opening with a
    // vertical step taller than the feature itself.
    ctx.beginPath()
    ctx.moveTo(run.startPos * xStep, yFor(run.startDb))
    for (let d = run.startBin; d <= run.endBin; d++) ctx.lineTo(d * xStep, yFor(top[d]))
    ctx.lineTo(run.endPos * xStep, yFor(run.endDb))

    if (stroke) {
      ctx.lineWidth = width
      ctx.strokeStyle = stroke
      ctx.stroke()
    }
    if (fill) {
      // Back along the threshold to close the region.
      for (let d = run.endBin; d >= run.startBin; d--) ctx.lineTo(d * xStep, yFor(threshold[d]))
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
    }
  }
}


/**
 * How long a crossing stays visible after it stops, and how fast it goes.
 *
 * ⚠ THE HOLD IS THE POINT, NOT A REFINEMENT. Reported from use: the display
 * moves too fast to read a resonance off. It does — the curves are averaged at
 * a 103 ms time constant, which is right for a curve being watched and far too
 * quick for a feature a few pixels tall that has to be FOUND first. A crossing
 * that lasts two frames is drawn and gone before the eye arrives.
 *
 * The plateau is the one every other peak marker in the app holds for. The fall
 * is the trace's own 0.32-of-full-scale per second read onto this quantity: the
 * excess that matters here spans roughly a dozen dB, so the same proportion is
 * about 4 dB a second. A crossing is therefore legible for something over two
 * seconds — long enough to look at, short enough that the shape still belongs
 * to the passage being played.
 *
 * PER BIN, and that is not a detail. One shared timer is broken by construction
 * on a 192-point curve: it resets whenever ANY bin rises, something always is,
 * and the hold never reaches its decay phase — the same failure this file
 * already records for the reduction trace's peak hold.
 */
const EXCESS_FALL_DB_PER_SEC = 4

let excessHold = null
let excessAges = null
/** The detection threshold, `reference + Selectivity`, per bin. */
let threshold = null
/** The live margin, `detect - threshold`, per bin. */
let margin = null
/** `max(mag, threshold)` — the top edge the crossing fill is drawn against. */
let crossTop = null

/**
 * The threshold, the margin and the hold — computed once per frame, for both
 * overlays that need them.
 *
 * ⚠ IT WAS INSIDE THE OLD MARGIN LANE, WHICH MADE THE HOLD A PROPERTY OF THE
 * WRONG OVERLAY — with that lane off, SPECTRUM's shading never decayed and the
 * strip never filled. Two overlays reading one measurement is exactly the
 * arrangement that has to be hoisted, and it still is: SPECTRUM and FOUND both
 * need this and either can be on alone.
 *
 * Skipped entirely when neither is showing. The waterfall records itself
 * continuously because a time record cannot be reconstructed after the fact;
 * this can — a two-second hold refills within two seconds of being switched on —
 * so it is not worth a zone lookup per bin per frame while invisible.
 */
function updateDetection(frame, dtMs) {
  const { detect, reference, bins } = frame
  if (!margin || margin.length !== bins) {
    threshold = new Float32Array(bins)
    margin = new Float32Array(bins)
    crossTop = new Float32Array(bins)
    excessHold = new Float32Array(bins)
    excessAges = new Float32Array(bins)
  }

  // WHERE THE THRESHOLD OFFSET COMES FROM DEPENDS ON THE TARGETING MODEL, and
  // resolving it once per frame rather than per bin keeps the loop a read.
  // Under zones each zone carries its own Selectivity, read through the same
  // lookup — and the same boundary crossfade — the kernel applies; under focus
  // it is the global threshold biased by the nodes. Both agree with the
  // kernel's own per-bin curve; neither waits for it.
  const offsetAt = props.selectivityFn
    ?? (hz => zoneSettingsAt(props.zones, hz).selectivity)
  const spanOct = Math.log2(frame.maxHz / frame.minHz)
  const hzAt = d => frame.minHz * Math.pow(2, (d / (bins - 1)) * spanOct)
  for (let d = 0; d < bins; d++) {
    threshold[d] = reference[d] + offsetAt(hzAt(d))
    // ⚠ `detect`, NOT `mag`. The kernel decides on a max-filtered magnitude in
    // the shipping reference mode, and computing the margin from the raw curve
    // instead reported no crossing on bins it was cutting several dB — see the
    // note on `detect` in the processor's _snapshotDisplay.
    margin[d] = detect[d] - threshold[d]
  }

  advanceHold(bins, dtMs)
}

/** Advance the per-bin hold. Fed the live margin; leaves the decayed one behind. */
function advanceHold(bins, dtMs) {
  // Capped like every other dt in this file: a backgrounded tab returns with
  // seconds on the clock, and spending them all on decay empties the hold in
  // one frame.
  const step = Math.min(dtMs, 100)
  const fall = (EXCESS_FALL_DB_PER_SEC * step) / 1000

  for (let d = 0; d < bins; d++) {
    if (margin[d] > excessHold[d]) {
      // Strictly greater, so a bin sitting at zero against a held zero does not
      // restart its plateau on every frame forever.
      excessHold[d] = margin[d]
      excessAges[d] = 0
    } else {
      excessAges[d] += step
      if (excessAges[d] >= PEAK_HOLD_MS) {
        excessHold[d] = Math.max(margin[d], excessHold[d] - fall)
      }
    }
  }
}


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
  ctx.save()
  clipPlate(ctx, w)
  ctx.font = "500 9px 'JetBrains Mono',monospace"
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  let lastY = -Infinity
  for (const mark of grScaleMarks(props.fullScaleDb)) {
    if (!mark.label || mark.db === 0) continue
    const y = mark.fraction * reductionH.value
    if (y < MIN_SCALE_GAP_PX / 2 || y > reductionH.value - 3 || y - lastY < MIN_SCALE_GAP_PX) continue
    lastY = y
    ctx.fillStyle = 'rgba(255,255,255,.05)'
    ctx.fillRect(0, Math.round(y) + 0.5, w - 20, 1)
    ctx.fillStyle = 'rgba(255,255,255,.32)'
    ctx.fillText(`-${mark.label}`, w - 4, y)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.restore()
}

function hzLabel(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

function drawAxis(ctx, w, xFor, minHz, maxHz) {
  ctx.font = "500 9px 'JetBrains Mono',monospace"
  ctx.fillStyle = 'rgba(255,255,255,.32)'
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
  ctx.save()
  clipPlate(ctx, w)
  ctx.fillStyle = 'rgba(255,255,255,.22)'
  ctx.fillRect(x, 0, 1, laneH.value)
  ctx.restore()
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
      props.zones, reduction, bins, minHz, maxHz, props.deltaZone,
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
/** Index of the focus node being dragged, or -1. */
let focusDrag = -1
const dragging = ref(false)
/** Divider under the pointer, for the hover cursor. -1 for none. */
const hoverDivider = ref(-1)
/** Zone dot under the pointer, for the hover cursor and the dot's own size. */
const hoverZoneDot = ref(-1)
const hoverFocusNode = ref(false)

/**
 * Where the row of zone dots sits: just above the bottom of the plate.
 *
 * The BOTTOM, because reduction hangs from the top and the per-zone numbers are
 * printed there too — the two ends of a column are already spoken for
 * differently, so the handles go where nothing else lives. It clears the
 * dividers' lower grips (6 px tall, 7 px up from the bottom) by sitting above
 * them rather than beside them, since a zone dot and a boundary grip are
 * different gestures and must not be one pixel apart.
 */
const zoneDotY = computed(() => laneH.value - 17)

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
/**
 * The focus curve's vertical mapping, for both drawing and hit testing.
 *
 * ⚠ ONE FUNCTION FOR BOTH, and this panel has already recorded why: a hit test
 * computed from a second copy of the geometry fails silently, as handles that
 * cannot be clicked where they are drawn. The band edges are derived from the
 * two lane fractions rather than restated, for the reason drawSpectrum gives —
 * a constant of its own would let them drift back into overlapping from an edit
 * that looks unrelated.
 */
const focusScopeNow = () => {
  const bottom = laneH.value - foundBandH.value
  const top = laneH.value * REDUCTION_LANE_FRAC
  return focusScope(top, bottom, RESONANCE_FOCUS_RANGES.biasDb.max)
}

/**
 * THE FOCUS CURVE — the sensitivity bias, floating over the spectrum.
 *
 * ⚠ IT RUNS THE FULL WIDTH, CONTINUOUSLY. It was drawn only where it departed
 * from neutral for a while, on the argument that a bias is flat almost
 * everywhere so an edge-to-edge stroke paints a horizontal line across the
 * plot, and a horizontal line is a rail. That argument is real and it was
 * OVERRULED BY LOOKING AT IT: a full-width line laid over the spectrum, with no
 * plate, no band and no reserved row, reads as a floating line ON the display
 * rather than as an independent display area. Being technically a rail is not
 * the same as reading as one.
 *
 * What the break cost was continuity: the curve appeared and vanished as a node
 * was dragged past 0.3 dB, and with several nodes it broke into pieces that
 * looked like separate objects rather than one adjustable line.
 *
 * ⚠ ITS DATUM IS STATIC, and that is the one hard constraint. The line a node
 * actually biases is the threshold staircase, and hanging the handles there is
 * the obvious reading of "put it over the spectrum" — but measured, that line
 * travels 43 px in two seconds and up to 7 px between consecutive frames on a
 * band 139 px tall. That is the discarded Gaussian nodes' "impossible to aim"
 * report in numbers. The curve keeps the threshold's place and not its motion.
 */
function drawFocus(ctx, w) {
  const nodes = props.focusNodes
  const scope = focusScopeNow()
  const axisNow = { w, minHz: axis.minHz, maxHz: axis.maxHz }
  ctx.save()
  clipPlate(ctx, w)

  // The neutral datum, full width and faint. It is what the curve is read
  // against — without it a displaced curve says how the bias VARIES and not
  // which side of nothing it is on.
  ctx.strokeStyle = 'rgba(255,255,255,.13)'
  ctx.setLineDash([3, 5])
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.round(scope.datum) + 0.5)
  ctx.lineTo(w, Math.round(scope.datum) + 0.5)
  ctx.stroke()
  ctx.setLineDash([])

  const pts = biasCurvePoints(nodes, axisNow, scope)

  // The fill goes between the curve and its datum, so the shaded area IS the
  // bias and collapses to nothing where none has been asked for. That is what
  // lets the curve run the full width without the flat stretches claiming any
  // ink beyond the stroke itself.
  ctx.beginPath()
  ctx.moveTo(0, scope.datum)
  for (const p of pts) ctx.lineTo(p.x, p.y)
  ctx.lineTo(w, scope.datum)
  ctx.closePath()
  ctx.fillStyle = tint(props.accent, 0.18)
  ctx.fill()

  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.strokeStyle = bright(props.accent)
  ctx.lineWidth = 1.7
  ctx.shadowColor = tint(props.accent, 0.55)
  ctx.shadowBlur = 9
  ctx.stroke()
  ctx.shadowBlur = 0

  // Which way is which. A signed quantity on a line with no scale beside it is
  // otherwise a guess, and this one runs the opposite way to the knob it
  // offsets — down is MORE cut, because down is toward the material.
  ctx.font = "500 8px 'JetBrains Mono',monospace"
  ctx.fillStyle = 'rgba(255,255,255,.32)'
  const reach = scope.pxPerDb * scope.maxDb * 0.62
  ctx.textBaseline = 'bottom'
  ctx.fillText('MORE CUT', 7, scope.datum + reach)
  ctx.textBaseline = 'top'
  ctx.fillText('LESS CUT', 7, scope.datum - reach)
  ctx.textBaseline = 'alphabetic'

  nodes.forEach((n, i) => {
    const p = nodePoint(n, axisNow, scope)
    const sel = i === props.selectedFocusNode
    const on = n.enabled !== false
    ctx.beginPath()
    ctx.arc(p.x, p.y, sel ? NODE_R + 1.5 : NODE_R, 0, Math.PI * 2)
    if (!on) {
      // A bypassed node keeps its place and loses its fill: it is still where
      // it was put, and still the thing the controls are editing.
      ctx.strokeStyle = 'rgba(255,255,255,.34)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(p.x - NODE_R, p.y + NODE_R)
      ctx.lineTo(p.x + NODE_R, p.y - NODE_R)
      ctx.stroke()
    } else if (sel) {
      ctx.fillStyle = bright(props.accent)
      ctx.shadowColor = tint(props.accent, 0.6)
      ctx.shadowBlur = 9
      ctx.fill()
      ctx.shadowBlur = 0
    } else {
      ctx.fillStyle = PLATE_INK
      ctx.fill()
      ctx.strokeStyle = tint(props.accent, 0.75)
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
  })

  // The selected node's three numbers, ON the node — which is what replaces the
  // plate row that used to carry them under the panel.
  const sel = nodes[props.selectedFocusNode]
  if (sel) {
    const p = nodePoint(sel, axisNow, scope)
    const span = sel.spanOct < 1
      ? `${(sel.spanOct * 12).toFixed(0)}st`
      : `${sel.spanOct.toFixed(2)}oct`
    const text = `${formatHz(sel.hz)}  ${span}  ${sel.biasDb > 0 ? '+' : ''}${sel.biasDb.toFixed(1)}`
    // Outward from the curve, so the pill never lands on the line it describes.
    drawFocusPill(ctx, w, p.x, p.y + (sel.biasDb >= 0 ? 17 : -17), text)
  }
  ctx.restore()
}

function drawFocusPill(ctx, w, x, y, text) {
  ctx.font = "600 9px 'JetBrains Mono',monospace"
  const tw = ctx.measureText(text).width + 14
  const px = Math.max(2, Math.min(w - tw - 2, x - tw / 2))
  ctx.beginPath()
  roundRect(ctx, px, y - 9, tw, 18, 5)
  ctx.fillStyle = 'rgba(10,14,16,.86)'
  ctx.fill()
  ctx.strokeStyle = tint(props.accent, 0.4)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = bright(props.accent)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px + tw / 2, y)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawZones(ctx, w) {
  if (props.zones.length === 0) return
  const bottom = laneH.value
  ctx.save()
  clipPlate(ctx, w)

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
  const only = props.deltaZone
  props.zones.forEach((zone, i) => {
    const silent = only >= 0 ? i !== only : !zoneSettings(zone).enabled
    if (silent) paintColumn(i, VEIL)
  })
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
  drawZoneDots(ctx)
  ctx.restore()
}

/**
 * ONE DOT PER ZONE, AND IT IS WHAT SELECTS THE ZONE. The tint is gone.
 *
 * The selected column used to be washed in 7% of the accent. Two things were
 * wrong with that. It is a WHOLE-COLUMN statement about a whole-column area
 * that is already carrying three other whole-column statements — the veil over
 * a silent zone, the reduction fill, and (with the overlay on) the waterfall —
 * so the faintest of them was the one being asked to say which zone the knobs
 * were editing. And a wash is not a target: it says "this one is selected" and
 * nothing at all about how to select another, which left clicking anywhere in a
 * column as an undiscoverable gesture.
 *
 * A dot is both. It reads as a handle, so it says the columns are selectable,
 * and it is small enough to sit under the curves rather than behind them.
 * Clicking the plate anywhere in a column still selects it — the dot is the
 * signpost, not a narrowing of the gesture.
 *
 * FILLED FOR THE SELECTED ONE, RINGED FOR THE REST, which is the same
 * vocabulary the resonance marks use one layer up: a filled dot is the thing
 * being pointed at.
 */
function drawZoneDots(ctx) {
  const y = zoneDotY.value
  props.zones.forEach((zone, i) => {
    const x = zoneDotX(props.zones, i, axis)
    const on = i === props.selectedZone
    const hot = on || hoverZoneDot.value === i
    ctx.beginPath()
    ctx.arc(x, y, hot ? ZONE_DOT_R + 1 : ZONE_DOT_R, 0, Math.PI * 2)
    if (on) {
      ctx.fillStyle = props.accent
      ctx.fill()
      // A ring off the fill, so the selected dot survives being drawn over the
      // reduction fill in its own colour.
      ctx.strokeStyle = 'rgba(8,10,13,.75)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      ctx.fillStyle = 'rgba(8,10,13,.62)'
      ctx.fill()
      ctx.strokeStyle = tint(props.accent, hot ? 0.8 : 0.45)
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
    // Bypassed zones say so here too: the dot is the one part of a veiled
    // column that is drawn at full strength, so without this the handle of a
    // switched-off zone looks as live as any other.
    if (!zoneSettings(zone).enabled) {
      ctx.strokeStyle = 'rgba(255,255,255,.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x - 5, y + 5)
      ctx.lineTo(x + 5, y - 5)
      ctx.stroke()
    }
  })
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

// ── Focus editing ───────────────────────────────────────────────────────────
//
// Every edit replaces the array, exactly as the zone edits do, so nothing
// mutates a node in place and the kernel is handed a fresh copy each time.

let nextFocusId = 1

function commitFocus(nodes) {
  if (nodes !== props.focusNodes) emit('update:focusNodes', nodes)
}

function selectFocus(index) {
  if (index !== props.selectedFocusNode) emit('update:selectedFocusNode', index)
}

/** The node under a point, or -1. Uses the same scope the curve was drawn at. */
function focusNodeAt(x, y) {
  return focusMode.value ? nodeAt(props.focusNodes, x, y, axis, focusScopeNow()) : -1
}

function newFocusNode(hz) {
  return makeFocusNode(hz, `f${Date.now()}${nextFocusId++}`)
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
  const y = e.clientY - rect.top
  canvasEl.value?.focus({ preventScroll: true })

  // A DOT IS CHECKED FIRST, AND IT TAKES THE CLICK. A dot can land anywhere,
  // including on a divider; the divider is a full-height line that can be
  // grabbed at any other height, where the dot is a 12 px target that exists
  // nowhere else. Naming it also suppresses the zone selection this click would
  // otherwise make, so one click does one thing.
  // A FOCUS HANDLE OUTRANKS EVERYTHING, INCLUDING A RESONANCE MARK. Both are
  // small round targets that can land on top of one another, and only one of
  // them is a control: a mis-taken click on a mark costs a label, a mis-taken
  // click on a handle costs the setting the user was reaching for. The mark is
  // still reachable everywhere the handle is not.
  const fnode = focusNodeAt(x, y)
  if (fnode >= 0) {
    selectFocus(fnode)
    focusDrag = fnode
    dragging.value = true
    canvasEl.value?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    return
  }

  const mark = markAt(x, y)
  if (mark >= 0) {
    // Clicking the named one again puts the label away, which is the only way
    // back to a clean plot without hunting for empty plate to click on.
    selectedMarkHz.value = mark === markIndexNear(selectedMarkHz.value)
      ? null
      : marks[mark].hz
    e.preventDefault()
    return
  }
  // Anywhere else, including the plate around a dot, clears the label.
  selectedMarkHz.value = null

  // A zone dot before a divider, for the reason a resonance dot comes before
  // both: a dot is a point target that exists in one place, a divider is a line
  // that can be grabbed at any other height.
  const dot = zoneDotAt(props.zones, x, y, zoneDotY.value, axis)
  if (dot >= 0) {
    select(dot)
    e.preventDefault()
    return
  }

  const divider = boundaryAt(props.zones, x, axis, DIVIDER_HIT_PX)
  if (divider >= 0) {
    drag = { divider }
    dragging.value = true
    canvasEl.value?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    return
  }
  // ⚠ IN FOCUS MODE A CLICK ON EMPTY PLATE DESELECTS, IT DOES NOT CREATE.
  // Creation is the double-click, matching the vocabulary the zone plot already
  // teaches — and on a plate this size an accidental node is easy, where an
  // accidental deselection costs nothing.
  if (focusMode.value) {
    selectFocus(-1)
    return
  }
  // Anywhere else in the plot selects the zone under the pointer. Selection is
  // the ONLY thing a click in the display does now: the values moved to knobs,
  // so there is no gesture here that can change the sound by accident.
  select(zoneIndexAt(props.zones, x, axis, 20, 20000))
}

function onDrag(e, x, y) {
  if (focusDrag >= 0) {
    commitFocus(moveNode(props.focusNodes, focusDrag, x, y, axis, focusScopeNow()))
    return
  }
  if (!drag) return
  commit(moveBoundary(props.zones, drag.divider, hzFromX(x, axis), 20, 20000))
}

function onUp(e) {
  if (focusDrag >= 0) {
    focusDrag = -1
    dragging.value = false
    canvasEl.value?.releasePointerCapture?.(e.pointerId)
    return
  }
  if (!drag) return
  drag = null
  dragging.value = false
  canvasEl.value?.releasePointerCapture?.(e.pointerId)
}

function onDblClick(e) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const x = e.clientX - rect.left
  if (focusMode.value) {
    const y = e.clientY - rect.top
    const hit = focusNodeAt(x, y)
    if (hit >= 0) {
      commitFocus(removeNode(props.focusNodes, hit))
      selectFocus(-1)
    } else if (canAddFocusNode(props.focusNodes)) {
      const next = addNode(props.focusNodes, newFocusNode(hzFromX(x, axis)))
      commitFocus(next)
      selectFocus(next.length - 1)
    }
    e.preventDefault()
    return
  }
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
  if (focusMode.value) return onFocusKeyDown(e)
  const n = props.zones.length
  if (n === 0 && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
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
    // UP AND DOWN WALK THE RESONANCES, and this is the keyboard equivalent of
    // clicking a dot. Without it the frequencies the pills carry would be
    // reachable by pointer alone, which is the one thing this panel has
    // consistently refused to let a canvas control do — and it is worse here
    // than for the zones, because the accessible name can describe a zone's
    // settings but a resonance's frequency exists nowhere else on the panel.
    //
    // The walk includes "none", so the label can be put away from the keyboard
    // without borrowing Escape, which belongs to the window.
    case 'ArrowDown':
    case 'ArrowUp': {
      if (!marks.length) return
      const at = markIndexNear(selectedMarkHz.value)
      const step = e.key === 'ArrowDown' ? 1 : -1
      // -1 (nothing named) sits at the start of the cycle, so stepping down
      // from it lands on the lowest resonance and stepping up wraps to the
      // highest.
      const next = ((at + 1 + step) + (marks.length + 1)) % (marks.length + 1) - 1
      selectedMarkHz.value = next < 0 ? null : marks[next].hz
      break
    }
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
 * Keyboard equivalents for every focus gesture.
 *
 * Not a nicety, and more load-bearing here than for the zones: a node's
 * frequency, width and amount exist nowhere else on the panel now that the
 * plate row is gone, so without this they would be reachable by pointer alone.
 */
function onFocusKeyDown(e) {
  const nodes = props.focusNodes
  const i = props.selectedFocusNode
  const step = e.shiftKey ? 10 : 1

  const create = () => {
    if (!canAddFocusNode(nodes)) return
    const next = addNode(nodes, newFocusNode(hzFromX(axis.w * 0.5, axis)))
    commitFocus(next)
    selectFocus(next.length - 1)
  }

  // Plain left/right WALK the nodes; shifted, they move the selected one. The
  // zone editor's own convention, so one plot does not have two.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
    if (!nodes.length) return
    const dir = e.key === 'ArrowRight' ? 1 : -1
    selectFocus(dir > 0
      ? (i < 0 || i >= nodes.length - 1 ? 0 : i + 1)
      : (i <= 0 ? nodes.length - 1 : i - 1))
  } else if (i < 0 || !nodes[i]) {
    if (e.key === 'Enter') create()
    else return
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // ⚠ UP IS LESS CUT, matching the curve: positive bias draws downward,
    // because down is toward the material. An arrow that moved the handle one
    // way and the value the other is the sign error this model is most prone
    // to, and the only place it would be visible is here.
    const dir = e.key === 'ArrowDown' ? 1 : -1
    commitFocus(setNodeParam(nodes, i, 'biasDb', nodes[i].biasDb + dir * step))
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // In semitones, because the axis is logarithmic and a fixed Hz step is a
    // different musical distance at either end of it.
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const semis = e.shiftKey ? 12 : 1
    commitFocus(setNodeParam(nodes, i, 'hz', nodes[i].hz * Math.pow(2, (dir * semis) / 12)))
  } else if (e.key === '[' || e.key === ']') {
    commitFocus(scaleNodeSpan(nodes, i, e.key === ']' ? 1 : -1))
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    commitFocus(removeNode(nodes, i))
    selectFocus(-1)
  } else if (e.key === ' ') {
    commitFocus(toggleNode(nodes, i))
  } else if (e.key === 'Enter') {
    create()
  } else return
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
  const y = e.clientY - rect.top
  cursorX.value = x
  // Say that a dot is a target. A reveal whose trigger looks like part of the
  // picture is discoverable only by accident — the same argument the selection
  // edges' ew-resize cursor makes in the waveform.
  // Ordered as onDown resolves them, so what the cursor promises is what the
  // click will actually do.
  hoverFocusNode.value = focusDrag < 0 && focusNodeAt(x, y) >= 0
  hoverMark.value = !drag && !hoverFocusNode.value && markAt(x, y) >= 0
  hoverZoneDot.value = drag || hoverMark.value || hoverFocusNode.value
    ? -1
    : zoneDotAt(props.zones, x, y, zoneDotY.value, axis)
  onDrag(e, x, y)
}

function onLeave() {
  // Only the readout goes. A drag in progress keeps running off the edge of the
  // plot, because the pointer is captured and letting go of a node because the
  // pointer crossed a boundary is how a drag ends up dropping it somewhere the
  // user did not aim for.
  cursorX.value = null
  cursorText.value = ''
  hoverMark.value = false
  hoverZoneDot.value = -1
  hoverFocusNode.value = false
}

/**
 * The wheel sets a focus node's WIDTH — its third number, and the one not on a
 * drag axis.
 *
 * ⚠ THE TEMPLATE BOUND `@wheel.prevent="onWheel"` WITH NO SUCH FUNCTION
 * DEFINED, since before focus existed. Measured rather than reasoned about, and
 * the first two things I assumed were both wrong: it does NOT throw, and Vue
 * does not drop the binding either. What it does is apply the `.prevent`
 * modifier and then call nothing — so wheeling over the plot **silently
 * swallowed the page scroll and did nothing with it**, which in a window that
 * can run past the fold is a plot that eats a gesture the panel needs.
 *
 * ⚠ SO THE MODIFIER HAD TO GO, NOT JUST THE MISSING HANDLER. `.prevent` is
 * applied by the template before the handler runs, so an early `return` in here
 * cannot give the scroll back — the binding is now plain and this function
 * calls `preventDefault` only on the wheel it actually consumes.
 */
function onWheel(e) {
  // Zone model, or nowhere near a node: the page keeps its scroll.
  if (!focusMode.value) return
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return
  const i = focusNodeAt(e.clientX - rect.left, e.clientY - rect.top)
  if (i < 0) return
  commitFocus(scaleNodeSpan(props.focusNodes, i, e.deltaY < 0 ? 1 : -1))
  e.preventDefault()
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
  // THE BAND SENTENCE IS GONE, AND IT WAS PRINTING "NaN Hz TO NaN Hz". It read
  // `props.freqFloorHz` / `freqCeilHz`, which went with the low/high Range
  // fader — the props no longer exist, so `formatHz(undefined)` rounded to NaN
  // and every screen reader landing on this canvas heard it. Nothing is lost by
  // dropping it: what gets processed IS the zones, and they are listed below
  // with their own bounds.
  const mode = props.delta ? ' Monitoring the removed signal only.' : ''
  // The resonances, which used to be readable off the pills and now are not.
  // A canvas is opaque to a screen reader either way, but while every mark
  // carried a label there was at least a sighted equivalent; with the labels
  // behind a click, this text is the only complete list there is.
  const named = markIndexNear(selectedMarkHz.value)
  const found = marks.length
    ? ` ${marks.length} resonance${marks.length === 1 ? '' : 's'} tracked: `
      + marks.map((m, i) => `${formatHz(m.hz)} at minus ${m.db.toFixed(1)} decibels`
        + (i === named ? ', selected' : '')).join('; ') + '.'
    : ''
  // ⚠ THE FOCUS NODES HAVE TO BE IN HERE, and they were not: the separate rail
  // carried its own accessible name, and deleting the rail deleted the only
  // description of them there was. A canvas is opaque to a screen reader, and
  // now that the plate row is gone too, a node's frequency, width and amount
  // exist NOWHERE else on the panel — this sentence is the whole of it.
  const focus = focusMode.value
    ? (props.focusNodes.length
      ? ` ${props.focusNodes.length} focus node${props.focusNodes.length === 1 ? '' : 's'}: `
        + props.focusNodes.map((n, i) => {
          const dir = n.biasDb >= 0 ? 'more' : 'less'
          const off = n.enabled === false ? ', bypassed' : ''
          const here = i === props.selectedFocusNode ? ', selected' : ''
          return `${formatHz(n.hz)}, ${Math.abs(n.biasDb).toFixed(1)} decibels ${dir} cut, `
            + `${n.spanOct.toFixed(2)} octaves wide${off}${here}`
        }).join('; ') + '.'
      : ' No focus nodes: the detector runs at its global setting everywhere.')
    : ''
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
  return `${props.title}. ${cut}${mode}${found}${focus}${zones} `
    + `${focusMode.value ? FOCUS_HINT : ZONE_HINT}`
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
/**
 * How to work the focus nodes, in one string — the tooltip and the tail of the
 * accessible name, exactly as ZONE_HINT is for the other model. Every gesture
 * named here has a keyboard equivalent in onFocusKeyDown; a canvas whose only
 * editor is a pointer is the one control some people cannot use at all.
 */
const FOCUS_HINT = 'Drag a node for frequency and amount, wheel over one for '
  + 'width, double-click to add or remove. With a node selected: arrows move '
  + 'it, brackets change its width, space bypasses it, delete removes it.'

const ZONE_HINT = 'Click a resonance dot to label it with its frequency and '
  + 'depth, or click it again to put the label away. Click a zone dot along the '
  + 'bottom to select that zone. Drag a '
  + 'boundary line to move a zone. Double-click to split a zone, or double-click a '
  + 'boundary to merge. Keyboard: up and down label each resonance in turn, '
  + 'left and right select a zone, shift with left and right moves the '
  + 'boundary, Enter splits, Delete merges.'

/**
 * How many resonances are being worked and how hard, refreshed on the marks'
 * own clock. Printed by the panel header, via `update:reading`.
 *
 * A count that flickers between three and four several times a second is worse
 * than no count, so it is republished only when the mark set is, and the
 * average comes from the same frame the marks were found in.
 */
const markSummary = ref({ count: 0, avgDb: 0 })

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

    <!-- The recess, per the design system: `--bg-canvas-flat` under a ring of
         `--color-border-1`, at `--radius-lg` plus the 3 px of bezel, and the
         `--inset-canvas` shadow that gives it depth without floating. The old
         plate was a warm near-black (#0a0806) at 9 px with a single flat ring,
         which read as a different material from every other canvas in the app. -->
    <div
      :style="{
        padding: '3px',
        borderRadius: '15px',
        background: '#080a0d',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06), inset 0 2px 16px rgba(0,0,0,.7)',
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
        :style="{
          height: `${height}px`,
          borderRadius: '12px',
          cursor: dragging ? 'grabbing'
            : hoverFocusNode ? 'grab'
            : hoverMark || hoverZoneDot >= 0 ? 'pointer' : 'crosshair',
        }"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="onLeave"
        @dblclick="onDblClick"
        @wheel="onWheel"
        @keydown="onKeyDown"
      ></canvas>
    </div>
  </div>
</template>
