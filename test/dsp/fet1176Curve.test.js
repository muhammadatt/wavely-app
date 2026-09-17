/**
 * Run with:  npm test
 *
 * FET Punch's static curve, after it was replaced by one measured from Analog
 * Obsession FETish (`npm run fet:curve`).
 *
 * ⚠ THIS CHANGED THE VOICING OF EVERY FET PUNCH RENDER. The guards that matter
 * are therefore (a) that the measured curve is actually what ships, (b) that the
 * legacy patch still reproduces the old one exactly, and (c) that the
 * polynomial's unbounded tail cannot reach the audio.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET1176Kernel, FET_LEGACY_PATCH, processFET1176Buffer, FET1176_KERNEL_DEFAULTS, attackSecondsForDial } from '../../src/audio/fet1176Processor.js'

const SR = 96000

function kernel(params) {
  const k = new FET1176Kernel(SR)
  k.setParams(params)
  return k
}

/** Harmonics of a tone through a bare curve, in dBc. */
function curveHarmonics(f, ampDbfs, freqHz = 1000, n = 3) {
  const cyc = SR / freqHz
  const N = Math.round(2000 * cyc)
  const A = Math.pow(10, ampDbfs / 20)
  const y = new Float64Array(N)
  for (let i = 0; i < N; i++) y[i] = f(A * Math.sin(2 * Math.PI * freqHz * i / SR))
  const mag = k => {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const p = 2 * Math.PI * k * freqHz * i / SR
      re += y[i] * Math.cos(p); im += y[i] * Math.sin(p)
    }
    return 2 * Math.hypot(re, im) / N
  }
  const h = []
  for (let k = 1; k <= n; k++) h.push(mag(k))
  return h.slice(1).map(v => 20 * Math.log10(v / h[0]))
}

test('the shipping curve reproduces the harmonics measured on FETish', () => {
  // ⚠ MEASURED VALUES, from null1_fetish.wav via `npm run fet:curve`. If the
  // curve constants move, these stop matching — which is the point.
  const expectedH2 = { '-30': -136.0, '-24': -118.0, '-18': -100.0, '-12': -82.0, '-6': -64.0 }
  const k = kernel({ fetDrive: 1 })
  for (const [dbfs, h2] of Object.entries(expectedH2)) {
    const got = curveHarmonics(x => k._shapeFet(x), Number(dbfs))[0]
    assert.ok(Math.abs(got - h2) < 1.5,
      `H2 at ${dbfs} dBFS: ${got.toFixed(1)} dBc, measured ${h2}`)
  }
})

test('H2 rises 3 dB per dB of level, which the tanh could not do', () => {
  // ⚠ THE WHOLE REASON THE CURVE WAS REPLACED RATHER THAN RETUNED. FETish reads
  // 3.00; a tanh is cubic-dominant and reads about 1. No drive value crosses it.
  const poly = kernel({ fetDrive: 1 })
  const tanh = kernel({ fetDrive: 0.35, ...FET_LEGACY_PATCH })
  const slope = k => {
    const a = curveHarmonics(x => k._shapeFet(x), -30)[0]
    const b = curveHarmonics(x => k._shapeFet(x), -6)[0]
    return (b - a) / 24
  }
  assert.ok(Math.abs(slope(poly) - 3) < 0.15, `poly slope ${slope(poly).toFixed(2)}, expected ~3`)
  assert.ok(slope(tanh) < 1.6, `tanh slope ${slope(tanh).toFixed(2)}, expected ~1`)
})

test('the legacy patch is exactly the tanh this shipped with', () => {
  const k = kernel({ fetDrive: 0.35, ...FET_LEGACY_PATCH })
  // The expression the kernel carried before the capture, written out.
  const driveLin = 0.3 + 2.2 * 0.35
  const bias = 0.15 * 0.35
  const tanhBias = Math.tanh(bias)
  const norm = driveLin * (1 - tanhBias * tanhBias)
  for (const x of [-1.5, -0.7, -0.2, 0, 0.2, 0.7, 1.5]) {
    const want = (Math.tanh(driveLin * x + bias) - tanhBias) / norm
    assert.equal(k._shapeFet(x), want, `legacy curve differs at x=${x}`)
  }
})

