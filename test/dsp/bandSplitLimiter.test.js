import test from 'node:test'
import assert from 'node:assert/strict'
import { BandSplitLimiter } from '../../src/audio/dsp/bandSplitLimiter.js'
import { LookaheadLimiter } from '../../src/audio/dsp/lookaheadLimiter.js'

const SR = 48000
const L = Math.round(0.002 * SR)
const db = v => 20 * Math.log10(v + 1e-300)

function tone(f, n, amp = 1) {
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / SR)
  return x
}

/** RMS of the output over the second half, against the input's own RMS. */
function gainAt(x, y, D) {
  let num = 0, den = 0
  const start = Math.floor(x.length / 2)
  for (let i = start; i + D < x.length; i++) {
    num += y[i + D] ** 2
    den += x[i] ** 2
  }
  return Math.sqrt(num / den)
}

function run(lim, x, threshold) {
  const y = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = lim.processSample(x[i], threshold)
  return y
}

test('reconstruction is magnitude-flat — the bands sum back to the input', () => {
  // Limiters idle: threshold well above anything in the signal, so every band
  // gain is 1 and the only thing left is the crossover.
  for (const xo of [[700], [300, 3000]]) {
    for (const f of [60, 120, 300, 700, 1500, 3000, 8000, 15000]) {
      const bsl = new BandSplitLimiter(L, xo, SR)
      const x = tone(f, 24000)
      const y = run(bsl, x, 10)
      const g = db(gainAt(x, y, bsl.latencySamples))
      assert.ok(Math.abs(g) < 0.06, `${xo.join('/')} at ${f} Hz: ${g.toFixed(3)} dB`)
    }
  }
})

test('the allpass correction only earns its keep when the crossovers are close', () => {
  // Neuter the correction the way forgetting it would. WHAT THE MUTATION COSTS
  // DEPENDS ENTIRELY ON THE SPACING, and this is worth knowing before choosing
  // crossovers: the error is (1 - AP(f2)) * LP(f1), and AP(f2) is ~1 wherever
  // LP(f1) still has content, so the two have to overlap for it to matter.
  // Measured: at 300/3000 Hz — 3.3 octaves apart, the pair the soft clipper
  // uses — dropping it costs 0.09 dB, which is why a test written at those
  // crossovers passes under the mutation and guards nothing. At 400/800 Hz it
  // costs 2.8 dB.
  const mutate = xo => {
    const bsl = new BandSplitLimiter(L, xo, SR)
    for (const s of bsl.stages) s.corrections.forEach(c => { c.b0 = 1; c.b1 = 0; c.b2 = 0; c.a1 = 0; c.a2 = 0 })
    const x = tone(xo[0], 24000)
    return db(gainAt(x, run(bsl, x, 10), bsl.latencySamples))
  }
  assert.ok(mutate([400, 800]) < -2, `close crossovers should break: ${mutate([400, 800]).toFixed(3)} dB`)
  assert.ok(Math.abs(mutate([300, 3000])) < 0.2, 'wide crossovers barely notice, which is the trap')

  // And with the correction in place, the close pair reconstructs.
  const bsl = new BandSplitLimiter(L, [400, 800], SR)
  const x = tone(400, 24000)
  assert.ok(Math.abs(db(gainAt(x, run(bsl, x, 10), bsl.latencySamples))) < 0.06)
})

test('a quiet high band survives a loud low peak — the whole point', () => {
  // A 120 Hz plosive-shaped burst well over the threshold, with a steady 8 kHz
  // tone 20 dB under it. The broadband limiter hands the plosive's gain
  // reduction to the 8 kHz tone; the split does not.
  const n = 24000
  const T = 0.2
  const x = new Float64Array(n)
  const hf = tone(8000, n, T * 0.1)
  for (let i = 0; i < n; i++) {
    const env = i > 8000 && i < 8600 ? 1 : 0
    x[i] = env * 0.9 * Math.sin((2 * Math.PI * 120 * i) / SR) + hf[i]
  }
  // Measure the 8 kHz tone's level in a window AFTER the burst but still inside
  // the broadband envelope's release.
  const bandLevel = (y, D) => {
    let s = 0, c = 0
    for (let i = 8600; i < 8600 + L; i++) { s += y[i + D] ** 2; c++ }
    return Math.sqrt(s / c)
  }
  const ref = bandLevel(x, 0)
  const wide = new LookaheadLimiter(L)
  const wideLevel = bandLevel(run(wide, x, T), wide.latencySamples)
  const bsl = new BandSplitLimiter(L, [300, 3000], SR)
  const splitLevel = bandLevel(run(bsl, x, T), bsl.latencySamples)

  assert.ok(db(wideLevel / ref) < -3, `broadband should duck the HF, got ${db(wideLevel / ref).toFixed(2)} dB`)
  assert.ok(db(splitLevel / ref) > db(wideLevel / ref) + 2,
    `split ${db(splitLevel / ref).toFixed(2)} dB vs broadband ${db(wideLevel / ref).toFixed(2)} dB`)
})

