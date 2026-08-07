<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { magnitudeResponseDb } from '../../../audio/dsp/biquad.js'
import { eqSections } from '../../../audio/eqProcessor.js'
import { getRole, roleForRegion, bandwidthOctaves } from '../../../audio/eqBands.js'

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
 * EVERY ENABLED BAND IS IN THE CURVE, including ones VoiceRx has no control for.
 * A composite that omitted them would be a lie about what the user is hearing.
 */

const props = defineProps({
  bands: { type: Array, required: true },
  sampleRate: { type: Number, default: 44100 },
  accent: { type: String, default: '#8fd18f' },
  height: { type: Number, default: 200 },

  /**
   * How much of the plot can be operated.
   *
   * 'full'   — handles drag, and pressing empty canvas creates a band.
   * 'bands'  — existing handles drag and scroll; the canvas creates nothing.
   * 'none'   — a display.
   *
   * The middle setting is what VoiceRx needs and what one boolean could not
   * express. Its bands are role bands: every one of them is the control for a
   * named characteristic, so nudging where a correction sits is welcome, while
   * a press on empty canvas minting an untagged band is not — that band would
   * belong to no role, appear under no knob, and still be heard.
   */
  interaction: {
    type: String,
    default: 'full',
    validator: v => ['full', 'bands', 'none'].includes(v),
  },
  /** Band ids to show handles for. Null means all of them. */
  handleIds: { type: Array, default: null },
  selectedId: { type: String, default: null },

  /** Live post-EQ spectrum, or null. Called per frame; returns Float32Array dB. */
  spectrumFn: { type: Function, default: null },
  showAnalyzer: { type: Boolean, default: false },

  /** VoiceRx overlay: the analysis result, whose envelope and detections are drawn. */
  analysis: { type: Object, default: null },
  /** Region name to emphasise, driven by hovering a suggestion row. */
  highlightRegion: { type: String, default: null },

  /** Gain axis: 'auto' to scale to the bands, or a number of dB either side. */
  dbRange: { type: [String, Number], default: 'auto' },
  /** Show the overlaid range stops. Off where the plot is a read-only display. */
  rangeControl: { type: Boolean, default: false },

  /** Band being monitored alone; its span is shaded so you can see where you are listening. */
  soloId: { type: String, default: null },
  /**
   * A region being monitored that has no band — `{ type, frequencyHz, q }`.
   * Shades the same way; takes precedence over soloId, as it does in the kernel.
   */
  soloProbe: { type: Object, default: null },
  /** Track the pointer and show the frequency under it. */
  cursorReadout: { type: Boolean, default: false },

  /** Low end of the frequency axis. */
  minHz: { type: Number, default: 20 },
  /** High end of the frequency axis. */
  maxHz: { type: Number, default: 20000 },

  /**
   * Resolved region table to draw as a scale ribbon along the bottom, or null.
   *
   * Takes the table rather than reading one, because the ranges move with the
   * classified voice type and only the caller knows which one is in force.
   */
  regionRibbon: { type: Object, default: null },
})

const emit = defineEmits([
  'create-band', 'select-band', 'move-band', 'remove-band', 'toggle-band', 'q-band',
  'update:dbRange',
  /**
   * Pointer entered or left a band's dot; null on leave.
   *
   * Emitted on hover rather than only on press so that idly sweeping the curve
   * lights each band's strip in turn. That is the cheapest lesson available in
   * what the dots are: a novice who only ever uses the strips still learns,
   * without being told, that the dot and the strip are the same band.
   */
  'hover-band',
])

const clampUnit = v => (v < 0 ? 0 : v > 1 ? 1 : v)
/** Height of the region ribbon, inside the plot along its bottom edge. */
const RIBBON_H = 7

/**
 * The frequency axis.
 *
 * Configurable because the two plugins work over different spans and showing
 * the same one in both wastes the space that matters. The EQ can place a band
 * anywhere from 20 Hz to 20 kHz and keeps the full range. VoiceRx cannot: every
 * role range, every marker and the whole measured envelope live between 60 Hz
 * and 16 kHz, so on a full-span axis the outer 19% of the plot is a region the
 * plugin can never draw in, measure in or put a control in.
 */
const fMin = computed(() => props.minHz)
const fMax = computed(() => props.maxHz)
const logSpan = computed(() => Math.log2(fMax.value / fMin.value))

