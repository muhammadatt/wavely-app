import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_COLS,
  HISTORY_ROW_MS,
  HISTORY_SECONDS,
  cutMark,
  HEAT_APEX,
  historyLevel,
  rampStops,
  rowsDue,
  sampleRamp,
} from '../../src/components/meters/resonanceHistory.js'
import {
  MARK_MAX,
  MARK_MIN_DB,
  findResonanceMarks,
} from '../../src/components/meters/resonanceMarks.js'

/**
 * The 1c display's two overlays and its resonance marks.
 *
 * Everything here is arithmetic the canvas consumes rather than the canvas
 * itself. What it guards is the class of defect a screenshot cannot catch: a
 * history that claims 8 seconds and shows 5, a ramp that saturates before the
 * top of its range, a mark labelled at the wrong frequency.
 */

// ── History cadence ─────────────────────────────────────────────────────────

test('the history buffer spans the seconds it advertises', () => {
  assert.equal(Math.round(HISTORY_COLS * HISTORY_ROW_MS), HISTORY_SECONDS * 1000)
})

test('THE SCROLL CARRIES ITS REMAINDER, or the span runs short', () => {
  // Dropping the sub-row remainder each frame is the obvious implementation and
  // it makes the history run slow: at 60 Hz a frame is 16.7 ms against a 21.7 ms
  // row, so two frames in three would floor to zero rows and the buffer would
  // hold far more than the 8 seconds its label claims.
  let acc = 0
  let rows = 0
  const FRAMES = 600
  for (let f = 0; f < FRAMES; f++) {
    acc += 1000 / 60
    const due = rowsDue(acc)
    acc = due.rest
    rows += due.rows
  }
  const elapsedMs = (FRAMES * 1000) / 60
  const expected = elapsedMs / HISTORY_ROW_MS
  assert.ok(
    Math.abs(rows - expected) <= 1,
    `10 s of 60 Hz frames should write ${expected.toFixed(0)} rows, wrote ${rows}`,
  )
})

test('a backgrounded tab does not repaint the whole buffer on return', () => {
  // dt comes back in seconds, and the frame held across it describes one
  // instant. Drawing the backlog would paint a block of that instant over a
  // span it never described, so it is dropped rather than carried.
  const due = rowsDue(30_000)
  assert.ok(due.rows <= 8, `expected a capped burst, got ${due.rows} rows`)
  assert.equal(due.rest, 0, 'the dropped backlog must not be carried forward')
})

test('a zero or negative step writes nothing', () => {
  assert.equal(rowsDue(0).rows, 0)
  assert.equal(rowsDue(-5).rows, 0)
})

// ── History ramp ────────────────────────────────────────────────────────────

test('the ramp spans its window and saturates only at the ends', () => {
  const stops = rampStops()
  const at = db => sampleRamp(stops, historyLevel(db))
  assert.equal(at(-200), at(-95), 'below the window is the floor colour')
  assert.equal(at(0), at(-25), 'above the window is the top colour')
  // and the middle is genuinely between them rather than clamped to either
  const mid = at(-60)
  assert.notEqual(mid, at(-95))
  assert.notEqual(mid, at(-25))
})

test('the ramp rises monotonically up to the mint apex', () => {
  // THE APEX IS WHERE BRIGHTNESS STOPS AND HEAT STARTS, and the ceiling of this
  // loop is the whole point of it. A heat ramp's amber and red are DARKER than
  // the mint below them, so "louder is brighter" can only be asserted below the
  // apex — which is everything down to about -30 dBFS, i.e. the noise floor and
  // the whole of speech. See HEAT_STOPS.
  const stops = rampStops()
  // Relative luminance, not a channel sum: the sum calls the ramp's brightest
  // stop a hair darker than the one below it (517 against 516) purely because
  // it trades blue for green, which the eye reads as brighter, not darker.
  const lum = t => {
    const m = sampleRamp(stops, t).match(/\d+/g).map(Number)
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]
  }
  let prev = -Infinity
  for (let t = 0; t <= HEAT_APEX + 1e-9; t += 0.02) {
    const v = lum(t)
    assert.ok(v >= prev, `luminance fell at ramp position ${t.toFixed(2)}`)
    prev = v
  }
})

