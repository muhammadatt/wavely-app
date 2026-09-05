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
  // ⚠ 84, NOT 60, AND SOLVED RATHER THAN CHOSEN. The knob is side-chain DRIVE,
  // so a knob number means whatever the taper says it means — and the taper was
  // re-fitted against a real LA-2A, which moved every position on the travel.
  // 84 is where the new law puts the drive that 60 used to (33.6 dB), so the
  // valves see the level this file's measurements were derived at. Hardcoding a
  // knob and asserting an absolute level is what broke this test; the number is
  // pinned to the DRIVE it stands for, which is what the DC actually follows.
  k.setParams({ mode: 'compress', peakReduction: 84, gainDb: 0, mix: 1, ...params })
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
//
// ⚠ ONE SECOND IS ENOUGH FOR `rms` AND NOT FOR `mean`, WHICH IS WHY THE DC TEST
// PASSES ITS OWN. A DC mean is the one measurement here sensitive to the tail:
// the slow release runs to 5 s and the LDR memory to 8, so the envelope is
// still creeping long after it is audibly settled, and the creep IS a DC term.
// Measured on the shipping kernel, the residual over the last second of the
// tone keeps falling with tone length — -136.0 / -145.8 / -154.0 / -166.3 dBFS
// at 2 / 3 / 4 / 6 s — against -56.9 bypassed. None of that is the blocker
// changing; it is how much ballistic settling the window still contains. A 2 s
// tone read from 1 s therefore pins the ATTACK's early trajectory, not the
// shaper's offset, and the program-dependent attack duly moved it.
const SKIP = SR
const meanFrom = (a, skip) => { let s = 0; for (let i = skip; i < a.length; i++) s += a[i]; return s / (a.length - skip) }
const mean = a => meanFrom(a, SKIP)
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
  // Driven hard via GAIN, which is how the valves are driven now that the
  // `tubeDrive` knob is gone — makeup sits before the shaper, as on the unit.
  //
  // ⚠ +18 dB RATHER THAN +6, RE-DERIVED WITH THE SHAPER. `TUBE_DRIVE_LIN` came
  // down when the distortion moved to the gain cell, and the offset a gentler
  // curve rectifies came down with it: +6 dB now leaves -75.4 dBFS of DC
  // against the -60 this asserted, so the test would have failed for the right
  // reason on a build that was working. Measured across the knob:
  // -75.4 / -63.4 / -51.5 / -40.0 dBFS bypassed at +6 / 12 / 18 / 24.
  // 4 s read from 3 s, not 2 s read from 1 s — see `meanFrom` for why this one
  // measurement needs the ballistics genuinely settled rather than merely past
  // the attack.
  const x = tone(120, 4, 0.5)
  const blocked = meanFrom(run(x, { gainDb: 18 }), 3 * SR)
  const bypassed = meanFrom(run(x, { gainDb: 18, corner: null }), 3 * SR)

  assert.ok(db(bypassed) > -60, `shaper left only ${db(bypassed).toFixed(1)} dBFS of DC to remove`)
  assert.ok(db(blocked) < -140, `DC survived the blocker at ${db(blocked).toFixed(1)} dBFS`)
})

test('it is out of circuit when the tube stage is', () => {
  // The blocker is gated on `applyTube`. ⚠ Since the `tubeDrive` knob went,
  // nothing a user can reach turns the tube off — `tube` is the kernel's
  // measurement bypass, the role `oversample` plays. So this pins that the
  // bypass is a real bypass, which is what the measurements above rely on.
  const x = tone(120, 0.5, 0.5)
  const a = run(x, { tube: false })
  const b = run(x, { tube: false, corner: 40 })
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `a corner change moved the output with the tube bypassed, sample ${i}`)
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
