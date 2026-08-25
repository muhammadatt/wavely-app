import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HISTORY_COLS,
  HISTORY_ROW_MS,
  HISTORY_SECONDS,
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
  const stops = rampStops('#e8a33d')
  const at = db => sampleRamp(stops, historyLevel(db))
  assert.equal(at(-200), at(-95), 'below the window is the floor colour')
  assert.equal(at(0), at(-25), 'above the window is the top colour')
  // and the middle is genuinely between them rather than clamped to either
  const mid = at(-60)
  assert.notEqual(mid, at(-95))
  assert.notEqual(mid, at(-25))
})

test('the ramp rises monotonically with level', () => {
  const stops = rampStops('#e8a33d')
  const lum = db => {
    const m = sampleRamp(stops, historyLevel(db)).match(/\d+/g).map(Number)
    return m[0] + m[1] + m[2]
  }
  let prev = -Infinity
  for (let db = -95; db <= -25; db += 5) {
    const v = lum(db)
    assert.ok(v >= prev, `luminance fell at ${db} dBFS`)
    prev = v
  }
})

test('THE RAMP IS BUILT FROM THE ACCENT, not from the source design palette', () => {
  // The design ships a teal-to-red heat ramp. This faceplate takes its accent as
  // a prop, so importing that would put a second palette on the panel; the ramp
  // is generated instead, and has to actually follow the accent it is given.
  const amber = sampleRamp(rampStops('#e8a33d'), 0.9).match(/\d+/g).map(Number)
  const blue = sampleRamp(rampStops('#3d7de8'), 0.9).match(/\d+/g).map(Number)
  assert.ok(amber[0] > amber[2], 'an amber accent should ramp warm')
  assert.ok(blue[2] > blue[0], 'a blue accent should ramp cool')
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
