/**
 * Run with:  npm test
 *
 * OPTOSMOOTH'S DISTORTION — an output tube stage driven by LEVEL, plus a GAIN
 * CELL whose ripple rises with compression. Two mechanisms, and the tests below
 * measure them separately because they run in opposite directions.
 *
 * ⚠ THIS REPLACED A `tubeDrive` KNOB THE HARDWARE DOES NOT HAVE. An LA-2A's
 * T4 cell attenuates and a 12AX7 makeup amplifier drives the output; how hard
 * those valves are pushed is a consequence of the level reaching them, so a
 * knob scaling the curve was really moving the level at which the stage
 * saturates — a property of the valve and its supply, not of the operator.
 *
 * ⚠ AND THE VALVES ARE NOT WHERE MOST OF THE DISTORTION COMES FROM. Moore,
 * JAES 74(1/2):61-72 (2026), measured six hardware units and names the T4
 * attenuator as the primary contributor during gain reduction, with the Class A
 * valve stages sitting near their linear region. So the tube stage alone gets
 * QUIETER as the cell works (it backs the level off before the valves see it),
 * which is a correct consequence of an output-stage nonlinearity and the
 * opposite of what the hardware does. `cellMod` is the modulation that puts the
 * dominant term where the paper puts it; it is odd-dominant and it RISES with
 * gain reduction.
 *
 * ⚠ THE TUBE-STAGE TESTS THEREFORE PIN `cellMod: 0` RATHER THAN INHERITING THE
 * DEFAULT. They are about the valves, and with the cell running they would be
 * measuring the sum of two mechanisms that disagree about direction. Same
 * convention the soft clipper's curve-only tests follow for `limiter`.
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

/**
 * ⚠ 200 Hz BECAUSE IT DIVIDES 48000 EXACTLY. The DFT below sums over a whole
 * number of SAMPLES, so a probe whose period is fractional leaks the
 * fundamental into every harmonic bin however the window is rounded. Measured
 * at 220 Hz (218.18 samples per cycle) that leakage put a floor of about
 * 0.31 % under every reading — which was invisible while the tube stage sat
 * well above it and became the ENTIRE measurement at the quiet end of the
 * level sweep once the drive was recalibrated: -40 dBFS read 0.31 % against a
 * true 0.03 %, and the sweep appeared to span 5x rather than 44x. An exact
 * divisor removes the problem rather than bounding it.
 */
const F = 200
const CYCLE = SR / F
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

/** Magnitude of the kth harmonic, over whole cycles taken past settling. */
function harmonic(y, k) {
  const off = 1000 + Math.round(SR * 0.2)
  const N = Math.floor((y.length - off - 1000) / CYCLE) * CYCLE
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
  // The valves have no drive of their own: the only thing that decides how hard
  // they work is how much signal arrives. Measured 0.030 / 0.077 / 0.148 /
  // 0.297 / 0.638 / 1.342 %, a 44x span.
  const levels = [-40, -24, -18, -12, -6, -1]
  const got = levels.map(l => thd(run(tone(1, lin(l)), { cellMod: 0 })))
  assert.ok(strictlyRising(got), `THD did not rise with level: ${got.map(v => (v * 100).toFixed(3))}`)
  assert.ok(got[got.length - 1] / got[0] > 20, 'the sweep barely moved; the stage is not level-driven')
})