const canvasEl = ref(null)
const wrapEl = ref(null)
const width = ref(600)
let rafId = null
let ro = null

/**
 * Frequency under the pointer, drawn into the plot background by drawCursorHz.
 *
 * Declared up here with the other module-level refs rather than beside the
 * handler that writes it, because the redraw watcher lists it as a source and
 * runs before that point in the file.
 */
const cursorHz = ref(null)

// ── Axis mapping ────────────────────────────────────────────────────────────

/**
 * Gain axis auto-scales so small moves stay legible (spec §7.1).
 *
 * Only the EQ curve lives on this axis. The envelope is fitted separately —
 * its range is 60 dB and more, and letting it drive the gain scale would
 * compress every band the user is actually adjusting into a few pixels.
 */
/** Shapes with no gain term, whose curves fall away without limit. */
const UNBOUNDED_TYPES = new Set(['notch', 'highpass', 'lowpass'])

/**
 * The narrowest AUTO will go.
 *
 * It was 6, which is too tight for general use in a way that changes what
 * people do rather than just how it looks: at ±6 a 3 dB boost fills half the
 * plot, reads as drastic, and pushes users to dial in less gain than the
 * material needs. It also cramps the ordinary way the control gets used —
 * sweep with obvious gain to find the frequency, then back off once found.
 *
 * Twelve is also what a notch or pass filter needs before its skirt is
 * readable as a slope rather than a cliff, so the two cases want the same
 * number and there is no longer a special case for unbounded shapes.
 */
const AUTO_FLOOR_DB = 12

/**
 * The widest AUTO will go.
 *
 * Bands top out at ±18 (PARAM_RANGES.gainDb), so the ceiling has to clear that
 * with room to spare — otherwise pushing a bell to its limit flattens it
 * against the top of the plot, which looks like the tool has broken rather than
 * like the band has reached its maximum.
 */
const AUTO_CEILING_DB = 21

const dbMax = computed(() => {
  if (props.dbRange !== 'auto') return Number(props.dbRange)

  let peak = AUTO_FLOOR_DB
  for (const b of props.bands) {
    if (!b.enabled) continue
    // These keep whatever gainDb they carried in from their previous type.
    // That number is not on the curve, so it must not stretch the axis the
    // curve is drawn against.
    if (UNBOUNDED_TYPES.has(b.type)) continue
    peak = Math.max(peak, Math.abs(b.gainDb) + 2)
  }

  return Math.min(AUTO_CEILING_DB, Math.max(AUTO_FLOOR_DB, Math.ceil(peak / 3) * 3))
})

/**
 * Stops, narrowest first, so the row reads as zoom-in / normal / zoom-out.
 *
 * ±6 is the fine-tuning view AUTO no longer provides now that it floors at 12;
 * ±30 is the wide view for reading a notch or pass filter's whole skirt.
 */
const DB_RANGES = [6, 'auto', 30]

function rangeLabel(r) {
  return r === 'auto' ? 'AUTO' : `±${r}`
}

function xFor(hz) {
  return (Math.log2(Math.max(hz, fMin.value) / fMin.value) / logSpan.value) * width.value
}

function hzFor(x) {
  return fMin.value * Math.pow(2, (x / width.value) * logSpan.value)
}

/**
 * Gain to pixels, clamped to the plot.
 *
 * A notch is a true null and a pass filter falls away without limit, so their
 * curves run to negative infinity and would otherwise be drawn far outside the
 * box — over the legend, the strips and anything else below. There is no axis
 * range that "accommodates" them, so the curve stops at the floor instead,
 * which is what every parametric EQ does and reads correctly as off-the-scale.
 *
 * Auto-scaling to make room is the wrong fix: the axis would have to jump to
 * its full range the moment a high-pass is added, squashing every bell the user
 * is actually adjusting into a few pixels — the failure mode dbMax exists to
 * avoid.
 */
function yFor(db) {
  const y = props.height / 2 - (db / dbMax.value) * (props.height / 2)
  // Half the stroke width in from each edge, so a clamped line is not sliced
  // lengthwise by the canvas boundary.
  return Math.max(1, Math.min(props.height - 1, y))
}

function dbFor(y) {
  return ((props.height / 2 - y) / (props.height / 2)) * dbMax.value
}

