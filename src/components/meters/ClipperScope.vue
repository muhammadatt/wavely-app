<script setup>
import { computed, ref } from 'vue'
import { useMeterFrame } from './ballistics.js'
import { crossingRuns } from './clipperRuns.js'

/**
 * Scrolling scope for the Soft Clipper: the input envelope, the threshold, and
 * the part of each transient that crosses it.
 *
 * THE PLAYHEAD IS AT THE CENTRE, and the face is half history, half lookahead.
 * An earlier version ended at "now" on the right-hand edge, the way a hardware
 * scope does, and it left the panel unable to answer the first question anyone
 * asks of it: which part of my file am I looking at. There was no marker
 * because there was nowhere to put one — every pixel was the past, and the edge
 * was the present. Centring the playhead gives the eye a fixed reference and
 * makes room for the half that turned out to be the useful one: the audio about
 * to arrive, shaded against the current setting, so the display says what the
 * clipper is going to do a second before it does it.
 *
 * The two halves come from different places. Left is the kernel's ring — real
 * measured reduction, with the threshold that was in force. Right is the
 * timeline itself, read through `envelopeFn`, because the effect has not seen
 * that audio yet. Drawn dimmer for exactly that reason: it is a prediction, and
 * in adaptive mode the tracker will have moved by the time it arrives.
 *
 * WHERE THE HALVES COME FROM IS AN IMPLEMENTATION FACT AND MUST NOT BE VISIBLE
 * AS MOTION. When the ring stops filling — bypass, or a stopped transport — the
 * left half falls back to the timeline too, so the whole picture keeps moving
 * with the playhead as one waveform. It reads as one; anything that makes half
 * of it stop while the other half scrolls reads as broken.
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
 * THE THRESHOLD IS DRAWN FLAT, AT ITS CURRENT VALUE. An earlier version traced
 * it over time, on the reasoning that T rides a 3 s tracker in adaptive mode
 * and only a trace makes that visible. Reported from use as confusing rather
 * than informative, and the report is right: a trailing curve answers a
 * question about the detector's behaviour, where the user is asking where their
 * ceiling is. The line still moves in real time, so adaptive tracking is
 * visible as motion — it is the history of that motion that is gone. See
 * drawThresholdLine.
 *
 * DRAGGABLE IN BOTH MODES, AND AN EARLIER VERSION OF THIS FILE ARGUED THE
 * OPPOSITE. It said the adaptive curve was "a readout of a measurement — there
 * is nothing to set". That is wrong, and the error is worth stating because it
 * is what kept this display from being the panel's control surface: the curve
 * is `speechLevel + Headroom`. Only the first term is a measurement. The second
 * is a user parameter, and it is exactly the curve's vertical offset from the
 * envelope — which is the one quantity a vertical drag expresses naturally.
 *
 * So both modes drag, and they set different things because the curve means
 * different things:
 *   fixed    — the pointer's dB IS the threshold. Absolute.
 *   adaptive — the pointer's MOVEMENT in dB is added to Headroom. Relative.
 *
 * The adaptive case has to be relative rather than absolute, and not as a
 * refinement: the curve is moving on its own while you hold it, so pinning it
 * to the cursor would fight the tracker for control of the same line and the
 * setting would depend on where in a syllable the drag happened to end.
 * Dragging the OFFSET leaves the tracker in charge of the level and the user in
 * charge of the headroom, which is the actual division of labour in the kernel.
 */