test('the Gain knob drives the valves', () => {
  // Makeup sits BEFORE the shaper as on the hardware, so Gain is the overdrive
  // control — and with the knob gone it is the only one. 0.148 -> 4.571 %.
  const got = [0, 6, 12, 18, 24].map(g => thd(run(tone(1, lin(-18)), { gainDb: g, cellMod: 0 })))
  assert.ok(strictlyRising(got), `THD did not rise with gain: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('compression backs the VALVES off at the same Gain', () => {
  // Correct for an output-stage nonlinearity: the cell pulls the level down
  // before the valves see it, so more Peak Reduction is less valve saturation.
  // 1.581 -> 0.113 %.
  //
  // ⚠ THIS IS NOT THE STAGE'S OVERALL BEHAVIOUR, and taking it for the whole
  // story is exactly the error the paper overturned — see the next test.
  const got = [0, 40, 70, 90].map(pr => thd(run(tone(1, lin(-12)), { peakReduction: pr, gainDb: 12, cellMod: 0 })))
  assert.ok(strictlyRising([...got].reverse()), `THD did not fall with Peak Reduction: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('the shipped stage distorts MORE as it compresses', () => {
  // The hardware direction, and the whole reason `cellMod` exists. Same sweep
  // as the test above with the cell running: 1.581 / 1.478 / 2.043 / 2.094 %.
  //
  // The dip at PR 40 is real and is the two mechanisms crossing — the valves
  // are still losing more than the cell has yet gained — so this asserts the
  // ENDPOINTS rather than monotonicity, which the sum does not have.
  const got = [0, 40, 70, 90].map(pr => thd(run(tone(1, lin(-12)), { peakReduction: pr, gainDb: 12 })))
  const shown = got.map(v => (v * 100).toFixed(3))
  assert.ok(got[3] > got[0] * 1.2, `deep compression did not raise THD: ${shown}`)
  assert.ok(got[3] > got[1] && got[2] > got[1], `THD did not recover past the crossing: ${shown}`)
})

test('the cell contributes ODD harmonics, where the valves contribute even', () => {
  // Moore measured H3 sitting +16 to +44 dB ABOVE H2 on six hardware units at
  // 6 dB of gain reduction (median +25.7), with 0.94-4.22 % THD (median 2.19).
  // A biased tanh cannot do that — it is even-dominant by construction, which
  // is what the paper's finding disqualified. Gain modulation can: a detector
  // rippling at 2f on a carrier at f puts sidebands at f and 3f.
  //
  // At PR 54 (6 dB GR here), -18 dBFS, Gain 0: THD 1.51 %, H3 26.0 dB over H2.
  const y = run(tone(2, lin(-18)), { peakReduction: 54 })
  const h1 = harmonic(y, 1), h2 = harmonic(y, 2), h3 = harmonic(y, 3)
  const total = thd(y)
  assert.ok(total > 0.0094 && total < 0.0422, `THD ${(total * 100).toFixed(2)}% is outside the six units' 0.94-4.22%`)
  const balance = db(h3) - db(h2)
  assert.ok(balance > 16, `H3 is only ${balance.toFixed(1)} dB over H2; the stage is not odd-dominant`)

  // And it is the cell doing it, ADDITIVELY, which is what makes it a mechanism
  // rather than a rebalancing. With the modulation off the same operating point
  // reads 0.093 % with H3 level with H2 (-63.7 against -64.0 dBc, the existing
  // detector's own ripple); switching it on leaves H2 within 0.1 dB and lifts
  // H3 by 26 dB.
  //
  // ⚠ "THE TUBE STAGE ALONE IS EVEN-DOMINANT" IS TRUE OF THE CURVE AND NOT OF
  // THE STAGE AT THIS OPERATING POINT, and asserting it fails. The gain
  // computer already ripples a little at PR 54, so a test written against the
  // shaper's own symmetry would be measuring the compressor as well.
  const off = run(tone(2, lin(-18)), { peakReduction: 54, cellMod: 0 })
  const dH2 = db(harmonic(y, 2)) - db(harmonic(off, 2))
  const dH3 = db(harmonic(y, 3)) - db(harmonic(off, 3))
  assert.ok(Math.abs(dH2) < 1, `the cell moved H2 by ${dH2.toFixed(1)} dB; it should only add odd content`)
  assert.ok(dH3 > 15, `the cell only added ${dH3.toFixed(1)} dB of H3`)
})

test('the cell is silent when it is not working', () => {
  // Depth scales with gain reduction, so at Peak Reduction 0 the modulation
  // must be absent rather than small — otherwise every measurement of the tube
  // stage above is measuring something else as well.
  const x = tone(0.5, 0.25)
  const base = run(x, { cellMod: 0 })
  const y = run(x)
  for (let i = 0; i < base.length; i++) {
    assert.equal(y[i], base[i], `the cell moved sample ${i} with no gain reduction`)
  }
})

test('it is calibrated to the hardware spec at nominal level', () => {
  // The LA-2A's published figure is under 0.5% THD, quoted with the unit not
  // compressing — so this is the VALVES, measured where the cell is idle.
  //
  // ⚠ A PUBLISHED SPEC IS NOT A CAPTURE. This says our curve is not obviously
  // wrong at one operating point; it is not a claim to be a 12AX7.
  const got = thd(run(tone(1, lin(-18)), { cellMod: 0 }))
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