const GRID_DECADES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

/**
 * Grid marks inside the axis.
 *
 * Filtered rather than fixed: xFor clamps below the axis floor, so on a
 * narrowed axis every mark under it would pile up on the left edge as one
 * bright line and every mark over it would be drawn past the right edge.
 */
const gridHz = computed(() =>
  GRID_DECADES.filter(hz => hz >= fMin.value && hz <= fMax.value))

function hzLabel(hz) {
  if (hz >= 1000) return `${hz / 1000}k`
  return String(hz)
}

/**
 * VoiceRx labels its axis with role names, not numbers (spec §6.1).
 *
 * Naming the regions is what lets someone read the display without knowing any
 * frequencies — the numbers are still there on hover. Labels alternate between
 * two rows because nine of them across a log axis collide badly in one, and the
 * regions overlap at their edges by design.
 */
const roleAxis = computed(() => {
  if (!props.analysis) return []
  return (props.analysis.regionResults ?? [])
    .filter(r => r.roleId)
    .map((r, i) => ({
      id: r.roleId,
      label: getRole(r.roleId)?.label ?? r.roleId,
      centerHz: Math.sqrt(r.scanLowHz * r.scanHighHz),
      detected: r.detected,
      row: i % 2,
    }))
})

/**
 * Envelope level at an arbitrary frequency, interpolated between FFT bins.
 *
 * The envelope is sampled on a linear frequency grid (~10.8 Hz per bin) and
 * drawn on a log one, so below a few hundred hertz many plot points fall inside
 * a single bin. Taking the nearest bin drew the low end as a visible staircase —
 * an artefact of the grid mismatch that reads as structure in the voice.
 */
function envelopeAt(hz) {
  const a = props.analysis
  const env = a?.envelopeDb
  if (!env) return 0
  const pos = (hz * (env.length - 1) * 2) / props.sampleRate
  const lo = Math.max(0, Math.min(env.length - 1, Math.floor(pos)))
  const hi = Math.min(env.length - 1, lo + 1)
  const t = pos - lo
  return env[lo] + (env[hi] - env[lo]) * t
}

// ── Curves ──────────────────────────────────────────────────────────────────

const CURVE_POINTS = 320
const curveFreqs = computed(() => Array.from({ length: CURVE_POINTS }, (_, i) =>
  fMin.value * Math.pow(fMax.value / fMin.value, i / (CURVE_POINTS - 1))))