test('THE RAMP IS THE DESIGN BRIEFS HEAT RAMP, and it ends warm', () => {
  // It used to be generated from the accent, so that a faceplate taking its
  // accent as a prop could not end up carrying a second palette. The brief
  // settles that the other way: the accent this panel is given IS the ramp's
  // mint, so the heat ramp extends the accent rather than competing with it —
  // and a single hue cannot express a top end at all.
  const stops = rampStops()
  const hot = sampleRamp(stops, 1).match(/\d+/g).map(Number)
  const apex = sampleRamp(stops, HEAT_APEX).match(/\d+/g).map(Number)
  assert.ok(hot[0] > hot[1] && hot[0] > hot[2], 'the top of the ramp is red')
  assert.ok(apex[1] > apex[0] && apex[1] > apex[2], 'the apex is mint')
  // The panel's accent is the apex, to within a few levels per channel: that is
  // what makes one palette out of two.
  const [ar, ag, ab] = [0x8d, 0xe0, 0xa8]
  assert.ok(Math.abs(apex[0] - ar) < 20 && Math.abs(apex[1] - ag) < 20
    && Math.abs(apex[2] - ab) < 20, `apex ${apex} should be the plugin accent`)
})

test('the cut mark is the pale end of the ramp, and it is bounded', () => {
  assert.equal(cutMark(8), 'rgba(205,244,220,0.85)')
  assert.equal(cutMark(80), 'rgba(205,244,220,0.85)', 'a deep cut cannot exceed the cap')
  assert.ok(cutMark(1).endsWith('0.125)'), 'a shallow cut is faint')
})

// ── Resonance marks ─────────────────────────────────────────────────────────

/** A reduction curve with gaussian cuts planted at given bin positions. */
function curveWith(peaks, bins = 192) {
  const r = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    let v = 0
    for (const [bin, db, width] of peaks) {
      v += db * Math.exp(-Math.pow((i - bin) / width, 2))
    }
    r[i] = v
  }
  return r
}

test('a mark lands on the peak, and reports its frequency', () => {
  const bins = 192
  const marks = findResonanceMarks(curveWith([[96, 9, 3]]), bins, 20, 20000)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].bin, 96)
  // bin 96 of 192 on a 20 Hz - 20 kHz log axis is the geometric middle
  const expected = 20 * Math.pow(2, (96 / 191) * Math.log2(20000 / 20))
  assert.ok(
    Math.abs(marks[0].hz - expected) < 1,
    `expected ~${expected.toFixed(0)} Hz, got ${marks[0].hz.toFixed(0)}`,
  )
})

test('A BROAD CUT GETS ONE MARK, NOT ONE PER RIPPLE', () => {
  // Every shoulder of a wide resonance is a local maximum against its immediate
  // neighbours, so a plain neighbour test fills all four slots with one peak.
  const r = curveWith([[96, 9, 14]])
  for (let i = 0; i < r.length; i++) r[i] += 0.04 * Math.sin(i * 1.9)
  const marks = findResonanceMarks(r, 192, 20, 20000)
  assert.equal(marks.length, 1, `expected one mark, got ${marks.map(m => m.bin).join(', ')}`)
})

test('marks come back in frequency order however deep they are', () => {
  // The caller lays pills out left to right and alternates their vertical
  // offset to keep them from colliding; an ordering by depth makes that
  // alternation arbitrary.
  const marks = findResonanceMarks(
    curveWith([[40, 4, 3], [96, 11, 3], [150, 7, 3]]), 192, 20, 20000,
  )
  assert.deepEqual(marks.map(m => m.bin), [40, 96, 150])
})

test('only the deepest survive the cap, and shallow cuts are not named', () => {
  const marks = findResonanceMarks(
    curveWith([[20, 9, 2], [50, 8, 2], [80, 7, 2], [110, 6, 2], [140, 5, 2], [170, 4, 2]]),
    192, 20, 20000,
  )
  assert.equal(marks.length, MARK_MAX)
  assert.deepEqual(marks.map(m => m.bin), [20, 50, 80, 110])

  const quiet = findResonanceMarks(curveWith([[96, MARK_MIN_DB - 0.5, 3]]), 192, 20, 20000)
  assert.equal(quiet.length, 0, 'a cut under the floor is not a resonance worth naming')
})

test('an edge peak is not a mark', () => {
  // Same rule the F0 tracker applies: a peak with no shoulder on one side cannot
  // be shown to be a maximum of anything.
  const r = new Float32Array(192)
  r[0] = 12
  r[1] = 11
  r[191] = 12
  assert.equal(findResonanceMarks(r, 192, 20, 20000).length, 0)
})

test('an idle curve names nothing', () => {
  assert.deepEqual(findResonanceMarks(new Float32Array(192), 192, 20, 20000), [])
})