const props = defineProps({
  /**
   * Returns the effect's scope ring, or null. A function rather than a value:
   * this is ~1400 floats at ~46 Hz feeding a canvas that redraws every frame
   * regardless, and putting it through reactivity would make Vue diff typed
   * arrays for nothing. Same arrangement as ResonanceSpectrum's dataFn.
   */
  dataFn: { type: Function, required: true },
  /**
   * Peak envelope of the timeline around the playhead —
   * `(offsetSeconds, seconds, columns) => Float32Array | null`, where the offset
   * is relative to the playhead and may be negative. A function for the same
   * reason dataFn is: it is read once a frame into a canvas and has no business
   * going through reactivity.
   *
   * Called for the half ahead of the playhead always, and for the half behind it
   * whenever the kernel's ring is not live — see the layout note in draw().
   * Two calls in one frame, so an implementation that reuses a scratch buffer
   * needs one per side.
   *
   * Optional. Without it the face shows only what the effect has processed,
   * which is what a scope with no access to the timeline can honestly show.
   */
  envelopeFn: { type: Function, default: null },
  /**
   * Total time across the face, in seconds — half behind the playhead, half
   * ahead of it. The behind half is the effect's whole ring, so this should be
   * twice the effect's SCOPE_SECONDS: pass less and the lookahead runs at a
   * different scale from the history, which would make one timeline read as
   * two.
   */
  windowSeconds: { type: Number, default: 8 },
  /** 'adaptive' | 'fixed' — decides whether the curve is a handle. */
  mode: { type: String, default: 'adaptive' },
  /** The fixed threshold in dBFS. Only meaningful (and only shown) in fixed mode. */
  fixedThresholdDb: { type: Number, default: -10 },
  /** Drag limits, matching the Ceiling knob's own range. */
  minDb: { type: Number, default: -24 },
  maxDb: { type: Number, default: -1 },
  /** Headroom in dB — what an adaptive-mode drag moves. */
  headroomDb: { type: Number, default: 7.0 },
  /** Drag limits, matching the Headroom knob's own range. */
  minHeadroomDb: { type: Number, default: 4 },
  maxHeadroomDb: { type: Number, default: 16 },
  /** Quantisation for both drags, matching the knobs' step. */
  step: { type: Number, default: 0.5 },
  accent: { type: String, default: '#ff8f6b' },
  height: { type: Number, default: 220 },
  /** Canvas is opaque to a screen reader; this is what names it. */
  title: { type: String, default: 'Clipper scope' },
})

const emit = defineEmits(['update:fixedThresholdDb', 'update:headroomDb', 'requestPlay'])

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

/**
 * Columns in the lookahead half.
 *
 * Fixed rather than derived from the ring's own resolution: the ring's column
 * is one render quantum because that is what the kernel reports, which at any
 * sample rate is far finer than the face is wide. 512 is more than a pixel per
 * column on any panel width this window reaches, and it bounds the per-frame
 * scan of the timeline at a known cost.
 */
const LOOKAHEAD_COLUMNS = 512