const compositeDb = computed(() => {
  const sections = eqSections(props.sampleRate, props.bands)
  if (sections.length === 0) return new Float64Array(CURVE_POINTS)
  return magnitudeResponseDb(sections, curveFreqs.value, props.sampleRate)
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
  // Behind everything: backdrops marking where you are listening and what
  // frequency the pointer is on, not marks competing with the curve.
  drawSolo(ctx, h)
  drawCursorHz(ctx, w, h)
  if (props.showAnalyzer && props.spectrumFn) drawAnalyzer(ctx, w, h)
  const fit = props.analysis ? drawEnvelope(ctx, w, h) : null
  drawExtremes(ctx, h)
  drawComposite(ctx, h)
  drawRegionRibbon(ctx, h)
  // Markers last: they are the point of the VoiceRx display and must not be
  // crossed out by the EQ curve.
  if (fit) drawMarkers(ctx, h, fit.yEnv)
}

/**
 * The nine named regions, drawn to scale along the bottom of the plot.
 *
 * This is what makes the palette and the picture one object. The alternative
 * was to place the role controls themselves at their frequencies, which does
 * not survive contact with the arithmetic: on a log axis the closest pair of
 * centres are 46 px apart at this width and a control is 62 px wide, so they
 * would overlap in the mids while 150 px of the low end sat empty. A ribbon
 * carries the mapping at the axis's own scale and leaves the controls evenly
 * spaced and legible, with hover linking the two.
 *
 * Spans are the scan ranges, so adjacent regions genuinely overlap — Body and
 * Mud share 200-280 Hz for a male voice. Drawn translucent, the overlap shows
 * as a brighter join, which is the truth: a problem sitting there belongs to
 * both descriptions.
 */
function drawRegionRibbon(ctx, h) {
  const table = props.regionRibbon
  if (!table) return

  const top = h - RIBBON_H
  for (const [region, span] of Object.entries(table)) {
    const [lo, hi] = span
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const x1 = xFor(Math.max(lo, fMin.value))
    const x2 = xFor(Math.min(hi, fMax.value))
    const hot = props.highlightRegion === region

    ctx.fillStyle = hot
      ? `color-mix(in srgb, ${props.accent} 55%, transparent)`
      : 'rgba(255,255,255,.07)'
    ctx.fillRect(x1 + 0.5, top, Math.max(1, x2 - x1 - 1), RIBBON_H - 2)

    if (!hot) continue
    // The label only for the region being pointed at. Nine at this scale would
    // be unreadable, and the palette below already names all nine.
    const role = roleForRegion(region)
    if (!role) continue
    ctx.fillStyle = `color-mix(in srgb, ${props.accent} 45%, #ffffff)`
    ctx.font = "600 8px 'Inter', system-ui, sans-serif"
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(role.label.toUpperCase(), (x1 + x2) / 2, top - 2)
  }
}

function drawGrid(ctx, w, h) {
  ctx.lineWidth = 1

  ctx.strokeStyle = 'rgba(255,255,255,.06)'
  for (const hz of gridHz.value) {
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

  // Stepped outward from zero rather than up from -dbMax, so 0 dB always gets a
  // line. Walking up from the bottom only lands on it when dbMax happens to be
  // a multiple of the step — at ±15 or ±21 the reference line disappeared and
  // the whole grid sat half a step off centre.
  const lines = [0]
  for (let db = step; db <= dbMax.value; db += step) lines.push(db, -db)

  for (const db of lines) {
    const y = Math.round(yFor(db)) + 0.5
    ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    // The line sits at its true position, but the text is held inside the
    // canvas: the outermost lines are at y=0 and y=h, where a middle-baselined
    // label would be sliced in half by the edge.
    if (db !== 0) ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 4, Math.min(h - 6, Math.max(6, y)))
  }
}

/**
 * The span of spectrum a band acts on, for shading it while soloed.
 *
 * Deliberately the band's own reach rather than the monitor filter's response
 * (soloSectionFor in eqProcessor.js). What the user needs to see is where they
 * are listening; the exact skirts of the bandpass doing the listening are an
 * implementation detail and would draw a softer, vaguer edge.
 */
function soloRangeHz(band) {
  const f = band.frequencyHz
  switch (band.type) {
    case 'lowshelf':
    case 'highpass':
      return [fMin.value, f]
    case 'highshelf':
    case 'lowpass':
      return [f, fMax.value]
    default: {
      // RBJ bandwidth in octaves from Q, so the shading narrows as the band does.
      const bwOct = bandwidthOctaves(band.q)
      return [f * 2 ** (-bwOct / 2), f * 2 ** (bwOct / 2)]
    }
  }
}

function drawSolo(ctx, h) {
  // A probe is a region being auditioned with no band behind it, so it is not
  // in the list to be found — but it shades identically, because to the ear it
  // is the same thing being listened to.
  const band = props.soloProbe ?? props.bands.find(b => b.id === props.soloId)
  if (!band) return

  const [lo, hi] = soloRangeHz(band)
  const x1 = xFor(Math.max(lo, fMin.value))
  const x2 = xFor(Math.min(hi, fMax.value))

  ctx.fillStyle = `color-mix(in srgb, ${props.accent} 12%, transparent)`
  ctx.fillRect(x1, 0, x2 - x1, h)

  ctx.strokeStyle = `color-mix(in srgb, ${props.accent} 40%, transparent)`
  ctx.lineWidth = 1
  for (const x of [x1, x2]) {
    const px = Math.round(x) + 0.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
  }
}

/**
 * The pointer's frequency, set into the plot's background.
 *
 * Always plain hertz — never 15.2 kHz. The number exists to be compared with
 * the one on a band's frequency knob and typed into it, and a reading that
 * changes units halfway across the axis makes both of those a conversion step.
 *
 * Drawn large and very faint, into the canvas rather than as an overlay, so it
 * sits behind the curve and the analyzer. A readout that tracks the pointer is
 * only useful if it can be read without looking away from the curve, which
 * rules out putting it in the header row; and at this weight it reads as a
 * property of the surface rather than as another label competing for the eye.
 */
function drawCursorHz(ctx, w, h) {
  if (!props.cursorReadout || cursorHz.value === null) return

  ctx.save()
  ctx.font = '600 15px "JetBrains Mono", monospace'
  ctx.fillStyle = 'rgba(255,255,255,.15)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // Low and centred: the curve lives around the zero line and the analyzer
  // climbs from the floor, so this is the emptiest part of the plot.
  ctx.fillText(`${cursorHz.value} Hz`, w * 0.5, h * 0.15)
  ctx.restore()
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
    if (hz < fMin.value) continue
    if (hz > fMax.value) break
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

/**
 * The tonal shape of the voice: the measured spectral envelope, as one
 * continuous curve behind everything else.
 *
 * WHY THE ENVELOPE AND NOT THE DEVIATION. The detector works by laying a
 * straight baseline between anchors just outside each region and measuring the
 * excursion from it. Plotting that excursion seemed natural — it is the
 * quantity the thresholds apply to — but it is an internal intermediate, and
 * drawing it produced a row of disconnected sawtooth fragments: every region
 * starts negative and ends positive, because a straight line under a curved
 * envelope always does that, and adjacent regions disagree by 3-6 dB at their
 * shared edge because each uses its own anchors. It read as noise, and it was.
 *
 * The envelope itself is continuous, is the actual measurement, and looks like
 * the thing every listener has already seen in a media player. The problems the
 * detector found are marked on it directly, which is the part the user needs.
 *
 * Drawn on its own vertical fit rather than the dB axis: it is a shape to
 * recognise, not a number to read, and its true range (60 dB and more) has no
 * relationship to the ±18 dB the EQ curve lives in. Fitting it to the plot is
 * honest as long as nothing invites the reader to measure it, so it carries no
 * gridlines and no scale.
 */
function drawEnvelope(ctx, w, h) {
  const a = props.analysis
  const freqs = a?.freqsHz
  const env = a?.envelopeDb
  if (!freqs || !env) return

  // Fit to the band that has content. The floor is relative to the peak for the
  // same reason the analysis skips dead regions: below it there is nothing but
  // the log of numerical noise, and letting that set the scale would flatten
  // the part of the curve that matters into a few pixels.
  let peak = -Infinity
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] >= 100 && freqs[k] <= 16000) peak = Math.max(peak, env[k])
  }
  if (!Number.isFinite(peak)) return
  const floor = peak - 60
  const top = h * 0.08
  const bottom = h * 0.94

  // Clamped at BOTH ends. The low clamp was always here; the high one is needed
  // because peak and floor are fitted over 100 Hz-16 kHz — deliberately, so
  // that low-end content cannot compress the part of the curve anyone is
  // reading — while the axis starts lower than that. On a rumble-heavy file the
  // envelope below 100 Hz sits above the fitted peak, and unclamped it computed
  // t > 1 and drew off the top of the canvas.
  const yEnv = (db) => {
    const t = clampUnit((db - floor) / (peak - floor))
    return bottom - t * (bottom - top)
  }

  const points = []
  for (let i = 0; i < CURVE_POINTS; i++) {
    points.push([xFor(curveFreqs.value[i]), yEnv(envelopeAt(curveFreqs.value[i]))])
  }
  if (points.length < 2) return null

  const trace = () => {
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1])
  }

  // Filled body first, so the curve reads as a shape rather than a wire.
  trace()
  ctx.lineTo(points[points.length - 1][0], bottom)
  ctx.lineTo(points[0][0], bottom)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,.055)'
  ctx.fill()

  trace()
  ctx.lineWidth = 1.25
  ctx.strokeStyle = 'rgba(255,255,255,.3)'
  ctx.stroke()

  return { yEnv }
}

