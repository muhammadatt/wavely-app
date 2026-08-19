/**
 * Run with:  npm test
 *
 * The analyzer's display math. Everything here is what stands between an FFT
 * and a picture, and each assertion is a way the picture has been drawn wrong
 * before: bins collapsed with the wrong statistic, a peak hold that never
 * decays, a tilt that doubles as a level control.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTilt,
  createLogMapper,
  createSpectrumPeakHold,
  dominant,
  formatHz,
  noteFor,
} from '../../src/audio/dsp/spectrumDisplay.js'

const SAMPLE_RATE = 44100
const FFT = 4096
const BIN_COUNT = FFT / 2
const BIN_HZ = SAMPLE_RATE / FFT

/** A flat spectrum with one bin raised, as an isolated tone would appear. */
function frameWithTone(hz, db, floor = -100) {
  const bins = new Float32Array(BIN_COUNT).fill(floor)
  bins[Math.round(hz / BIN_HZ)] = db
  return bins
}

test('log grid spans the requested range and is geometric', () => {
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ, cells: 384 })
  assert.equal(m.cells, 384)
  assert.ok(m.centers[0] > 20 && m.centers[0] < 21)
  assert.ok(m.centers[383] > 19000 && m.centers[383] <= 20000)

  // Equal ratios between neighbours is the property that makes an octave the
  // same width everywhere on the axis.
  const r1 = m.centers[10] / m.centers[9]
  const r2 = m.centers[300] / m.centers[299]
  assert.ok(Math.abs(r1 - r2) < 1e-5, `${r1} vs ${r2}`)
})

test('the axis stops at Nyquist rather than at the requested ceiling', () => {
  // 8 kHz sample rate: there are no bins above 4 kHz to draw, and an axis that
  // ran to 20 kHz would give three quarters of the plot to nothing.
  const m = createLogMapper({ binCount: 512, binWidthHz: 8000 / 1024 })
  assert.ok(m.maxHz <= 4000)
})

test('a tone survives the resample at every frequency', () => {
  // The failure this guards is averaging: at 10 kHz one raised bin is one of
  // ~30 in its display cell, and a mean would report it 15 dB quieter than it
  // is — which is exactly how a whistle or a switching supply disappears.
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ })
  for (const hz of [120, 1000, 5000, 12000, 18000]) {
    const out = m.map(frameWithTone(hz, -20))
    const peak = dominant(out, m.centers)
    assert.ok(Math.abs(peak.db - (-20)) < 0.001, `${hz} Hz read ${peak.db}`)
    // And it lands where it was put. Measured against the bin's own centre
    // rather than the requested frequency: the FFT can only place a tone on a
    // 10.8 Hz grid, and holding the mapper to an error the bins already carry
    // would be testing the wrong stage.
    const binHz = Math.round(hz / BIN_HZ) * BIN_HZ
    assert.ok(Math.abs(Math.log2(peak.hz / binHz)) < 0.02, `${binHz} Hz drawn at ${peak.hz}`)
  }
})

test('cells narrower than a bin interpolate instead of repeating', () => {
  // Below ~100 Hz at 4096 points the display is finer than the FFT. Repeating
  // the nearest bin draws the bottom octave as a staircase; interpolating draws
  // the ramp that is actually there.
  const bins = new Float32Array(BIN_COUNT).fill(-100)
  for (let k = 0; k < 20; k++) bins[k] = -100 + k * 5
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ })
  const out = m.map(bins)

  let steps = 0
  for (let d = 1; d < 60; d++) if (out[d] === out[d - 1]) steps++
  assert.ok(steps < 6, `${steps} repeated values in the bottom of the axis`)
})

test('non-finite bins are floored, not drawn', () => {
  // A silent analyser reports -Infinity. Passed through, it makes the trace
  // vanish rather than sit on the floor.
  const bins = new Float32Array(BIN_COUNT).fill(-Infinity)
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ })
  const out = m.map(bins, -140)
  for (const v of out) assert.equal(v, -140)
})

test('DC is never drawn', () => {
  // Bin 0 carries whatever offset the file has and belongs to no frequency on
  // the axis. Letting it into the first cell paints a permanent wall at 20 Hz.
  const bins = new Float32Array(BIN_COUNT).fill(-100)
  bins[0] = 0
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ })
  const out = m.map(bins)
  assert.ok(dominant(out, m.centers).db < -60)
})