// Scratch for the history half, so a frame that reads the ring does not
// allocate. Sized for the largest ring any sample rate produces over the
// window — one column per 128 samples, 6000 at 192 kHz — with room to spare.
const histScratch = new Float32Array(8192)

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

  // The face itself is always painted at full strength. Staleness is expressed
  // per band now (see `frozen` below), because the picture is no longer
  // necessarily stale when the kernel is: the timeline half keeps moving.
  ctx.globalAlpha = 1
  ctx.fillStyle = '#08060a'
  ctx.fillRect(0, 0, w, h)

  const mid = h / 2
  const half = mid - 2

  drawGrid(ctx, w, mid, half)

  // Where the threshold IS, right now — one number, not a history.
  //
  // In fixed mode it is read straight from the prop rather than from the scope
  // ring, so the line is live before playback has ever started and during a
  // drag with the transport stopped. In adaptive mode it can only come from the
  // kernel: it is speechLevel + Headroom, and speechLevel is a measurement this
  // component has no way to compute.
  //
  // The ring still carries a threshold for every point, and only the newest is
  // read now. That is deliberate rather than an oversight: it costs 8 floats a
  // message, it is what makes the kernel's own "did this peak cross" pairing
  // testable, and it is what a trace would need if one is ever wanted again.
  const latestT = scope && scope.filled > 0
    ? scope.threshold[(scope.head - 1 + scope.capacity) % scope.capacity]
    : null
  const thresholdLin = isFixed.value ? dbToLin(props.fixedThresholdDb) : latestT

  // ── The two halves of the face ──
  //
  // The playhead sits at the CENTRE, not at the right-hand edge, and that is
  // the whole layout. A scope that ends at "now" puts every event on a conveyor
  // moving away from the only place you are listening; a centred playhead gives
  // the eye a fixed point to read against, and it is the one thing this display
  // was missing when the question "which part am I hearing" came up.
  //
  // Left of centre is the kernel's own ring: audio that has been through the
  // stage, with the reduction it actually took. Right of centre is audio the
  // transport has not reached yet, read straight from the timeline — the effect
  // cannot supply it, because it has not seen it.
  //
  // THE HISTORY FALLS BACK TO THE TIMELINE WHENEVER THE RING IS NOT LIVE, and
  // that is not a nicety. Reported from use: bypass the stage and the left half
  // freezes while the right half keeps scrolling, because a bypassed effect is
  // out of circuit and its ring stops filling. Two sources is an implementation
  // fact; on screen this is ONE waveform travelling past a playhead, and half of
  // it stopping while the other half moves is simply broken. The same applies
  // with the transport stopped: dragging the playhead should slide the whole
  // picture, not only the part ahead of it.
  //
  // The fallback is drawn at the prediction alpha, so what is measured and what
  // is merely read off the file still look different — the brightness says
  // "the stage did this" versus "the stage would do this", which is exactly the
  // distinction bypass is being used to investigate.
  const centreX = Math.round(w / 2)
  const halfSeconds = props.windowSeconds / 2
  const PREDICTED_ALPHA = 0.45

  const future = props.envelopeFn?.(0, halfSeconds, LOOKAHEAD_COLUMNS) ?? null
  const ringLive = live && scope && scope.filled > 0
  const behind = ringLive ? null : (props.envelopeFn?.(-halfSeconds, halfSeconds, LOOKAHEAD_COLUMNS) ?? null)

  // Both halves share one seconds-per-pixel, which is what makes the picture
  // read as a single timeline with a marker on it rather than as two panes.
  const historyColumns = scope ? scope.capacity : 0
  const histStep = centreX / Math.max(1, historyColumns - 1)
  const futStep = (w - centreX) / Math.max(1, LOOKAHEAD_COLUMNS - 1)
  const behindStep = centreX / Math.max(1, LOOKAHEAD_COLUMNS - 1)

  // Drawn from the centre LEFTWARDS, so a partly filled ring is short rather
  // than stretched. The old full-width layout compressed a partial history
  // across the whole face, which was right when the newest sample owned the
  // right edge and is wrong now: the playhead is a fixed reference, and a
  // picture that slides under it while the buffer fills would undo that.
  const haveRing = scope !== null && scope.filled > 0
  // Frozen: no live kernel data AND no timeline to fall back on. Only then does
  // the old behaviour apply — the last picture left up but dimmed, because a
  // stopped scroll is still the truth about the moment it stopped and a blank
  // panel reads as broken.
  const frozen = !ringLive && !behind

  if (ringLive || (frozen && haveRing)) {
    const m = Math.min(scope.filled, historyColumns, histScratch.length)
    const start = (scope.head - m + scope.capacity) % scope.capacity
    for (let i = 0; i < m; i++) histScratch[i] = scope.peak[(start + i) % scope.capacity]
    drawBand(ctx, histScratch, m, centreX - (m - 1) * histStep, histStep, mid, half,
      thresholdLin, ringLive ? 1 : 0.35)
  } else if (behind) {
    drawBand(ctx, behind, LOOKAHEAD_COLUMNS, centreX - (LOOKAHEAD_COLUMNS - 1) * behindStep,
      behindStep, mid, half, thresholdLin, PREDICTED_ALPHA)
  }

  // Idle means the stage has never passed audio, which is what the label offers
  // to fix. Deliberately NOT tied to whether anything is on the face: the
  // timeline fallback can fill the whole window before a note has been played,
  // and the panel's one play affordance should not disappear because of it.
  isIdle.value = !haveRing

  // The lookahead is shaded against the CURRENT threshold, which is the same
  // rule the history already follows (see drawBand) — so it answers "what will
  // this setting do to what is coming", and dragging the line re-shades it live.
  // Dimmed because it is a prediction: in adaptive mode the tracker will have
  // moved by the time that audio arrives.
  if (future) drawBand(ctx, future, LOOKAHEAD_COLUMNS, centreX, futStep, mid, half, thresholdLin, PREDICTED_ALPHA)

  ctx.globalAlpha = frozen ? 0.35 : 1
  drawThresholdLine(ctx, w, mid, half, thresholdLin)
  ctx.globalAlpha = 1

  drawPlayhead(ctx, centreX, h)

  if (isIdle.value) {
    ctx.globalAlpha = 1
    drawIdleLabel(ctx, w, mid)
    if (isFixed.value) drawThresholdChip(ctx, w, mid, half, thresholdLin)
    return
  }

  drawLegend(ctx, w, h)
  drawThresholdChip(ctx, w, mid, half, thresholdLin)
}

/**
 * One half of the face: the grey envelope, and the part of it standing above
 * the threshold in accent.
 *
 * Two passes over the same points. Drawing the whole envelope accent-coloured
 * wherever it clips would exaggerate the effect wildly — 0.3 dB of reduction
 * would light a full-height transient.
 *
 * THE EXCESS IS MEASURED AGAINST THE CURRENT THRESHOLD, NOT THE ONE IN FORCE AT
 * EACH POINT. This follows from drawing the threshold flat: shading a peak that
 * sits below the drawn line, because the line was lower when that peak arrived,
 * makes the picture contradict itself, and a self-contradictory display is worse
 * than a slightly ahistorical one.
 *
 * What it costs is small and what it buys is large. The cost: for older parts of
 * the window the shading is what the CURRENT setting would have done, not what
 * was done — negligible in fixed mode (the threshold only moves when dragged)
 * and small in adaptive (a 3 s tracker barely moves inside a 2 s half-window).
 * The gain: dragging the line re-shades the whole picture live, so the display
 * answers "what would this setting have done" while the hand is still moving.
 * That is what makes it a control surface rather than a readout.
 */
