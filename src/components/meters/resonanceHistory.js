/**
 * Rolling spectral history for the resonance display's HISTORY overlay.
 *
 * The panel's default view (design 1c) shows nothing but what is being removed.
 * HISTORY folds the last few seconds back in as a waterfall on the display's own
 * 192-point log-frequency grid, scrolling down, newest row at the top: the
 * CARVED signal, output level per bin, with the moments a cut actually landed
 * lit up. It is the grooves the plugin has been cutting, and it is what answers
 * "is it working the same band over and over".
 *
 * ⚠ THERE WAS A SECOND WATERFALL HERE — SPECTRO, the untouched input — AND IT
 * IS GONE. Design 1a's underlay and 1c's DETAIL "spectrum" are that same input
 * waterfall at two opacities, so it was the design's own overlay; it was
 * dropped because the question it answers ("what does the file have") is
 * answered better by the input spectrum CURVE, live and against a level axis,
 * which is what the SPECTRUM overlay now draws. A waterfall of the input says
 * roughly the same thing a second later and without a number on it.
 *
 * WHY CANVASES RATHER THAN A NUMERIC RING BUFFER. Repainting 368 columns of
 * 192 bins from numbers every frame is ~70k fills; scrolling an offscreen
 * canvas by one pixel and writing a single new row is two operations and a
 * row. The cost of that choice is that history cannot be re-coloured after the
 * fact — a repaint would only reach new columns. Nothing needs to: the ramp is
 * a fixed table (see HEAT_STOPS), so the only thing that discards the buffer is
 * a change in bin count.
 *
 * The arithmetic that decides WHAT gets drawn lives here as pure functions so
 * it can be tested without a canvas, the same split `resonanceZoneEdit` and
 * `selectionDrag` use. Only `ResonanceHistory` itself needs a DOM.
 */

/**
 * How far back the overlays reach.
 *
 * Long enough that a resonance which fires once a phrase leaves a visible
 * repeat, short enough that the newest rows are still most of the picture. The
 * span is held in TIME rather than in frames: the kernel posts at ~46 Hz but
 * the display reads on an animation frame, so counting frames would make the
 * span depend on the refresh rate of the monitor.
 */
export const HISTORY_SECONDS = 8
/** Rows in the buffer. One per ~21.7 ms at the span above. */
export const HISTORY_COLS = 368
/** Milliseconds of signal each row stands for. */
export const HISTORY_ROW_MS = (HISTORY_SECONDS * 1000) / HISTORY_COLS

/**
 * dBFS window the waterfall's brightness ramp spans.
 *
 * NOT the spectrum curve's window, and deliberately. The curve is drawn against
 * -102..-12 so that a per-bin level reads at its true dBFS and a tone lands
 * where the numerals say. A waterfall has no numerals — it is texture — so its
 * window is chosen for contrast instead: per-bin speech peaks sit near -35 and
 * the noise floor near -85, and -95..-25 puts that across most of the ramp
 * rather than crushing it into the middle third.
 */
export const HISTORY_DB_MIN = -95
export const HISTORY_DB_MAX = -25

/**
 * Reduction, in dB, below which a column is not marked as a cut.
 *
 * The same 0.3 dB the reduction trace, the per-zone readouts and the hotspot
 * line use, so every part of the display starts saying something on the same
 * frame.
 */
export const HISTORY_CUT_DB = 0.3

/** Level to ramp position. Gamma lifts the quiet half, which is most of speech. */
export function historyLevel(db, minDb = HISTORY_DB_MIN, maxDb = HISTORY_DB_MAX) {
  const t = (db - minDb) / (maxDb - minDb)
  return Math.pow(t < 0 ? 0 : t > 1 ? 1 : t, 1.2)
}

/**
 * THE BRIGHTNESS RAMP IS THE DESIGN BRIEF'S HEAT RAMP, teal → mint → amber →
 * red, and it used to be generated from the panel's accent instead.
 *
 * The argument for generating it was that importing a five-stop heat ramp puts
 * a second palette on a faceplate that takes its accent as a prop. True, and
 * the brief answers it: the accent this panel is given IS the ramp's mint
 * (`--plugin-resonance`, #8de0a8, the brief's MINT), so the ramp does not
 * introduce a second hue family — it extends the one already there past the top
 * of the accent, which is what a level ramp needs and a single hue cannot do.
 * The app's own meter ladder (`--meter-cool` → `--meter-hot`) is built the same
 * way, so a hot bin here now reads like a hot segment there.
 *
 * ⚠ BRIGHTNESS IS NO LONGER MONOTONE ACROSS THE WHOLE RAMP, and that is
 * inherent to a heat ramp rather than an oversight: amber and red are darker in
 * luminance than the mint below them and hotter in hue, which is the trade every
 * meter in this class makes. It rises monotonically up to the mint apex, which
 * covers everything below -30 dBFS — the whole of speech and all of the floor —
 * and only the top ~5% of the window trades brightness for warmth.
 *
 * THE STOP POSITIONS ARE OURS, NOT THE BRIEF'S, and that is calibration rather
 * than taste. Per-bin speech sits around -35 dBFS, which is 0.7-0.8 of this
 * window, so the brief's ramp — full mint by 0.78 — would paint most of the plot
 * at full mint and the waterfall would stop being ground and start competing
 * with the trace it sits behind. Seen exactly that on the first render of the
 * generated ramp, which is why the positions below hold the deep teals until
 * 0.68 and reach mint only at 0.88. The brief's own colours, at our measured
 * levels.
 */