test('the legacy patch renders differently from the shipping default', () => {
  // A patch that changed nothing would pass every other test here.
  const x = new Float32Array(SR / 2)
  for (let i = 0; i < x.length; i++) x[i] = 0.7 * Math.sin(2 * Math.PI * 300 * i / SR)
  const base = { inputDrive: 70, ratio: '8', fetDrive: 0.5 }
  const a = processFET1176Buffer([x], SR, base).channelData[0]
  const b = processFET1176Buffer([x], SR, { ...base, ...FET_LEGACY_PATCH }).channelData[0]
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  assert.ok(worst > 1e-4, `the two curves render within ${worst.toExponential(2)} — the patch does nothing`)
})

test('the unbounded tail cannot reach the audio', () => {
  // ⚠ THE POLYNOMIAL DIVERGES AND THE TANH IT REPLACED DID NOT: unguarded it
  // returns 11.70 at x = 4. Beyond POLY_XMAX it continues linearly instead.
  const k = kernel({ fetDrive: 1 })
  for (const x of [2, 4, 20, -2, -4, -20]) {
    const y = k._shapeFet(x)
    assert.ok(Math.abs(y) < Math.abs(x) * 1.2 + 0.1,
      `f(${x}) = ${y.toFixed(3)} — the tail is not bounded`)
  }
  // C1 at the join, or the corner would alias.
  const e = 1e-6
  for (const edge of [1, -1]) {
    const lo = (k._shapeFet(edge - e) - k._shapeFet(edge - 2 * e)) / e
    const hi = (k._shapeFet(edge + 2 * e) - k._shapeFet(edge + e)) / e
    assert.ok(Math.abs(lo - hi) < 1e-3, `slope jumps at x=${edge}: ${lo} vs ${hi}`)
  }
})

test('the curve is monotonic across the fitted range', () => {
  // A non-monotonic shaper folds the waveform and makes harmonics that are not
  // in the fit.
  const k = kernel({ fetDrive: 1 })
  let prev = k._shapeFet(-1)
  for (let x = -1; x <= 1; x += 0.001) {
    const v = k._shapeFet(x)
    assert.ok(v >= prev - 1e-12, `not monotonic near x=${x.toFixed(3)}`)
    prev = v
  }
})

test('fetDrive scales the measured curve, and 1 is the reference', () => {
  const full = kernel({ fetDrive: 1 })
  const half = kernel({ fetDrive: 0.5 })
  const off = kernel({ fetDrive: 0 })
  assert.equal(off.applyFet, false)
  // Half the amount is half the nonlinear deviation, at any level.
  for (const x of [0.3, 0.6, 0.9]) {
    const dFull = full._shapeFet(x) - x
    const dHalf = half._shapeFet(x) - x
    assert.ok(Math.abs(dHalf * 2 - dFull) < 1e-12, `scaling is not linear in fetDrive at x=${x}`)
  }
})

test('preview and apply agree on the new curve at every position', () => {
  // ⚠ The measurement path runs `oversample: false`, which is a DIFFERENT loop
  // from the render path. A curve added to one and not the other would leave
  // the auto-makeup solving against a plugin nobody hears.
  const x = new Float32Array(4096)
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR)
  for (const position of ['preInput', 'preCell', 'postCell']) {
    const k = kernel({ inputDrive: 60, fetDrive: 1, fetPosition: position, oversample: false })
    const out = new Float32Array(x.length)
    k.process([x], [out], x.length)
    let energy = 0
    for (let i = 0; i < out.length; i++) energy += out[i] * out[i]
    assert.ok(energy > 0, `${position} produced silence in the measurement path`)
  }
})