test('tilt is anchored at 1 kHz and is exactly the stated slope', () => {
  const centers = new Float32Array([250, 500, 1000, 2000, 4000])
  const values = new Float32Array(centers.length).fill(-30)
  applyTilt(values, centers, 4.5)

  // 1 kHz unmoved: the tilt is a slope, not a level control.
  assert.ok(Math.abs(values[2] - (-30)) < 1e-6)
  assert.ok(Math.abs(values[3] - (-25.5)) < 1e-6)
  assert.ok(Math.abs(values[1] - (-34.5)) < 1e-6)
  // One octave up, one slope: the same difference everywhere.
  assert.ok(Math.abs((values[4] - values[3]) - (values[3] - values[2])) < 1e-6)
})

test('3 dB per octave puts pink noise flat', () => {
  // The whole reason the control exists — pink noise falls 3 dB per octave, so
  // the setting named for it must draw a straight line.
  const m = createLogMapper({ binCount: BIN_COUNT, binWidthHz: BIN_HZ })
  const bins = new Float32Array(BIN_COUNT)
  for (let k = 1; k < BIN_COUNT; k++) bins[k] = -30 - 3 * Math.log2((k * BIN_HZ) / 1000)
  const out = m.map(bins)
  applyTilt(out, m.centers, 3)

  // Skip the interpolated bottom of the axis, where a cell is finer than a bin
  // and the reading is between two samples of a curve rather than on it.
  let min = Infinity
  let max = -Infinity
  for (let d = 0; d < m.cells; d++) {
    if (m.centers[d] < 100) continue
    min = Math.min(min, out[d])
    max = Math.max(max, out[d])
  }
  assert.ok(max - min < 0.6, `pink noise spans ${(max - min).toFixed(2)} dB after tilt`)
})

test('peak hold rises instantly, plateaus, then falls', () => {
  const hold = createSpectrumPeakHold(4, { holdMs: 1000, fallDbPerSec: 20, floorDb: -140 })
  const loud = new Float32Array([-20, -20, -20, -20])
  const quiet = new Float32Array([-80, -80, -80, -80])

  hold.push(loud, 16)
  assert.equal(hold.values[0], -20)

  // Inside the hold window, nothing moves.
  for (let i = 0; i < 50; i++) hold.push(quiet, 16)
  assert.equal(hold.values[0], -20)

  // Past it, 20 dB per second.
  for (let i = 0; i < 63; i++) hold.push(quiet, 16)
  assert.ok(hold.values[0] < -30 && hold.values[0] > -45, hold.values[0])
})

test('each cell ages on its own', () => {
  // A single shared timer is reset by any cell rising, and on real audio one
  // always is — so the hold never reaches its decay phase and stops recording
  // anything. Same failure the resonance display was built with and measured
  // out of.
  const hold = createSpectrumPeakHold(2, { holdMs: 100, fallDbPerSec: 50, floorDb: -140 })
  hold.push(new Float32Array([-20, -20]), 16)

  // Cell 1 keeps being re-hit; cell 0 goes quiet and must decay regardless.
  for (let i = 0; i < 60; i++) hold.push(new Float32Array([-90, -20]), 16)

  assert.ok(hold.values[0] < -30, `stale cell held at ${hold.values[0]}`)
  assert.equal(hold.values[1], -20)
})

test('reset clears the hold', () => {
  const hold = createSpectrumPeakHold(3, { floorDb: -140 })
  hold.push(new Float32Array([-10, -10, -10]), 16)
  hold.reset()
  for (const v of hold.values) assert.equal(v, -140)
})

test('axis labels read like an analyzer', () => {
  assert.equal(formatHz(20), '20')
  assert.equal(formatHz(200), '200')
  assert.equal(formatHz(1000), '1k')
  assert.equal(formatHz(1500), '1.5k')
  assert.equal(formatHz(10000), '10k')
  assert.equal(formatHz(20000), '20k')
})

test('note names match the tuning everyone else uses', () => {
  assert.equal(noteFor(440), 'A4')
  assert.equal(noteFor(110), 'A2')
  assert.equal(noteFor(261.63), 'C4')
  // 50 Hz mains is between G1 and G#1 — the cents are what say which.
  assert.match(noteFor(50), /^G1 [+-]\d+$/)
  assert.equal(noteFor(0), '')
})
