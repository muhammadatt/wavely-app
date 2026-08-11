/**
 * Waveform ruler tick selection and label formatting.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseTickInterval, formatRulerTime } from '../../src/audio/renderer.js'

// A ruler label is ~7 px per character in the 10 px mono face, plus the gap the
// renderer adds. These stand in for the measured widths in the tests below.
const SHORT_LABEL_PX = 40   // "12:34"
const LONG_LABEL_PX = 62    // "1:23:45"

// ── Tick interval ───────────────────────────────────────────────────────────

test('ticks are never closer together than the label needs', () => {
  // Spans from a deep zoom on a word to a 4-hour audiobook fitted to a
  // 1200 px viewport (~0.28 px/s).
  for (const pps of [0.05, 0.28, 0.9, 3, 12, 40, 100, 480, 2000]) {
    for (const spacing of [SHORT_LABEL_PX, LONG_LABEL_PX]) {
      const interval = chooseTickInterval(pps, spacing)
      assert.ok(
        interval * pps >= spacing,
        `${pps} px/s at ${spacing} px spacing gave ${interval}s ticks — ${(interval * pps).toFixed(1)} px apart`
      )
    }
  }
})

test('a 30-minute file fitted to the window gets minute-or-coarser ticks', () => {
  // 1800 s across a 1200 px viewport. The old fixed ladder bottomed out at 10 s
  // here, which is a label every 6.7 px.
  const interval = chooseTickInterval(1200 / 1800, LONG_LABEL_PX)
  assert.ok(interval >= 60, `expected at least a minute per tick, got ${interval}s`)
})

test('ticks stay as fine as the spacing allows', () => {
  // Not merely legal — the *smallest* legal interval, so short files keep a
  // dense ruler rather than being thinned out with the long ones.
  const interval = chooseTickInterval(100, SHORT_LABEL_PX)
  assert.equal(interval, 0.5)
  assert.equal(chooseTickInterval(10, SHORT_LABEL_PX), 5)
})

test('every interval is a round time a listener would count in', () => {
  const allowed = new Set([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600])
  for (let pps = 0.1; pps < 2000; pps *= 1.35) {
    assert.ok(allowed.has(chooseTickInterval(pps, SHORT_LABEL_PX)))
  }
})

test('degenerate zoom or spacing falls back to one-second ticks', () => {
  assert.equal(chooseTickInterval(0, SHORT_LABEL_PX), 1)
  assert.equal(chooseTickInterval(NaN, SHORT_LABEL_PX), 1)
  assert.equal(chooseTickInterval(100, 0), 1)
})

// ── Label formatting ────────────────────────────────────────────────────────

test('short files keep the compact m:ss form', () => {
  assert.equal(formatRulerTime(5, 1), '0:05')
  assert.equal(formatRulerTime(65, 1), '1:05')
  assert.equal(formatRulerTime(1800, 60), '30:00')
})

test('the hours field appears once the file runs past an hour', () => {
  assert.equal(formatRulerTime(3600, 300), '1:00:00')
  assert.equal(formatRulerTime(3661, 1), '1:01:01')
  assert.equal(formatRulerTime(7325, 5), '2:02:05')
  // And only then — the field is not padded in on shorter files.
  assert.equal(formatRulerTime(3599, 1), '59:59')
})

test('sub-second grids carry decimals, whole-second grids do not', () => {
  assert.equal(formatRulerTime(12.5, 0.5), '0:12.5')
  assert.equal(formatRulerTime(12.34, 0.02), '0:12.34')
  assert.equal(formatRulerTime(12.5, 1), '0:13')
})

test('rounding never produces a :60 second field', () => {
  // 119.96 rounds to 120.0 at one decimal — as m:ss.s that must roll into 2:00.0.
  assert.equal(formatRulerTime(119.96, 0.5), '2:00.0')
  assert.equal(formatRulerTime(59.6, 1), '1:00')
  assert.equal(formatRulerTime(3599.996, 0.02), '1:00:00.00')
})

test('the zero label is suppressed', () => {
  assert.equal(formatRulerTime(0, 1), '')
  assert.equal(formatRulerTime(-3, 1), '')
})
