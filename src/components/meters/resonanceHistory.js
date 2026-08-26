/**
 * Rolling spectral history for the resonance display's two overlays.
 *
 * The panel's default view (design 1c) shows nothing but what is being removed.
 * Two optional overlays fold context back in, and both are the same shape — a
 * waterfall on the display's own 192-point log-frequency grid, scrolling down,
 * newest row at the top:
 *
 *   HISTORY   the CARVED signal: output level per bin, with the moments a cut
 *             actually landed lit up. This is the grooves the plugin has been
 *             cutting over the last few seconds, and it is the overlay that
 *             answers "is it working the same band over and over".
 *
 *   SPECTRO   the INPUT spectrum, untouched. What the file has, regardless of
 *             what the effect is doing about it.
 *
 * ⚠ THE TWO ARE DIFFERENT PICTURES, AND IN THE SOURCE DESIGN THEY WERE NOT.
 * Design 1a's underlay and 1c's DETAIL "spectrum" are the same input waterfall
 * at two opacities; there was no carved-history overlay outside 1b's lower lane
 * and 1c's own 38 px strip. Splitting them this way was a deliberate call —
 * two overlays drawing the same buffer at different alpha is one control too
 * many, and for a suppressor the carve is the more interesting of the two.
 *
 * WHY CANVASES RATHER THAN A NUMERIC RING BUFFER. Repainting 368 columns of
 * 192 bins from numbers every frame is ~70k fills; scrolling an offscreen
 * canvas by one pixel and writing a single new row is two operations and a
 * row. The cost is that what is already drawn cannot be re-coloured — the
 * pixels no longer know what level produced them — so a change of accent would
 * otherwise leave the buffer two-toned, old rows in the previous accent and new
 * ones in the current. `reshape` discards on an accent change for that reason,
 * which is the honest option: eight seconds of history is cheap to lose and a
 * two-toned waterfall reads as the effect having changed behaviour.
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

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Brightness ramp, built from the panel's accent rather than imported.
 *
 * The source design ships a five-stop heat ramp running teal → mint → amber →
 * red. Bringing that in would put a second palette on a faceplate that takes
 * its accent as a prop and is amber today, so the ramp is generated from
 * whatever accent it is given: plate → a third of the way up → the accent →
 * near-white at the very top. Monochrome also keeps the carve overlay's cut
 * marks (pure white) as the only thing on the plot that is not the accent,
 * which is what makes them read as events rather than as loud bins.
 */
export function rampStops(accent) {
  const [r, g, b] = hexToRgb(accent)
  // WEIGHTED DARK, and that is calibration rather than taste. Per-bin speech sits
  // around -35 dBFS, which is 0.7-0.8 of this window — so a ramp that reaches
  // full accent by 0.7 paints most of the plot at full accent, and the waterfall
  // stops being ground and starts competing with the trace it sits behind. Seen
  // exactly that on the first render. The stops below hold under a third of the
  // accent until 0.66 and only saturate in the top tenth, which is the same
  // proportion the source design's heat ramp uses.
  const mix = (f, add = 0) => [
    Math.min(255, Math.round(r * f) + add),
    Math.min(255, Math.round(g * f) + add),
    Math.min(255, Math.round(b * f) + add),
  ]
  return [
    [0, [8, 10, 13]],
    [0.40, mix(0.14, 6)],
    [0.66, mix(0.34)],
    [0.86, mix(0.78)],
    [1, mix(1, 55)],
  ]
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
 * The two waterfalls, and the scroll that feeds them.
 *
 * Recorded CONTINUOUSLY, whether or not an overlay is showing. An overlay
 * switched on to a blank plot is an overlay that cannot answer the question it
 * was switched on for, and the whole cost of keeping it filled is two 192x368
 * canvases and one row of fills every 22 ms.
 */
export class ResonanceHistory {
  constructor(bins, accent) {
    this.bins = bins
    this.accent = accent
    this.stops = rampStops(accent)
    this.acc = 0
    this.carve = makeBuffer(bins, HISTORY_COLS)
    this.spectro = makeBuffer(bins, HISTORY_COLS)
  }

  /** Rebuild for a new bin count, or a new accent. Both discard what is held. */
  reshape(bins, accent) {
    if (bins === this.bins && accent === this.accent) return
    this.bins = bins
    this.accent = accent
    this.stops = rampStops(accent)
    this.carve = makeBuffer(bins, HISTORY_COLS)
    this.spectro = makeBuffer(bins, HISTORY_COLS)
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
    const s = this.spectro.getContext('2d')
    c.drawImage(this.carve, 0, 1)
    s.drawImage(this.spectro, 0, 1)
    for (let i = 0; i < bins; i++) {
      s.fillStyle = sampleRamp(this.stops, historyLevel(mag[i]))
      s.fillRect(i, 0, 1, 1)
      // The carve is the OUTPUT — what survived — so a band being worked shows
      // as a dark groove opening up over time rather than as a bright streak.
      c.fillStyle = sampleRamp(this.stops, historyLevel(mag[i] - reduction[i]))
      c.fillRect(i, 0, 1, 1)
      if (reduction[i] > HISTORY_CUT_DB) {
        // And the moment of the cut is marked white over that groove, which is
        // the half a plain output waterfall cannot say: a band that is simply
        // quiet looks identical to one being suppressed.
        c.fillStyle = `rgba(255,255,255,${Math.min(0.8, reduction[i] / 9)})`
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