test('N bands each at T can sum past T — the guarantee is measured, not structural', () => {
  // Broadband content is the worst case: every band sees the same transient,
  // every band limits to T independently, and the sum lands near N*T. This is
  // the cost the header warns about, pinned so it cannot be forgotten.
  //
  // ⚠ AN IMPULSE CANNOT PROBE THIS — measured, it overshoots by 0.00 dB at two
  // bands. LR4 smears an impulse over tens of samples and the bands' peaks
  // arrive at different instants, so they never add. It takes SUSTAINED
  // broadband content for the bands to be simultaneously over the ceiling.
  const n = 9000
  const x = new Float64Array(n)
  let seed = 1
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    x[i] = (i > 3000 && i < 3600 ? 0.9 : 0.01) * ((seed / 0x7fffffff) * 2 - 1)
  }
  const T = 0.05
  for (const [xo, atLeast] of [[[700], 4], [[300, 3000], 6]]) {
    const bsl = new BandSplitLimiter(L, xo, SR)
    const y = run(bsl, x, T)
    let pk = 0
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(db(pk / T) > atLeast, `${xo.join('/')}: only ${db(pk / T).toFixed(2)} dB over`)
  }
})

test('ceilingFactor = 1/nBands restores the bound, and the safety pass restores it exactly', () => {
  const n = 8000
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 90 * i) / SR) * (i > 3000 && i < 3400 ? 0.99 : 0.02)
  const T = 0.05
  for (const [opts, slack] of [[{ ceilingFactor: 1 / 3 }, 1.0001], [{ safety: true }, 1.0001]]) {
    const bsl = new BandSplitLimiter(L, [300, 3000], SR, opts)
    const y = run(bsl, x, T)
    let pk = 0
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i]))
    assert.ok(pk <= T * slack, `${JSON.stringify(opts)}: peak ${db(pk / T).toFixed(3)} dB over T`)
  }
})

test('latency is what it says, and the safety pass doubles it', () => {
  for (const [opts, expected] of [[{}, 2 * L], [{ safety: true }, 4 * L]]) {
    const bsl = new BandSplitLimiter(L, [300, 3000], SR, opts)
    assert.equal(bsl.latencySamples, expected)
    // Find where an impulse actually lands rather than trusting the number.
    const n = 8 * L
    const x = new Float64Array(n)
    x[L] = 1
    const y = run(bsl, x, 10)
    let bi = 0, bv = 0
    for (let i = 0; i < n; i++) if (Math.abs(y[i]) > bv) { bv = Math.abs(y[i]); bi = i }
    // The crossover smears an impulse, so allow the peak to sit a few samples
    // either side of the group delay rather than exactly on it.
    assert.ok(Math.abs(bi - (L + expected)) < 0.05 * expected,
      `impulse landed at ${bi}, expected near ${L + expected}`)
  }
})

test('reset makes an instance identical to a fresh one', () => {
  const x = new Float64Array(4000)
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 200 * i) / SR) * 0.8
  const a = new BandSplitLimiter(L, [300, 3000], SR)
  run(a, x, 0.1)
  a.reset()
  const b = new BandSplitLimiter(L, [300, 3000], SR)
  const ya = run(a, x, 0.1)
  const yb = run(b, x, 0.1)
  for (let i = 0; i < x.length; i++) assert.equal(ya[i], yb[i])
})