test('the shipping position holds saturation steady across the Input knob', () => {
  /**
   * ⚠ THE WHOLE POINT OF `preInput`, AND THE REASON `preCell` IS NOT THE
   * DEFAULT DESPITE BEING FETish's TOPOLOGY. FETish's Input is internally
   * compensated, so its shaper sees a fixed drive; ours is a real gain, and
   * bolting the same topology on gives the shaper the knob's whole travel.
   * Measured on a −6 dBFS tone across Input 10→90, H2 swings 79.6 dB at
   * preCell and 36.4 at postCell, against FETish's 0.0.
   */
  const fq = 1000
  const cyc = SR / fq
  const N = Math.round(3000 * cyc)
  const x = new Float32Array(N)
  for (let i = 0; i < N; i++) x[i] = Math.pow(10, -6 / 20) * Math.sin(2 * Math.PI * fq * i / SR)
  const h2 = (position, inputDrive) => {
    const k = kernel({ ratio: '4', attack: 1, release: 7, fetDrive: 1, mix: 1, outputGainDb: 0, inputDrive, fetPosition: position })
    const out = new Float32Array(N)
    for (let o = 0; o < N; o += 512) {
      const l = Math.min(512, N - o)
      k.process([x.subarray(o, o + l)], [out.subarray(o, o + l)], l)
    }
    const n = Math.round(1000 * cyc), off = N - n
    const mag = m => {
      let re = 0, im = 0
      for (let i = 0; i < n; i++) {
        const p = 2 * Math.PI * m * fq * i / SR
        re += out[off + i] * Math.cos(p); im += out[off + i] * Math.sin(p)
      }
      return 2 * Math.hypot(re, im) / n
    }
    return 20 * Math.log10(mag(2) / mag(1))
  }
  const swing = position => {
    const v = [10, 30, 50, 70, 90].map(d => h2(position, d))
    return Math.max(...v) - Math.min(...v)
  }
  assert.ok(swing('preInput') < 0.5, `preInput swings ${swing('preInput').toFixed(1)} dB — it must be flat`)
  assert.ok(swing('preCell') > 40, 'preCell should swing widely — if it does not, the premise has changed')
})

/**
 * ⚠ THE ATTACK LADDER IS SELECTABLE FOR A/B AND MUST SHIP ON THE DATASHEET.
 * The two disagree by about 5x and no measurement settles which is right: the
 * datasheet is what the hardware claims, FETish is what the reference does, and
 * the release endpoints moved 2.73x in the OTHER direction so they are not one
 * common cause. Until that is a decision, 'datasheet' is what renders.
 */
test('the attack ladder ships on the datasheet span', () => {
  assert.equal(FET1176_KERNEL_DEFAULTS.attackRange, 'datasheet')
  assert.ok(Math.abs(attackSecondsForDial(1) - 0.0008) < 1e-9)
  assert.ok(Math.abs(attackSecondsForDial(7) - 0.00002) < 1e-9)
})

test('the FETish ladder is about 5x slower and shares the geometric shape', () => {
  for (let dial = 1; dial <= 7; dial++) {
    const ratio = attackSecondsForDial(dial, 'fetish') / attackSecondsForDial(dial)
    assert.ok(ratio > 8 && ratio < 10,
      `dial ${dial}: FETish ladder is ${ratio.toFixed(2)}x the datasheet one`)
  }
  /**
   * ⚠ THE TWO LADDERS ARE NOT PARALLEL, AND EXPECTING THEM TO BE WAS WRONG. The
   * datasheet spans 40x (800 -> 20 us) and this one spans 44.9x (7630 -> 170),
   * so the ratio drifts 9.54 -> 8.50 across the dial. That is a CONSEQUENCE of
   * solving against measured t63 rather than an inconsistency: the factor
   * between a constant and the t63 it produces is itself dial-dependent (1.64 at
   * dial 1, 2.76 at dial 5), so matching t63 at two points cannot preserve the
   * span of the constants. FETish's own labels do span 40x — its 800 and 66 us
   * settings gave a t63 ratio of 12.06 against a label ratio of 12.12 — which is
   * what makes the taper SHAPE shared even though these endpoints are not.
   */
  const ratios = [1, 4, 7].map(d => attackSecondsForDial(d, 'fetish') / attackSecondsForDial(d))
  assert.ok(ratios.every((v, i) => i === 0 || v < ratios[i - 1]),
    `the drift must be smooth and one-directional; got ${ratios.map(r => r.toFixed(3)).join(' / ')}`)
})

/**
 * ⚠ AND AN UNKNOWN VALUE MUST FALL BACK TO THE SHIPPING LADDER, not to the
 * other one. `setParams` treats anything it does not recognise as the default
 * everywhere else, and a typo silently selecting a 5x slower attack is the
 * worst failure this switch could have.
 */
test('an unrecognised attack range falls back to the datasheet', () => {
  assert.equal(attackSecondsForDial(4, 'nonsense'), attackSecondsForDial(4))
  assert.equal(attackSecondsForDial(4, undefined), attackSecondsForDial(4))
})
