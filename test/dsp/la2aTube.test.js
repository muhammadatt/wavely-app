/**
 * Run with:  npm test
 *
 * OPTOSMOOTH'S OUTPUT TUBE STAGE — saturation driven by LEVEL, with no control
 * over it.
 *
 * ⚠ THIS REPLACED A `tubeDrive` KNOB THE HARDWARE DOES NOT HAVE. An LA-2A's
 * T4 cell attenuates and a 12AX7 makeup amplifier drives the output; how hard
 * those valves are pushed is a consequence of the level reaching them, so a
 * knob scaling the curve was really moving the level at which the stage
 * saturates — a property of the valve and its supply, not of the operator.
 *
 * The mechanism was always half there: makeup is applied BEFORE the shaper, as
 * on the hardware. What these tests pin is that it is now the WHOLE mechanism —
 * Gain up means more saturation, compression means less of it at the same Gain,
 * and nothing else reaches the curve at all.
 *
 * ⚠ THD IS MEASURED BY DFT AT HARMONICS OF THE PROBE TONE, not by differencing
 * against a bypassed stage. A difference signal here is dominated by the DC
 * blocker's LF PHASE ROTATION — measured, it puts a floor at -32.9 dBc that
 * does not fall with level, which reads as a stage that never stops distorting.
 * Harmonic magnitudes are immune to phase.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'

const SR = 48000
const F = 220
const CYCLE = Math.round(SR / F)
const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const lin = dbfs => Math.pow(10, dbfs / 20)

function run(x, params = {}) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction: 0, gainDb: 0, r37: 100, mix: 1, ...params })
  const n = x.length, o = new Float32Array(n)
  for (let f = 0; f < n; f += 128) {
    const l = Math.min(128, n - f)
    k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
  }
  return o
}

function tone(seconds, amp) {
  const n = Math.round(SR * seconds), x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * F * i / SR)
  return x
}

/** Magnitude of the kth harmonic, over whole cycles taken late enough to be past settling. */
function harmonic(y, k) {
  const N = CYCLE * 200, off = y.length - N - 1000
  let re = 0, im = 0
  for (let i = 0; i < N; i++) {
    const p = 2 * Math.PI * k * F * (off + i) / SR
    re += y[i + off] * Math.cos(p); im += y[i + off] * Math.sin(p)
  }
  return 2 * Math.hypot(re, im) / N
}

const thd = y => {
  const f = harmonic(y, 1)
  let s = 0
  for (let k = 2; k <= 8; k++) { const h = harmonic(y, k); s += h * h }
  return Math.sqrt(s) / f
}

const strictlyRising = xs => xs.every((v, i) => i === 0 || v > xs[i - 1])

test('saturation follows input level', () => {
  // The stage has no drive of its own: the only thing that decides how hard it
  // works is how much signal arrives. Measured 0.20 / 0.30 / 0.43 / 0.74 /
  // 1.57 / 3.49 % across this sweep.
  const levels = [-40, -24, -18, -12, -6, -1]
  const got = levels.map(l => thd(run(tone(1, lin(l)))))
  assert.ok(strictlyRising(got), `THD did not rise with level: ${got.map(v => (v * 100).toFixed(3))}`)
  assert.ok(got[got.length - 1] / got[0] > 10, 'the sweep barely moved; the stage is not level-driven')
})

test('the Gain knob drives the valves', () => {
  // Makeup sits BEFORE the shaper as on the hardware, so Gain is the overdrive
  // control — and with the knob gone it is the only one. 0.43 -> 11.41 %.
  const got = [0, 6, 12, 18, 24].map(g => thd(run(tone(1, lin(-18)), { gainDb: g })))
  assert.ok(strictlyRising(got), `THD did not rise with gain: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('compression backs the valves off at the same Gain', () => {
  // The hardware behaviour, and the clearest statement that drive is derived
  // rather than set: the cell pulls the level down before the valves see it,
  // so more Peak Reduction is LESS saturation at a fixed Gain. 4.15 -> 0.29 %.
  const got = [0, 40, 70, 90].map(pr => thd(run(tone(1, lin(-12)), { peakReduction: pr, gainDb: 12 })))
  assert.ok(strictlyRising([...got].reverse()), `THD did not fall with Peak Reduction: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('it is calibrated to the hardware spec at nominal level', () => {
  // The LA-2A's published figure is under 0.5% THD. That is what kept the old
  // knob's default as the fixed value: it is the one position on that travel
  // consistent with the unit, and everything above it was a valve nobody built
  // (2.2% at nominal at the old maximum).
  //
  // ⚠ A PUBLISHED SPEC IS NOT A CAPTURE. This says our curve is not obviously
  // wrong at one operating point; it is not a claim to be a 12AX7.
  const got = thd(run(tone(1, lin(-18))))
  assert.ok(got < 0.005, `THD at nominal is ${(got * 100).toFixed(3)}%, over the 0.5% spec`)
})

test('the stage is transparent on quiet material', () => {
  // Unity small-signal gain — the curve is normalised by its own slope at zero,
  // so a stage with nothing to saturate passes the level through.
  const x = tone(1, lin(-60))
  const y = run(x)
  const g = db(harmonic(y, 1)) - db(lin(-60))
  assert.ok(Math.abs(g) < 0.1, `quiet signal changed level by ${g.toFixed(3)} dB`)
})

test('nothing in the params reaches the curve', () => {
  // A `tubeDrive` from a stored preset written before this change must be inert
  // rather than half-honoured. Bit-identical, both ends of the old travel.
  const x = tone(0.5, 0.25)
  const base = run(x)
  for (const stale of [0, 0.3, 1]) {
    const y = run(x, { tubeDrive: stale })
    for (let i = 0; i < base.length; i++) {
      assert.equal(y[i], base[i], `a stale tubeDrive ${stale} moved sample ${i}`)
    }
  }
})