/**
 * Where the problems are: one marker per detection, sitting on the envelope.
 *
 * This is what connects the words in the suggestion list to the picture. The
 * label is the role name, not a frequency — the frequency is in the suggestion
 * row for anyone who wants it, and a number here would be one more thing to
 * decode.
 */
function drawMarkers(ctx, h, yEnv) {
  const a = props.analysis
  if (!a || !yEnv) return

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  for (const r of a.regionResults ?? []) {
    if (!r.detected || !Number.isFinite(r.centerHz)) continue

    const hot = props.highlightRegion === r.name
    const x = xFor(r.centerHz)
    const y = yEnv(envelopeAt(r.centerHz))
    const colour = hot ? 'rgba(255,200,140,1)' : 'rgba(255,180,120,.85)'

    // A stem down to the axis, so the marker reads as "at this frequency".
    ctx.beginPath()
    ctx.setLineDash([2, 3])
    ctx.moveTo(x, y)
    ctx.lineTo(x, h)
    ctx.lineWidth = 1
    ctx.strokeStyle = hot ? 'rgba(255,200,140,.55)' : 'rgba(255,180,120,.25)'
    ctx.stroke()
    ctx.setLineDash([])

    ctx.beginPath()
    ctx.arc(x, y, hot ? 5 : 3.5, 0, Math.PI * 2)
    ctx.fillStyle = colour
    ctx.fill()

    const role = getRole(r.roleId)
    if (role) {
      ctx.font = `700 ${hot ? 10 : 9}px Inter, sans-serif`
      ctx.fillStyle = colour
      ctx.fillText(role.label.toUpperCase(), x, Math.max(11, y - 9))
    }
  }
  ctx.textAlign = 'start'
}