function drawBand(ctx, peaks, n, x0, xStep, mid, half, thresholdLin, alpha) {
  if (n <= 0) return
  const xAt = (i) => x0 + i * xStep
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha = prevAlpha * alpha

  ctx.fillStyle = 'rgba(200,205,215,.55)'
  ctx.beginPath()
  ctx.moveTo(x0, mid)
  for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), mid - ampToUnit(peaks[i]) * half)
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(xAt(i), mid + ampToUnit(peaks[i]) * half)
  ctx.closePath()
  ctx.fill()

  if (thresholdLin === null) { ctx.globalAlpha = prevAlpha; return }

  // ONE CLOSED POLYGON PER RUN OF CROSSING COLUMNS, never one path across the
  // whole band. See crossingRuns for what a single shared path did instead.
  const tY = ampToUnit(thresholdLin) * half
  // Each column stands for a slice of time, not an instant, so a run is widened
  // by half a column at each end. Without it a single-column crossing — which is
  // most of them, at 0.3-0.4 dB on real speech — is a zero-width polygon and
  // draws nothing at all: the commonest event on this stage would be invisible.
  const pad = Math.max(xStep / 2, 0.5)
  ctx.fillStyle = props.accent
  for (const [from, to] of crossingRuns(peaks, 0, n, n, thresholdLin)) {
    for (const sign of [-1, 1]) {
      const yT = mid + sign * tY
      ctx.beginPath()
      ctx.moveTo(xAt(from) - pad, yT)
      for (let i = from; i <= to; i++) ctx.lineTo(xAt(i), mid + sign * ampToUnit(peaks[i]) * half)
      ctx.lineTo(xAt(to) + pad, yT)
      ctx.closePath()
      ctx.fill()
    }
  }

  ctx.globalAlpha = prevAlpha
}

/**
 * The playhead: where the transport is, now.
 *
 * WHITE, NOT THE ACCENT AND NOT THE WAVEFORM'S RED. On this face every orange
 * pixel means "this is being removed", so a marker in the accent colour would
 * be the one orange thing on screen that does not mean that. The main
 * waveform's own playhead red sits close enough to the accent to read as a
 * variation of it at a glance. White belongs to neither trace, which is exactly
 * what a cursor should be.
 *
 * Full height with a head at the top only: the line says where, the head says
 * it is a marker rather than a feature of the signal. Top only because the
 * bottom of the face carries the legend, and a marker sitting in the middle of
 * the mode hint would collide with it on a narrow panel — the same reason the
 * main waveform's playhead wears its head in the ruler gutter.
 */
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

/**
 * The threshold: a straight line at its CURRENT value, mirrored top and bottom.
 *
 * IT USED TO BE DRAWN AS A CURVE OVER TIME, from the kernel's own per-point
 * values, and that was the wrong call. The argument for it was that the
 * threshold really does move in adaptive mode and a trace is the only way to
 * see it move — true, but it answers a question about the DETECTOR when the
 * user is asking a question about their SETTING. Reported directly: the trail
 * reads as confusing rather than informative, because a wobbling line invites
 * you to interpret every wobble, and none of the wobbles are yours.
 *
 * A flat line says the one thing that is actually actionable — here is where
 * the ceiling is now — and it still moves, in real time, so the adaptive
 * behaviour remains visible as motion. What is genuinely lost is the HISTORY of
 * that motion: the warm-up, where the threshold parks above full scale and the
 * stage deliberately does nothing, is now a line that starts off the top of the
 * face and drops in, rather than a trace showing where it had been.
 */
