/**
 * Precise touch selection: the magnifier (src/audio/selectionLoupe.js) and the
 * nudge buttons' step and clamping (src/audio/selectionDrag.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOUPE_GAP_PX, LOUPE_MAX_PPS, LOUPE_MIN_PPS, LOUPE_SIZE_PX, LOUPE_ZOOM,
  LOUPE_MAX_GAIN, loupeColumns, loupeGain, loupePosition, loupePps, loupeWindow,
} from '../../src/audio/selectionLoupe.js'
import { NUDGE_MAX_S, NUDGE_MIN_S, nudgeStep, nudgedSelection } from '../../src/audio/selectionDrag.js'

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

test('the loupe magnifies the view, within bounds', () => {
  assert.equal(loupePps(200), 200 * LOUPE_ZOOM)
  assert.equal(loupePps(1), LOUPE_MIN_PPS, 'zoomed out over a long file it still shows a fraction of a second')
  assert.equal(loupePps(1e6), LOUPE_MAX_PPS)
  const w = loupeWindow(10, 200)
  assert.ok(near((w.start + w.end) / 2, 10), 'centred on the edge')
  assert.ok(near(w.end - w.start, LOUPE_SIZE_PX / (200 * LOUPE_ZOOM)))
})

test('loupe columns keep each slice\'s extremes', () => {
  const samples = Float32Array.from([0, 0.5, -0.25, 0, 1, -1, 0.1, 0.2])
  assert.deepEqual([...loupeColumns(samples, 2)], [-0.25, 0.5, -1, 1])
  assert.deepEqual([...loupeColumns(new Float32Array(0), 2)], [0, 0, 0, 0], 'no audio reads as silence')
  // More columns than samples: every column still gets a value.
  const few = loupeColumns(Float32Array.from([0.3, -0.3]), 4)
  assert.equal(few.length, 8)
  assert.ok([...few].every(Number.isFinite))
})

test('the loupe sits above the finger, or beside it when there is no room', () => {
  const size = LOUPE_SIZE_PX
  const above = loupePosition({ x: 200, y: 300, boxW: 390, boxH: 400 })
  assert.equal(above.top, 300 - LOUPE_GAP_PX - size)
  assert.equal(above.left, 200 - size / 2)
  // Near the left edge it stays in the box.
  assert.equal(loupePosition({ x: 10, y: 300, boxW: 390, boxH: 400 }).left, 0)
  // A short box (a phone on its side): beside the finger, not over it.
  const beside = loupePosition({ x: 100, y: 60, boxW: 800, boxH: 160 })
  assert.ok(beside.left >= 100 + LOUPE_GAP_PX, 'to the right, clear of the finger')
  const besideLeft = loupePosition({ x: 760, y: 60, boxW: 800, boxH: 160 })
  assert.ok(besideLeft.left + size <= 760 - LOUPE_GAP_PX + 1e-9, 'to the left near the right edge')
  assert.ok(beside.top >= 0 && beside.top + size <= 160)
})

test('a nudge is about 3 px at the current zoom, in round numbers', () => {
  assert.equal(nudgeStep(100), 0.05, '3 px at 100 px/s is 30 ms → 50 ms')
  assert.equal(nudgeStep(300), 0.01)
  assert.equal(nudgeStep(1500), 0.002)
  assert.equal(nudgeStep(1e6), NUDGE_MIN_S)
  assert.equal(nudgeStep(0.1), NUDGE_MAX_S)
  assert.equal(nudgeStep(0), NUDGE_MAX_S)
  for (const pps of [3, 17, 250, 999, 2000]) {
    const s = nudgeStep(pps)
    const mantissa = s / 10 ** Math.floor(Math.log10(s) + 1e-9)
    assert.ok([1, 2, 5].some(m => near(mantissa, m, 1e-6)), `${s} is a 1-2-5 step`)
  }
})

test('a nudged edge stays in the file and never crosses the other edge', () => {
  const sel = { start: 1, end: 2 }
  assert.deepEqual(nudgedSelection(sel, 'start', -0.5, 10), { start: 0.5, end: 2 })
  assert.deepEqual(nudgedSelection(sel, 'end', 0.25, 10), { start: 1, end: 2.25 })
  assert.deepEqual(nudgedSelection(sel, 'start', -5, 10), { start: 0, end: 2 })
  assert.deepEqual(nudgedSelection(sel, 'end', 50, 10), { start: 1, end: 10 })
  const pushed = nudgedSelection(sel, 'start', 5, 10)
  assert.ok(near(pushed.start, 2 - NUDGE_MIN_S) && pushed.end === 2, 'stops short of the end')
  const pulled = nudgedSelection(sel, 'end', -5, 10)
  assert.ok(near(pulled.end, 1 + NUDGE_MIN_S) && pulled.start === 1)
})

test('the loupe lifts quiet audio so a gap shows its detail, within a limit', () => {
  assert.equal(loupeGain(Float32Array.from([-0.95, 0.95])), 1, 'loud audio is drawn true')
  assert.ok(near(loupeGain(Float32Array.from([-0.09, 0.045])), 10, 1e-5))
  assert.equal(loupeGain(Float32Array.from([0.001])), LOUPE_MAX_GAIN, 'noise is not blown up to full height')
  assert.equal(loupeGain(new Float32Array(4)), 1, 'silence stays flat')
})