function drawExtremes(ctx, h) {
  const db = compositeDb.value
  ctx.fillStyle = 'rgba(255,120,100,.10)'
  let runStart = -1
  for (let i = 0; i <= CURVE_POINTS; i++) {
    const hot = i < CURVE_POINTS && (db[i] > EXTREME_HI || db[i] < EXTREME_LO)
    if (hot && runStart === -1) runStart = i
    if (!hot && runStart !== -1) {
      const x0 = xFor(curveFreqs.value[runStart])
      const x1 = xFor(curveFreqs.value[i - 1])
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h)
      runStart = -1
    }
  }
}

function drawComposite(ctx, h) {
  const db = compositeDb.value

  ctx.beginPath()
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = xFor(curveFreqs.value[i])
    const y = yFor(db[i])
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  const stroke = ctx.strokeStyle
  ctx.save()
  ctx.lineTo(xFor(fMax.value), yFor(0))
  ctx.lineTo(xFor(fMin.value), yFor(0))
  ctx.closePath()
  ctx.fillStyle = `color-mix(in srgb, ${props.accent} 14%, transparent)`
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = xFor(curveFreqs.value[i])
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
  [() => props.bands, () => props.analysis, () => props.highlightRegion,
   () => props.selectedId, () => props.soloId, () => props.soloProbe,
   () => props.regionRibbon, fMin, fMax, dbMax, cursorHz],
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
  // Same rule as the axis: a shape with no gain term sits on the centre line,
  // not at whatever gain it happened to carry in from its previous type.
  const hasGain = band.type !== 'notch' && band.type !== 'highpass' && band.type !== 'lowpass'
  return {
    left: `${(xFor(band.frequencyHz) / width.value) * 100}%`,
    top: `${yFor(hasGain ? band.gainDb : 0)}px`,
  }
}

/** Handles respond to the pointer in both editing modes. */
const canEditBands = computed(() => props.interaction !== 'none')

const handleHint = computed(() => (canEditBands.value
  ? 'Drag to move · scroll to widen or narrow · double-click to remove'
  : null))

let drag = null

