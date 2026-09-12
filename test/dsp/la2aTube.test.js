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
import { LA2AKernel, LA2A_LEGACY_PATCH } from '../../src/audio/la2aProcessor.js'

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
  k.setParams({ mode: 'compress', peakReduction: 0, gainDb: 0, r37: 100, mix: 1, ...LA2A_LEGACY_PATCH, ...params })
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

/**
 * The Peak Reduction knob that produces `targetDb` of gain reduction at this
 * probe, by bisection.
 *
 * The knob is side-chain DRIVE into a fixed threshold, not a threshold, and the
 * 80 Hz side-chain high-pass makes one position mean different reduction at
 * different frequencies — so any test that wants a stated operating point has
 * to solve for it. Hardcoding a knob and asserting what it produces is how the
 * drive constant came to be fitted 4 dB hot.
 */
function knobForGainReduction(targetDb, amp) {
  const x = tone(1.2, amp)
  let lo = 0, hi = 100
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const k = new LA2AKernel(SR)
    k.setParams({ mode: 'compress', peakReduction: mid, gainDb: 0, r37: 100, mix: 1, ...LA2A_LEGACY_PATCH })
    const o = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
    }
    if (k.grDb < targetDb) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * ⚠ RUNS ON `LA2A_LEGACY_PATCH`, WHICH IS NO LONGER THE KERNEL DEFAULT. Every
 * assertion below validates the fitted `tanh` valve and the Moore-derived T4
 * gain modulation. OptoSmooth now ships Tube Saturation's curve at both stages,
 * so these have to ask for the model they are about — they were written when it
 * was simply what a bare kernel did.
 *
 * ⚠ THEY ARE NOT STALE. This is the only mechanism in the plugin with hardware
 * measurements behind it, it is still selectable, and it is what every file
 * rendered before the switch was made with.
 */
test('saturation follows input level', () => {
  // The valves have no drive of their own: the only thing that decides how hard
  // they work is how much signal arrives. Measured 0.007 / 0.045 / 0.090 /
  // 0.182 / 0.376 / 0.727 %, a 104x span.
  const levels = [-40, -24, -18, -12, -6, -1]
  const got = levels.map(l => thd(run(tone(1, lin(l)), { cellMod: 0 })))
  assert.ok(strictlyRising(got), `THD did not rise with level: ${got.map(v => (v * 100).toFixed(3))}`)
  assert.ok(got[got.length - 1] / got[0] > 20, 'the sweep barely moved; the stage is not level-driven')
})