function drawThresholdLine(ctx, w, mid, half, thresholdLin) {
  if (thresholdLin === null) return
  const dy = ampToUnit(thresholdLin) * half
  ctx.strokeStyle = props.accent
  // Full strength in both modes — it is a handle in both. It used to be drawn
  // faint in adaptive mode to say "readout, not control", which was the
  // display's own explanation of a restriction that turned out to be wrong.
  ctx.lineWidth = 2
  ctx.beginPath()
  for (const sign of [-1, 1]) {
    const y = mid + sign * dy
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()
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

  // Mode hint on the same line, right-aligned — it says what a drag on the
  // curve will do, which differs by mode, and carries the Headroom value in
  // adaptive mode because that number now lives on the display rather than
  // only on a knob.
  ctx.textAlign = 'right'
  if (isFixed.value) {
    ctx.fillStyle = 'rgba(255,255,255,.3)'
    ctx.fillText('DRAG THE LINE — SETS THE CEILING', w - 6, y)
  } else {
    const hr = `${props.headroomDb > 0 ? '+' : ''}${props.headroomDb.toFixed(1)}`
    ctx.fillStyle = props.accent
    ctx.fillText(hr, w - 6, y)
    const hrW = ctx.measureText(hr).width
    ctx.fillStyle = 'rgba(255,255,255,.3)'
    ctx.fillText('DRAG THE LINE — SETS HEADROOM', w - 10 - hrW, y)
  }
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
function drawThresholdChip(ctx, w, mid, half, thresholdLin) {
  if (thresholdLin === null) return
  const label = `${linToDb(thresholdLin).toFixed(1)} dB`

  ctx.font = "700 10px 'JetBrains Mono',monospace"
  const tw = ctx.measureText(label).width
  const cw = tw + 24
  const ch = 17
  const cx = w - cw - 5
  // Clamped so the chip stays on the face during the warm-up, when the
  // threshold deliberately sits above full scale.
  const cy = Math.min(mid - ch - 1, Math.max(1, mid - ampToUnit(thresholdLin) * half - ch / 2))

  ctx.fillStyle = '#08060a'
  ctx.strokeStyle = props.accent
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(cx + 0.5, cy + 0.5, cw, ch, 8)
  ctx.fill()
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.fillStyle = props.accent
  ctx.textAlign = 'left'
  ctx.fillText(label, cx + 8, cy + 12)

  // Grip, in both modes — the curve is a handle in both, and the grip is what
  // says so before anyone tries.
  ctx.globalAlpha = 0.65
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(cx + cw - 12, cy + 5 + i * 3, 7, 1.5)
  }
  ctx.globalAlpha = 1
}

// ── Drag, fixed mode only ───────────────────────────────────────────────────

/**
 * The dB the pointer is sitting at, unclamped.
 *
 * Symmetric about the centre: grabbing either the upper or the lower trace
 * reads the same value, because they are two views of one number.
 */
function yToDbRaw(clientY) {
  const canvas = canvasEl.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const mid = rect.height / 2
  const half = mid - 2
  const unit = Math.min(1, Math.abs(clientY - rect.top - mid) / half)
  return linToDb(unitToAmp(unit))
}

const quantize = (v) => Math.round(v / props.step) * props.step
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Where an adaptive drag started, so the movement can be applied as an offset
// rather than as an absolute position — see the file header.
let dragStartDb = 0
let dragStartHeadroom = 0

function applyDrag(clientY) {
  const db = yToDbRaw(clientY)
  if (db === null) return
  if (isFixed.value) {
    emit('update:fixedThresholdDb', clamp(quantize(db), props.minDb, props.maxDb))
  } else {
    const moved = db - dragStartDb
    emit('update:headroomDb', clamp(
      quantize(dragStartHeadroom + moved), props.minHeadroomDb, props.maxHeadroomDb,
    ))
  }
}

function onPointerDown(e) {
  // The idle label is a button. It is the first thing anyone reads on this
  // panel and the only instruction it gives, so it should carry out that
  // instruction rather than merely state it.
  //
  // Only the label itself is a button, though. In fixed mode the rest of an
  // idle face is still the control surface — the ceiling exists whether or not
  // audio is running, and having to press play before you can set it would be
  // an arbitrary gate. Adaptive has nothing to offer here: its threshold is a
  // measurement plus an offset, and there is no measurement yet.
  if (isIdle.value) {
    const rect = canvasEl.value?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    if (
      x >= idleHit.x && x <= idleHit.x + idleHit.w &&
      y >= idleHit.y && y <= idleHit.y + idleHit.h
    ) {
      emit('requestPlay')
      return
    }
    if (!isFixed.value) return
  }
  canvasEl.value?.setPointerCapture?.(e.pointerId)
  dragStartDb = yToDbRaw(e.clientY) ?? 0
  dragStartHeadroom = props.headroomDb
  // Fixed mode jumps to the pointer on press; adaptive does not, because there
  // is nothing absolute to jump to — the first movement is what carries the
  // change.
  if (isFixed.value) applyDrag(e.clientY)
}

function onPointerMove(e) {
  // Only while captured — `buttons` is 0 on a hover, so this needs no separate
  // dragging flag.
  if (e.buttons === 0) return
  if (isIdle.value && !isFixed.value) return
  applyDrag(e.clientY)
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
      :style="{ cursor: isIdle && !isFixed ? 'pointer' : 'ns-resize' }"
      :aria-label="title"
      role="img"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    ></canvas>
  </div>
</template>
