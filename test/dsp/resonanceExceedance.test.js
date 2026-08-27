/**
 * Which part of the input is over the detection threshold, and where exactly it
 * crosses.
 *
 * This is the shaded region in the SPECTRUM overlay, and it is the smallest
 * thing on the plot — a few pixels tall at 3 px per dB — so every failure mode
 * here looks like a working display. A run one bin wide of the truth, a taper
 * that starts at the wrong place, a fill that appears on a peak the detector is
 * ignoring: all of them draw something plausible.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXCEEDANCE_MIN_DB,
  findExceedanceRuns,
} from '../../src/components/meters/resonanceMarks.js'

/** A flat threshold at `db`, which is what most of these probes want. */
const flat = (bins, db) => new Float32Array(bins).fill(db)

test('nothing over the line is no runs', () => {
  const mag = [0, 1, 2, 1, 0]
  assert.deepEqual(findExceedanceRuns(mag, flat(5, 5), 5), [])
})

test('one peak is one run, bounded by the bins that are actually over', () => {
  const mag = [0, 0, 4, 8, 4, 0, 0]
  const runs = findExceedanceRuns(mag, flat(7, 2), 7)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].startBin, 2)
  assert.equal(runs[0].endBin, 4)
})

test('the crossings are interpolated, and they land ON the threshold', () => {
  // The whole point of the taper: at a crossing the two curves meet, so the
  // shaded shape must close to a point there. Snapping to the nearest bin opens
  // it with a vertical step — on a 3 px feature, most of what gets drawn.
  const mag = [0, 0, 4, 8, 4, 0, 0]
  const [run] = findExceedanceRuns(mag, flat(7, 2), 7)
  // Between bin 1 (0 dB) and bin 2 (4 dB), the 2 dB line is crossed halfway.
  assert.equal(run.startPos, 1.5)
  assert.equal(run.endPos, 4.5)
  assert.equal(run.startDb, 2)
  assert.equal(run.endDb, 2)
})

test('an asymmetric crossing is placed proportionally, not at the midpoint', () => {
  // Mutation guard: `pos = bin - 0.5` passes the symmetric case above and is
  // wrong everywhere else.
  const mag = [0, 12, 0]
  const [run] = findExceedanceRuns(mag, flat(3, 3), 3)
  assert.equal(run.startPos, 0.25)
  assert.equal(run.endPos, 1.75)
  assert.equal(run.startDb, 3)
})

test('two separated peaks are two runs', () => {
  const mag = [0, 6, 0, 0, 6, 0]
  const runs = findExceedanceRuns(mag, flat(6, 2), 6)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map(r => r.startBin), [1, 4])
})

test('one bin dipping back under splits a run rather than bridging it', () => {
  const mag = [0, 6, 1, 6, 0]
  const runs = findExceedanceRuns(mag, flat(5, 2), 5)
  assert.equal(runs.length, 2)
})

test('a run touching either end is clamped there rather than extrapolated', () => {
  // There is no crossing off the edge of the analysed band, and inventing one
  // draws a taper that is not in the data.
  const mag = [8, 8, 0, 0, 8, 8]
  const runs = findExceedanceRuns(mag, flat(6, 2), 6)
  assert.equal(runs[0].startPos, 0)
  assert.equal(runs[0].startDb, 8)
  assert.equal(runs[1].endPos, 5)
  assert.equal(runs[1].endDb, 8)
})

test('the whole band over the line is a single clamped run', () => {
  const mag = [8, 9, 8, 9]
  const runs = findExceedanceRuns(mag, flat(4, 2), 4)
  assert.equal(runs.length, 1)
  assert.deepEqual([runs[0].startBin, runs[0].endBin], [0, 3])
  assert.deepEqual([runs[0].startPos, runs[0].endPos], [0, 3])
})

test('a crossing shallower than the floor draws nothing', () => {
  // Below one pixel the fill is thinner than the strokes around it, so it reads
  // as noise on the input curve rather than as a finding.
  const shallow = [0, EXCEEDANCE_MIN_DB / 2, 0]
  assert.deepEqual(findExceedanceRuns(shallow, flat(3, 0), 3), [])

  const deep = [0, EXCEEDANCE_MIN_DB * 2, 0]
  assert.equal(findExceedanceRuns(deep, flat(3, 0), 3).length, 1)
})

test('the floor is on the run PEAK, not on every bin of it', () => {
  // A broad resonance has shallow flanks. Testing each bin against the floor
  // would clip the run to its tip, which is exactly where the taper belongs.
  const mag = [0, 0.4, 4, 0.4, 0]
  const [run] = findExceedanceRuns(mag, flat(5, 0.2), 5)
  assert.equal(run.startBin, 1)
  assert.equal(run.endBin, 3)
})

test('the threshold is read per bin, so a staircase is followed', () => {
  // Selectivity is per zone, so the line steps. A run found against a single
  // averaged threshold would shade the wrong side of a boundary.
  const mag = new Float32Array([5, 5, 5, 5])
  const stepped = new Float32Array([2, 2, 8, 8])
  const runs = findExceedanceRuns(mag, stepped, 4)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].startBin, 0)
  assert.equal(runs[0].endBin, 1)
})

test('a degenerate frame is not a run', () => {
  assert.deepEqual(findExceedanceRuns([], flat(0, 0), 0), [])
  assert.deepEqual(findExceedanceRuns([9], flat(1, 0), 1), [])
})

test('a run at the last bin clamps even when the buffers are oversized', () => {
  // ⚠ The display reuses its frame buffers and sizes them for the largest bin
  // count it has seen, so `mag.length` is not the end of the band. Bounding on
  // it interpolates toward a stale value from an earlier, wider frame and draws
  // a taper this frame has no evidence for.
  const mag = new Float32Array(8)
  mag.set([0, 0, 8, 8])
  const threshold = new Float32Array(8).fill(2)
  const [run] = findExceedanceRuns(mag, threshold, 4)
  assert.equal(run.endBin, 3)
  assert.equal(run.endPos, 3)
  assert.equal(run.endDb, 8)
})