function onHandleDown(e, band) {
  if (!canEditBands.value) return
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

/**
 * Grab area around a band's dot.
 *
 * Big enough that an ordinary aim lands on the band rather than on the canvas
 * behind it — 32 px is roughly the accuracy of a mouse move people do not think
 * about. It also blocks band creation in that square, which is the point: a
 * press near an existing band almost always means "grab that one".
 */
const HANDLE_HIT_PX = 32

function onHandleWheel(e, band) {
  if (!canEditBands.value) return
  e.preventDefault()
  // Scroll over a handle adjusts Q — the third dimension a two-axis drag
  // cannot reach.
  emit('q-band', { id: band.id, delta: e.deltaY > 0 ? -1 : 1 })
}

/**
 * Frequency under the pointer.
 *
 * The axis is logarithmic and its labelled decades are an octave and more
 * apart, so "roughly where is 400 Hz" is a guess even for someone who reads
 * these plots daily. Tracking the pointer turns the whole surface into a ruler.
 */
function onPlotMove(e) {
  if (!props.cursorReadout || !canvasEl.value) return
  const rect = canvasEl.value.getBoundingClientRect()
  // Rounded at the source, not at display time, so the ref only changes when
  // the number on screen would — which keeps this from forcing a canvas
  // repaint on every pixel of pointer travel.
  cursorHz.value = Math.round(hzFor(e.clientX - rect.left))
}

function onPlotDown(e) {
  if (props.interaction !== 'full') return
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
  <div
    ref="wrapEl"
    class="relative w-full select-none"
    @pointermove="onPlotMove"
    @pointerleave="cursorHz = null"
  >
    <canvas
      ref="canvasEl"
      class="block w-full rounded-[3px]"
      :style="{ height: `${height}px`, background: 'rgba(0,0,0,.28)' }"
      @pointerdown="onPlotDown"
    />

    <!-- Gain range, overlaid on the axis it governs. pointerdown is stopped
         here: the canvas below treats a press as "create a band there". -->
    <div
      v-if="rangeControl"
      class="absolute top-[6px] right-[6px] inline-flex rounded-[3px] overflow-hidden"
      style="border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.45)"
      @pointerdown.stop
    >
      <button
        v-for="r in DB_RANGES"
        :key="r"
        type="button"
        class="px-[6px] py-[3px] transition-colors"
        :style="{
          font: '600 8px/1 Inter',
          letterSpacing: '.06em',
          background: dbRange === r
            ? `color-mix(in srgb, ${accent} 26%, transparent)` : 'transparent',
          color: dbRange === r ? accent : 'rgba(255,255,255,.4)',
        }"
        :title="r === 'auto'
          ? 'Scale the gain axis to fit the bands'
          : `Pin the gain axis to ${rangeLabel(r)} dB`"
        @click="emit('update:dbRange', r)"
      >{{ rangeLabel(r) }}</button>
    </div>


    <!--
      Band handles: DOM, not canvas, so pointer capture and focus are free.

      The grab area is HANDLE_HIT_PX square while the dot drawn inside it stays
      11 px. They used to be the same 11 px, which made grabbing an existing
      band a game of accuracy nobody wins: the canvas underneath turns any press
      into a new band, so every near miss added one. The dot is a target to aim
      at, not the size of the target.
    -->
    <!--
      Its own title, which overrides the wrapper's by ordinary HTML tooltip
      resolution. The plot as a whole explains adding a band; a band explains
      what can be done to a band. That is cheaper than any badge and it puts the
      answer where the question is asked — an earlier version floated a × over
      the hovered dot, which worked and read as clutter.
    -->
    <div
      v-for="band in shownHandles"
      :key="band.id"
      class="absolute -translate-x-1/2 -translate-y-1/2"
      :style="{
        ...handleStyle(band),
        width: `${HANDLE_HIT_PX}px`,
        height: `${HANDLE_HIT_PX}px`,
      }"
      :title="handleHint"
      @pointerenter="emit('hover-band', band.id)"
      @pointerleave="emit('hover-band', null)"
    >
      <button
        type="button"
        class="absolute inset-0 flex items-center justify-center"
        :style="{ cursor: canEditBands ? 'grab' : 'default' }"
        :aria-label="`Band at ${Math.round(band.frequencyHz)} hertz, ${band.gainDb.toFixed(1)} decibels`"
        @pointerdown="onHandleDown($event, band)"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
        @wheel="onHandleWheel($event, band)"
        @dblclick.stop="emit('remove-band', band.id)"
      >
        <span
          class="block rounded-full border-2 transition-[box-shadow,opacity,width,height]"
          :style="{
            width: band.id === selectedId ? '14px' : '11px',
            height: band.id === selectedId ? '14px' : '11px',
            borderColor: accent,
            background: band.enabled ? accent : 'transparent',
            opacity: band.enabled ? 1 : 0.45,
            boxShadow: band.id === selectedId ? `0 0 0 4px color-mix(in srgb, ${accent} 22%, transparent)` : 'none',
          }"
        />
      </button>
    </div>

    <!-- Frequency axis: role names in VoiceRx, numbers in General -->
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
        v-for="hz in gridHz"
        :key="hz"
        class="absolute top-0"
        :style="{
          left: `${(xFor(hz) / width) * 100}%`,
          transform: hz === gridHz[0] ? 'none'
            : hz === gridHz[gridHz.length - 1] ? 'translateX(-100%)' : 'translateX(-50%)',
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