export const HEAT_STOPS = [
  [0, [8, 10, 13]],
  [0.42, [16, 32, 38]],
  [0.68, [26, 74, 84]],
  [0.88, [111, 214, 192]],
  [0.95, [124, 224, 168]],
  [0.985, [232, 163, 61]],
  [1, [255, 90, 78]],
]

/** Where the ramp stops gaining brightness and starts gaining heat. */
export const HEAT_APEX = 0.95

/**
 * The ramp, as a fixed table.
 *
 * Kept as a function rather than exported as the array alone so the call sites
 * read the same as they did when it was derived, and so a future panel that
 * wants its own ramp has one place to branch.
 */
export function rampStops() {
  return HEAT_STOPS
}

/**
 * Ink for the white-hot mark over a bin that was cut this row.
 *
 * The brief's value: the pale mint end of the ramp rather than pure white, so
 * the marks sit in the same palette as everything else on the plate while still
 * being the only thing on the waterfall that is brighter than its own hot end.
 */
export function cutMark(reductionDb) {
  return `rgba(205,244,220,${Math.min(0.85, reductionDb / 8)})`
}

/** Sample a ramp built by rampStops. Returns a canvas fillStyle string. */
export function sampleRamp(stops, t) {
  const v = t < 0 ? 0 : t > 1 ? 1 : t
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [p0, c0] = stops[k - 1]
      const [p1, c1] = stops[k]
      const u = p1 === p0 ? 0 : (v - p0) / (p1 - p0)
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * u)},`
        + `${Math.round(c0[1] + (c1[1] - c0[1]) * u)},`
        + `${Math.round(c0[2] + (c1[2] - c0[2]) * u)})`
    }
  }
  const last = stops[stops.length - 1][1]
  return `rgb(${last[0]},${last[1]},${last[2]})`
}

/**
 * How many rows a given elapsed time owes, and what is left over.
 *
 * Split out because it is the one part of the scroll that can be wrong in a way
 * nobody sees: dropping the remainder each frame makes the history run slow by
 * up to a row per frame, which at 60 Hz is a 30% error in the span the label
 * claims. Capped so a backgrounded tab returning with a dt of seconds redraws a
 * bounded number of rows instead of the whole buffer.
 */
export function rowsDue(accMs, rowMs = HISTORY_ROW_MS, maxRows = 8) {
  if (!(accMs > 0) || !(rowMs > 0)) return { rows: 0, rest: accMs > 0 ? accMs : 0 }
  const rows = Math.floor(accMs / rowMs)
  if (rows <= maxRows) return { rows, rest: accMs - rows * rowMs }
  // Over the cap the backlog is dropped rather than carried: it represents time
  // the display was not running, and drawing it would paint a block of whatever
  // the last frame held across a span it never described.
  return { rows: maxRows, rest: 0 }
}

/**
 * The waterfall, and the scroll that feeds it.
 *
 * Recorded CONTINUOUSLY, whether or not the overlay is showing. An overlay
 * switched on to a blank plot is an overlay that cannot answer the question it
 * was switched on for, and the whole cost of keeping it filled is one 192x368
 * canvas and one row of fills every 22 ms.
 */
export class ResonanceHistory {
  constructor(bins) {
    this.bins = bins
    this.stops = rampStops()
    this.acc = 0
    this.carve = makeBuffer(bins, HISTORY_COLS)
  }

  /** Rebuild for a new bin count. Discards what is held. */
  reshape(bins) {
    if (bins === this.bins) return
    this.bins = bins
    this.carve = makeBuffer(bins, HISTORY_COLS)
    this.acc = 0
  }

  /**
   * Advance by `dtMs` and write however many rows that owes.
   *
   * The same row is repeated when more than one is owed rather than
   * interpolating: the frame is one instant's measurement, and inventing
   * intermediate rows would draw a smoother history than was observed.
   */
  advance(dtMs, frame) {
    if (!frame) return
    this.acc += dtMs
    const { rows, rest } = rowsDue(this.acc)
    this.acc = rest
    for (let n = 0; n < rows; n++) this.pushRow(frame)
  }

  pushRow(frame) {
    const { mag, reduction, bins } = frame
    if (bins !== this.bins) return
    const c = this.carve.getContext('2d')
    c.drawImage(this.carve, 0, 1)
    for (let i = 0; i < bins; i++) {
      // The carve is the OUTPUT — what survived — so a band being worked shows
      // as a dark groove opening up over time rather than as a bright streak.
      c.fillStyle = sampleRamp(this.stops, historyLevel(mag[i] - reduction[i]))
      c.fillRect(i, 0, 1, 1)
      if (reduction[i] > HISTORY_CUT_DB) {
        // And the moment of the cut is marked over that groove, which is the
        // half a plain output waterfall cannot say: a band that is simply quiet
        // looks identical to one being suppressed.
        c.fillStyle = cutMark(reduction[i])
        c.fillRect(i, 0, 1, 1)
      }
    }
  }
}

function makeBuffer(w, h) {
  const el = document.createElement('canvas')
  el.width = w
  el.height = h
  const g = el.getContext('2d')
  g.fillStyle = '#080a0d'
  g.fillRect(0, 0, w, h)
  return el
}