test('the Gain knob drives the valves', () => {
  // Makeup sits BEFORE the shaper as on the hardware, so Gain is the overdrive
  // control — and with the knob gone it is the only one. 0.090 -> 2.203 %.
  const got = [0, 6, 12, 18, 24].map(g => thd(run(tone(1, lin(-18)), { gainDb: g, cellMod: 0 })))
  assert.ok(strictlyRising(got), `THD did not rise with gain: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('compression backs the VALVES off at the same Gain', () => {
  // Correct for an output-stage nonlinearity: the cell pulls the level down
  // before the valves see it, so more Peak Reduction is less valve saturation.
  // 0.839 -> 0.091 %.
  //
  // ⚠ THIS IS NOT THE STAGE'S OVERALL BEHAVIOUR, and taking it for the whole
  // story is exactly the error the paper overturned — see the next test.
  const got = [0, 40, 70, 90].map(pr => thd(run(tone(1, lin(-12)), { peakReduction: pr, gainDb: 12, cellMod: 0 })))
  assert.ok(strictlyRising([...got].reverse()), `THD did not fall with Peak Reduction: ${got.map(v => (v * 100).toFixed(3))}`)
})

test('the shipped stage distorts MORE as it compresses', () => {
  // The hardware direction, and the whole reason `cellMod` exists. Same sweep
  // as the test above with the cell running: 0.839 / 1.278 / 2.037 / 2.093 %.
  //
  // ⚠ THE DIP AT PR 40 IS GONE, and the assertions below deliberately still
  // allow it. It was the two mechanisms crossing — the valves losing more than
  // the cell had yet gained — and re-deriving TUBE_DRIVE_LIN quietened the
  // valves enough that the cell now wins from the first step. That is a
  // consequence of the drive constant, not a property anything depends on, so
  // this keeps asserting the ENDPOINTS rather than monotonicity: the sum is not
  // guaranteed monotone and a future drive change could bring the dip back.
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
  // ⚠ THE KNOB IS SOLVED FOR 6 dB, NOT ASSUMED. This read `peakReduction: 54`
  // with a comment claiming that was 6 dB of reduction; it is 7.0 dB at this
  // frequency and over 9 at 250 Hz. The valves see input-minus-reduction, so
  // fitting the drive constant against that assumption left it 4 dB hot on H2
  // for a release — see TUBE_DRIVE_LIN. Bisecting costs a few hundred ms and
  // cannot drift when the side-chain taper is next touched.
  //
  // ⚠ AND THE PROBE IS NOMINAL RMS, not `lin(-18)` as a bare amplitude — see
  // the note in the H2 test below. This assertion compares against the six
  // units' absolute THD band, so a probe 3 dB under nominal is comparing the
  // model at one operating point with hardware at another.
  //
  // At 6.0 dB GR, nominal in, Gain 0: THD 1.39 %, H3 25.9 dB over H2, against
  // the six units' median 2.19 % and +25.7.
  const nominal = lin(-18) * Math.SQRT2
  const pr6 = knobForGainReduction(6, nominal)
  const y = run(tone(2, nominal), { peakReduction: pr6 })
  const h1 = harmonic(y, 1), h2 = harmonic(y, 2), h3 = harmonic(y, 3)
  const total = thd(y)
  assert.ok(total > 0.0094 && total < 0.0422, `THD ${(total * 100).toFixed(2)}% is outside the six units' 0.94-4.22%`)
  const balance = db(h3) - db(h2)
  assert.ok(balance > 16, `H3 is only ${balance.toFixed(1)} dB over H2; the stage is not odd-dominant`)

  // And it is the cell doing it, ADDITIVELY, which is what makes it a mechanism
  // rather than a rebalancing. With the modulation off the same operating point
  // reads 0.088 % with H3 level with H2 (-64.4 against -64.1 dBc, the existing
  // detector's own ripple); switching it on leaves H2 within 0.1 dB and lifts
  // H3 by 26.2 dB.
  //
  // ⚠ "THE TUBE STAGE ALONE IS EVEN-DOMINANT" IS TRUE OF THE CURVE AND NOT OF
  // THE STAGE AT THIS OPERATING POINT, and asserting it fails. The gain
  // computer already ripples a little at 6 dB of reduction, so a test written
  // against the shaper's own symmetry would be measuring the compressor too.
  const off = run(tone(2, nominal), { peakReduction: pr6, cellMod: 0 })
  const dH2 = db(harmonic(y, 2)) - db(harmonic(off, 2))
  const dH3 = db(harmonic(y, 3)) - db(harmonic(off, 3))
  assert.ok(Math.abs(dH2) < 1, `the cell moved H2 by ${dH2.toFixed(1)} dB; it should only add odd content`)
  assert.ok(dH3 > 15, `the cell only added ${dH3.toFixed(1)} dB of H3`)
})

test('the tube stage lands on the paper\'s H2 median at the paper\'s operating point', () => {
  // THE DERIVATION OF TUBE_DRIVE_LIN, as an assertion. `npm run la2a:h2:refit`
  // is the full sweep; this is the one point that must not move without
  // somebody meaning it.
  //
  // ⚠ IT PINS THE OPERATING POINT AS WELL AS THE NUMBER, which is the part that
  // was missing. The previous constant satisfied its own recorded target and
  // was still 4 dB hot, because the knob it was measured at produced 8-9 dB of
  // reduction rather than the 6 the paper used and nothing checked. Solving for
  // the reduction is what makes this a test of the drive rather than of the
  // side-chain taper.
  //
  // Cell modulation OFF: it adds no even content (the test above pins that
  // within 0.1 dB), so H2 here is the tanh alone, which is all this stage is
  // responsible for.
  //
  // ⚠ THE PROBE IS -18 dBFS RMS, NOT -18 dBFS PEAK, and the sqrt(2) is the
  // difference. NOMINAL_DBFS stands in for +4 dBu via the EBU alignment level,
  // and both of those are RMS figures for a sine — so `lin(-18)` as a bare
  // amplitude is a tone 3 dB BELOW nominal. Every other test in this file uses
  // the peak convention and its recorded numbers are all 3 dB light because of
  // it; harmless there, since they asserted directions and ratios rather than
  // absolute levels, and not harmless here, where the whole assertion is an
  // absolute level against a hardware measurement.
  const nominal = lin(-18) * Math.SQRT2
  const pr6 = knobForGainReduction(6, nominal)
  const y = run(tone(2, nominal), { peakReduction: pr6, cellMod: 0 })
  const h2 = db(harmonic(y, 2)) - db(harmonic(y, 1))
  assert.ok(Math.abs(h2 - (-63.80)) < 1.5,
    `H2 is ${h2.toFixed(2)} dBc against the paper's -63.80 median`)
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
  // Measured 0.128 %.
  //
  // ⚠ NOMINAL RMS, like the H2 test below — a published spec quoted at a
  // nominal operating level is an absolute comparison, so probing 3 dB under
  // nominal is answering a different question. This is one of the two tests in
  // this file that compare against an external number; see the ledger above
  // TUBE_DRIVE_LIN for what that does and does not establish.
  //
  // ⚠ A PUBLISHED SPEC IS NOT A CAPTURE, AND THIS BOUND IS ONE-SIDED. It says
  // our curve is not GROSSLY wrong at one operating point — the superseded 0.7
  // drive passed it too, at 0.271 %. It is not a claim to be a 12AX7.
  const got = thd(run(tone(1, lin(-18) * Math.SQRT2), { cellMod: 0 }))
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

/**
 * WHY THESE TWO EXIST. `TUBE_BIAS` is the one constant in this stage that was
 * chosen rather than fitted, and the ledger above it carried a plan for
 * settling it — transcribe the paper's H4 column, on the grounds that H4 is
 * even so it belongs to the valves and would pin the (drive, bias) pair. That
 * plan was wrong, and it was wrong because the note stated the wrong scaling
 * law. These pin the corrected reasoning so it cannot quietly rot back.
 */

/** H2 of the shaper alone at a level, for a (drive, bias) pair. Analytic input,
 *  so this is the shaper's own series with no cell and no oversampler. */
function shaperH (dbfs, drive, bias, harm) {
  const f = 1000, n = SR, amp = Math.pow(10, dbfs / 20) * Math.SQRT2
  const t = Math.tanh(bias), norm = drive * (1 - t * t)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = amp * Math.sin(2 * Math.PI * f * i / SR)
    y[i] = (Math.tanh(drive * x + bias) - t) / norm
  }
  const cyc = SR / f, N = Math.floor(n / cyc) * cyc
  const mag = h => {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const p = 2 * Math.PI * h * f * i / SR
      re += y[i] * Math.cos(p); im += y[i] * Math.sin(p)
    }
    return 2 * Math.hypot(re, im) / N
  }
  return 20 * Math.log10(mag(harm) / mag(1))
}

test('H2 is set by drive x tanh(bias), not by drive squared', () => {
  // ⚠ THE NOTE ON TUBE_BIAS SAID drive^2 * tanh(bias) FOR A LONG TIME. The
  // difference is not cosmetic: it is why H4 was expected to help and does not.
  // Pairs holding drive * tanh(bias) constant must give the same H2.
  const k = 0.01453
  const biases = [0.02, 0.06, 0.20, 0.40]
  const h2 = biases.map(b => shaperH(-18, k / Math.tanh(b), b, 2))
  for (const v of h2) {
    assert.ok(Math.abs(v - h2[0]) < 0.2,
      `constant drive*tanh(bias) should fix H2: ${h2.map(x => x.toFixed(2)).join(' / ')}`)
  }
  // And the discredited law must NOT hold — pairs holding drive^2*tanh(bias)
  // constant should disagree badly, or this test proves nothing.
  const k2 = 0.003521
  const alt = biases.map(b => shaperH(-18, Math.sqrt(k2 / Math.tanh(b)), b, 2))
  assert.ok(Math.max(...alt) - Math.min(...alt) > 6,
    `drive^2*tanh(bias) should NOT fix H2, but spread only ${(Math.max(...alt) - Math.min(...alt)).toFixed(1)} dB`)
})

test('H4 cannot settle the bias, because the model puts it below measurability', () => {
  // ⚠ THE FIRST VERSION OF THIS TEST ASSERTED THAT H4 CARRIES NO INFORMATION,
  // AND THAT WAS WRONG — it came from a kernel measurement that returned a flat
  // -106 dBc across the bias range, which is that measurement's NOISE FLOOR and
  // not a property of the shaper. Analytically H4 spreads 53 dB across the same
  // range, so it discriminates in principle.
  //
  // It still cannot settle TUBE_BIAS, for a better reason: at the level the
  // shaper actually sees at the paper's operating point (about -24 dBFS, the
  // input less 6 dB of reduction) the model predicts H4 between -127 and
  // -180 dBc. Nothing reports a fourth harmonic there, so a measured H4 could
  // not be matched by choosing a bias — it would falsify the shaper instead.
  const k = 0.01453
  const biases = [0.02, 0.06, 0.20, 0.40]
  const h4 = biases.map(b => shaperH(-24, k / Math.tanh(b), b, 4))
  assert.ok(Math.max(...h4) - Math.min(...h4) > 40,
    `H4 does discriminate in principle: spread ${(Math.max(...h4) - Math.min(...h4)).toFixed(1)} dB`)
  assert.ok(Math.max(...h4) < -120,
    `but every pair puts H4 under -120 dBc; highest was ${Math.max(...h4).toFixed(1)}`)
})
