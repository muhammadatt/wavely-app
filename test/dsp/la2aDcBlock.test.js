/**
 * Run with:  npm test
 *
 * OPTOSMOOTH'S DC BLOCKER — the one-pole after the tube stage.
 *
 * The shaper is asymmetric (`tubeBias`), so it rectifies: it shifts the
 * waveform bodily, and a shifted waveform corrupts the peak measurement ACX
 * compliance is built on. The blocker exists for that and for nothing else.
 *
 * THE CORNER IS DERIVED — see DC_BLOCK_HZ for the two-narrator sweep behind it
 * and `npm run dcblock:real` to re-run it. These tests pin what that argument
 * rests on: that the constant is the one the kernel runs, that the filter is
 * load-bearing, that it is out of circuit when the tube is, and what the
 * shipped corner costs the passband.
 *
 * ⚠ THEY CANNOT PIN THE CHOICE ITSELF, and should not be read as doing so. The
 * corner was settled on peak shift measured on real narration (0.04 dB between
 * 2 and 5 Hz), which needs audio this suite does not have.
 *
 * ⚠ `dcR = 1` IS AN EXACT BYPASS, which is what makes the sweep clean:
 * `y[n] = x[n] - x[n-1] + y[n-1]` telescopes to `y[n] = x[n] - x[0] + y[0]`,
 * i.e. the signal itself, with the oversampler, the T4 ballistics and the
 * shaper left bit-identical. Everything below leans on it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel, DC_BLOCK_HZ } from '../../src/audio/la2aProcessor.js'

const SR = 48000
const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/**
 * `corner: null` bypasses the blocker exactly; any number overrides it. The
 * override is applied AFTER setParams because the pole is a constructor-time
 * field — setParams never touches it, which is why a sweep needs no edit to
 * shipping code.
 */
function run(input, { corner, ...params } = {}) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction: 60, gainDb: 0, tubeDrive: 0.3, mix: 1, ...params })
  if (corner !== undefined) k.dcR = corner === null ? 1 : 1 - 2 * Math.PI * corner / SR
  const n = input.length
  const out = new Float32Array(n)
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off)
    k.process([input.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  return out
}

function tone(hz, sec, amp) {
  const n = Math.round(SR * sec)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * hz * i / SR)
  return x
}

// Past the ballistics' settling — a mean taken over the attack reads the
// envelope moving, not the shaper's offset.
const SKIP = SR
const mean = a => { let s = 0; for (let i = SKIP; i < a.length; i++) s += a[i]; return s / (a.length - SKIP) }
const rms = a => { let s = 0; for (let i = SKIP; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length - SKIP)) }

test('the named constant is the pole the kernel actually runs', () => {
  // Naming a constant buys nothing if the code goes on carrying its own copy,
  // which is the state this replaced.
  const k = new LA2AKernel(SR)
  assert.equal(k.dcR, 1 - 2 * Math.PI * DC_BLOCK_HZ / SR)
})

test('the one-pole lands on its nominal corner', () => {
  // R = 1 - 2*pi*f/fs is an approximation. It happens to be a very good one
  // this far below Nyquist (0.2% at 5 Hz), so the constant can be read as a
  // frequency — a guard against a "correction" to the coefficient that moves
  // the corner while looking like tidying.
  const R = 1 - 2 * Math.PI * DC_BLOCK_HZ / SR
  const mag = f => {
    const w = 2 * Math.PI * f / SR
    return Math.hypot(1 - Math.cos(w), Math.sin(w)) / Math.hypot(1 - R * Math.cos(w), R * Math.sin(w))
  }
  let lo = 0.01, hi = 200
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (db(mag(m)) < -3) lo = m; else hi = m }
  assert.ok(Math.abs(lo - DC_BLOCK_HZ) / DC_BLOCK_HZ < 0.01, `-3 dB at ${lo.toFixed(3)} Hz, nominal ${DC_BLOCK_HZ}`)
})

test('it removes the DC the shaper generates, and the shaper generates some', () => {
  // Both halves matter. Without the second the test passes on a build with no
  // shaper at all, and this file's own record is that a DC blocker looks
  // droppable at one operating point and is load-bearing at another.
  const x = tone(120, 2, 0.5)
  const blocked = mean(run(x, { tubeDrive: 1 }))
  const bypassed = mean(run(x, { tubeDrive: 1, corner: null }))

  assert.ok(db(bypassed) > -75, `shaper left only ${db(bypassed).toFixed(1)} dBFS of DC to remove`)
  assert.ok(db(blocked) < -140, `DC survived the blocker at ${db(blocked).toFixed(1)} dBFS`)
})

test('it is out of circuit when the tube stage is', () => {
  // The blocker is gated on `applyTube`. An always-on filter would cost the
  // stage its transparency for everyone who turns the tube off — and it is
  // linear, so it would go on rotating LF phase with nothing to correct.
  const x = tone(120, 0.5, 0.5)
  const a = run(x, { tubeDrive: 0 })
  const b = run(x, { tubeDrive: 0, corner: 40 })
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `a corner change moved the output at tubeDrive 0, sample ${i}`)
  }
})

test('the shipped corner costs the passband almost nothing', () => {
  // Pins the trade a re-derivation moves, two-sided so a corner change in
  // EITHER direction fails: 2 Hz gives 0.010 dB here and 10 Hz gives 0.258.
  const x = tone(40, 3, 0.3)
  const loss = db(rms(run(x, { corner: null }))) - db(rms(run(x)))
  assert.ok(loss > 0.04 && loss < 0.10, `40 Hz lost ${loss.toFixed(4)} dB, outside the pinned band`)
})

test('it overshoots in the passband, and by a bounded amount', () => {
  // ⚠ THIS FILTER DOES BOOST, WHICH THE TAPE BLOCKER DELIBERATELY DOES NOT.
  // `(1 - z^-1)/(1 - R*z^-1)` peaks at Nyquist at exactly 2/(1+R) — a naive
  // one-pole is not the Butterworth `makeDcBlocker` uses, and that filter is a
  // biquad specifically to keep a "never boosts" guarantee intact.
  //
  // Found by asserting the guarantee and watching it fail: the assertion read
  // "the blocker BOOSTED 1000 Hz by 0.0027 dB", and the end-to-end measurement
  // agrees with the analytic magnitude to five decimals, so it is the premise
  // that was wrong rather than the probe. At 5 Hz the overshoot is 0.0028 dB
  // and nothing hears it. It is pinned rather than removed because it scales
  // with the corner, so anything that RAISES the corner pays for it here.
  const R = 1 - 2 * Math.PI * DC_BLOCK_HZ / SR
  const atNyquist = db(2 / (1 + R))
  assert.ok(atNyquist > 0, 'the one-pole is expected to overshoot; it did not')
  assert.ok(atNyquist < 0.005, `overshoot reached ${atNyquist.toFixed(4)} dB at Nyquist`)

  // And the end-to-end path shows the same number, so it is the blocker's and
  // not an artifact of measuring through the compressor.
  const x = tone(1000, 3, 0.3)
  const measured = db(rms(run(x))) - db(rms(run(x, { corner: null })))
  assert.ok(Math.abs(measured - db(2 / (1 + R))) < 0.001, `measured ${measured.toFixed(5)} dB`)
})
