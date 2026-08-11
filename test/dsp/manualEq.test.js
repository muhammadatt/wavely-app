/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ManualEqKernel,
  eqSections,
  eqResponseDb,
  processManualEqBuffer,
  EQ_LATENCY_SAMPLES,
  MAX_BANDS,
} from '../../src/audio/eqProcessor.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const N = 32768

function band(overrides = {}) {
  return {
    type: 'peaking', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true, ...overrides,
  }
}

/**
 * Snap a probe frequency to the FFT bin that will actually be read.
 *
 * A measured response can only be sampled at bin centres, and at N = 32768 the
 * nearest bin to 50 Hz is 49.79 Hz. On a gentle curve that is invisible; on the
 * 12 dB/octave skirt of a highpass it is worth 0.05 dB, which is enough to fail
 * a tolerance that is otherwise measuring something real. Compare both sides at
 * the bin frequency so the test is about the filter, not about interpolation.
 */
function binFreq(f) {
  return (Math.round((f * N) / SR) * SR) / N
}

/** True frequency response of the kernel, measured from its impulse response. */
function measuredResponseDb(params, freqs) {
  const amp = 0.25
  const imp = new Float32Array(N)
  imp[0] = amp
  const { channelData } = processManualEqBuffer([imp], SR, params)

  const fft = getFFT(N)
  const bins = rfftBinCount(N)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(channelData[0], re, im)

  return freqs.map(f => {
    const k = Math.round((f * N) / SR)
    return 20 * Math.log10(Math.hypot(re[k], im[k]) / amp)
  })
}

const PROBE = [50, 120, 300, 800, 1000, 2500, 5000, 9000, 15000]

test('kernel response matches the curve the UI draws', () => {
  // Both views render eqResponseDb(...). If these disagree
  // the display is lying about what is being applied — which in a tool whose
  // entire premise is "drag this and hear it" is the one unforgivable bug.
  const cases = [
    [band({ frequencyHz: 280, gainDb: -6, q: 2 })],
    [band({ type: 'lowshelf', frequencyHz: 100, gainDb: -8, q: 0.7 })],
    [band({ type: 'highshelf', frequencyHz: 12000, gainDb: 5, q: 0.7 })],
    [
      band({ frequencyHz: 300, gainDb: -4, q: 2 }),
      band({ frequencyHz: 3000, gainDb: 3, q: 1.5 }),
      band({ type: 'highshelf', frequencyHz: 10000, gainDb: 4, q: 0.7 }),
    ],
    [
      band({ type: 'highpass', frequencyHz: 80, q: 0.707 }),
      band({ type: 'notch', frequencyHz: 1000, q: 8 }),
    ],
  ]

  for (const bands of cases) {
    const analytic = eqResponseDb(SR, bands, PROBE.map(binFreq))
    const measured = measuredResponseDb({ bands }, PROBE)
    for (let i = 0; i < PROBE.length; i++) {
      assert.ok(
        Math.abs(analytic[i] - measured[i]) < 0.02,
        `${PROBE[i]} Hz: curve ${analytic[i].toFixed(4)}, kernel ${measured[i].toFixed(4)}`,
      )
    }
  }
})

test('an empty band pool is transparent, delayed by exactly the reported latency', () => {
  // This used to assert bit-transparency. The cascade now runs oversampled, and
  // the resamplers run even with no bands — deliberately, so that latency is the
  // same whatever the band list says. Disabling the last band would otherwise
  // move the whole timeline under the apply path, which trims a fixed count.
  //
  // So the property is no longer "unchanged" but "unchanged except for a known
  // delay", which is what the apply path compensates and what the chain can
  // absorb. The residual is the resampling filters' own error.
  const n = 4096
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = 0.4 * Math.sin(i / 6) + 0.2 * Math.sin(i / 1.7)
  const { channelData, latencySamples } = processManualEqBuffer([sig], SR, { bands: [] })

  assert.equal(latencySamples, EQ_LATENCY_SAMPLES)

  let err = 0
  let ref = 0
  for (let i = EQ_LATENCY_SAMPLES + 64; i < n; i++) {
    const d = channelData[0][i] - sig[i - EQ_LATENCY_SAMPLES]
    err += d * d
    ref += sig[i - EQ_LATENCY_SAMPLES] ** 2
  }
  const errDb = 10 * Math.log10(err / ref)
  assert.ok(errDb < -80, `empty pool is not transparent: ${errDb.toFixed(1)} dB of error`)
})

test('disabled bands are inaudible but keep their slot', () => {
  const active = [band({ frequencyHz: 500, gainDb: -9, q: 2 })]
  const withDisabled = [
    band({ frequencyHz: 200, gainDb: 12, q: 1, enabled: false }),
    active[0],
    band({ frequencyHz: 8000, gainDb: -15, q: 3, enabled: false }),
  ]
  const a = measuredResponseDb({ bands: active }, PROBE)
  const b = measuredResponseDb({ bands: withDisabled }, PROBE)
  for (let i = 0; i < PROBE.length; i++) {
    assert.ok(
      Math.abs(a[i] - b[i]) < 1e-9,
      `disabled band leaked at ${PROBE[i]} Hz: ${a[i]} vs ${b[i]}`,
    )
  }
})

test('toggling one band does not disturb the others', () => {
  // The reason unused slots hold a pass-through instead of the cascade being
  // rebuilt: a rebuild resets every filter's state, which in a live graph is an
  // audible click on every band add, remove and bypass.
  const bands = [
    band({ frequencyHz: 300, gainDb: -5, q: 2 }),
    band({ frequencyHz: 4000, gainDb: 4, q: 1.5 }),
  ]
  const kernel = new ManualEqKernel(SR)
  kernel.setParams({ bands })

  const n = 1024
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin(i / 5) * 0.3
  const warm = new Float32Array(n)
  kernel.process([sig], [warm], n)

  // Capture the filter memories, toggle a band off and on, and confirm the
  // untouched sections resumed from exactly where they were.
  const z1Before = Float64Array.from(kernel.cascade.z1)
  kernel.setParams({ bands: [bands[0], { ...bands[1], enabled: false }] })
  kernel.setParams({ bands })
  assert.deepEqual(
    Array.from(kernel.cascade.z1), Array.from(z1Before),
    'filter state was reset by a band toggle',
  )
})

test('band list is capped at MAX_BANDS', () => {
  const many = Array.from({ length: MAX_BANDS + 5 }, (_, i) =>
    band({ frequencyHz: 100 * (i + 1), gainDb: 3, q: 1 }))
  assert.equal(eqSections(SR, many).length, MAX_BANDS)
})

test('solo replaces the chain with a monitor filter', () => {
  const bands = [
    band({ frequencyHz: 200, gainDb: -6, q: 2 }),
    band({ frequencyHz: 3000, gainDb: 6, q: 4 }),
  ]
  const soloed = measuredResponseDb({ bands, soloIndex: 1 }, [200, 3000, 15000])

  // A soloed band must actually isolate its region. A peaking bell is not its
  // own monitor — at +6 dB it passes everything — so solo swaps in a bandpass.
  assert.ok(soloed[1] > soloed[0] + 20, 'solo did not attenuate below the band')
  assert.ok(soloed[1] > soloed[2] + 20, 'solo did not attenuate above the band')
})

test('a solo probe monitors a region with no band behind it', () => {
  // VoiceRx auditions a role before anything has been turned up, so the monitor
  // filter cannot depend on a band existing to hang it on.
  const probed = measuredResponseDb(
    { bands: [], soloProbe: { type: 'peaking', frequencyHz: 3000, q: 4 } },
    [200, 3000, 15000],
  )
  assert.ok(probed[1] > probed[0] + 20, 'probe did not attenuate below the region')
  assert.ok(probed[1] > probed[2] + 20, 'probe did not attenuate above the region')
})

test('a solo probe wins over a solo index', () => {
  const bands = [band({ frequencyHz: 200, gainDb: -6, q: 2 })]
  const db = eqResponseDb(SR, bands, [200, 6000], {
    soloIndex: 0,
    soloProbe: { type: 'peaking', frequencyHz: 6000, q: 3 },
  })
  assert.ok(db[1] > db[0] + 20, 'the index was monitored instead of the probe')
})

test('an incomplete solo probe is ignored rather than silencing the chain', () => {
  const bands = [band({ frequencyHz: 1000, gainDb: 6, q: 1 })]
  const sections = eqSections(SR, bands, { soloProbe: { type: 'peaking', q: 2 } })
  assert.equal(sections.length, 1)
  const db = eqResponseDb(SR, bands, [1000], { soloProbe: { type: 'peaking', q: 2 } })
  assert.ok(db[0] > 5, 'the band was not left running')
})

test('output trim is a clean gain', () => {
  const bands = [band({ frequencyHz: 1000, gainDb: 4, q: 1 })]
  const n = 2048
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = 0.3 * Math.sin(i / 9)
  const flat = processManualEqBuffer([sig], SR, { bands }).channelData[0]
  const trimmed = processManualEqBuffer(
    [sig], SR, { bands, outputGainDb: -6 },
  ).channelData[0]
  const expected = Math.pow(10, -6 / 20)
  for (let i = 512; i < n; i++) {
    assert.ok(Math.abs(trimmed[i] - flat[i] * expected) < 1e-6, `trim mismatch at ${i}`)
  }
})

test('channels are filtered independently', () => {
  const bands = [band({ frequencyHz: 1000, gainDb: 8, q: 2 })]
  const n = 512
  const impulse = new Float32Array(n)
  impulse[0] = 1
  const silence = new Float32Array(n)
  const { channelData } = processManualEqBuffer([impulse, silence], SR, { bands })
  let energy = 0
  for (let i = 0; i < n; i++) energy += Math.abs(channelData[1][i])
  assert.equal(energy, 0, 'silent channel picked up the other channel’s impulse')

  // Measured over the whole block rather than at sample 0: the oversampler is
  // linear phase, so the impulse arrives EQ_LATENCY_SAMPLES late.
  let signalEnergy = 0
  for (let i = 0; i < n; i++) signalEnergy += Math.abs(channelData[0][i])
  assert.ok(signalEnergy > 0, 'signal channel produced nothing')
})

test('block size does not change the result', () => {
  const bands = [
    band({ frequencyHz: 300, gainDb: -5, q: 2 }),
    band({ type: 'highshelf', frequencyHz: 9000, gainDb: 4, q: 0.7 }),
  ]
  const n = 5000
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin(i / 11) * 0.3

  const oneShot = processManualEqBuffer([sig], SR, { bands }).channelData[0]

  const kernel = new ManualEqKernel(SR)
  kernel.setParams({ bands })
  const chunked = new Float32Array(n)
  let off = 0
  for (const size of [1, 7, 128, 999, 333]) {
    const len = Math.min(size, n - off)
    if (len <= 0) break
    kernel.process([sig.subarray(off, off + len)], [chunked.subarray(off, off + len)], len)
    off += len
  }
  while (off < n) {
    const len = Math.min(128, n - off)
    kernel.process([sig.subarray(off, off + len)], [chunked.subarray(off, off + len)], len)
    off += len
  }

  let maxErr = 0
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(oneShot[i] - chunked[i]))
  assert.ok(maxErr < 1e-6, `block-size dependence: max error ${maxErr}`)
})

test('a band at Nyquist does not vanish or blow up', () => {
  // Dragging a band to the top of the range must not produce NaN coefficients,
  // and must not silently drop the band either.
  const sections = eqSections(SR, [band({ frequencyHz: 20000, gainDb: 6, q: 1 })])
  assert.equal(sections.length, 1)
  for (const v of Object.values(sections[0])) {
    assert.ok(Number.isFinite(v), `non-finite coefficient near Nyquist: ${v}`)
  }
})

// ── Cramping / response accuracy ────────────────────────────────────────────
//
// The reason the cascade runs oversampled at all. The bilinear transform maps
// the analog frequency axis' infinite range onto a finite digital one, so
// everything the analog prototype does between the design frequency and
// infinity gets compressed into the space below Nyquist. On a 44.1 kHz file a
// wide bell at 10 kHz came out more than 1.4 dB shy of its prototype across
// 8-16 kHz, which on narration was invisible and on cymbals and air is not.
//
// These assert the accuracy that oversampling bought, so that a future change
// to the profile — or a well-meaning "simplification" back to the base rate —
// fails here rather than in someone's mix.

/** RBJ's analog peaking prototype: H(s) = (s² + s·A/Q + 1)/(s² + s/(A·Q) + 1). */
function analogPeakingDb(freqHz, centreHz, q, gainDb) {
  const A = Math.pow(10, gainDb / 40)
  const w = freqHz / centreHz
  return 20 * Math.log10(
    Math.hypot(1 - w * w, (w * A) / q) / Math.hypot(1 - w * w, w / (A * q)),
  )
}

/** RBJ's analog high-shelf prototype. */
function analogHighShelfDb(freqHz, cornerHz, q, gainDb) {
  const A = Math.pow(10, gainDb / 40)
  const w = freqHz / cornerHz
  const sqrtA = Math.sqrt(A)
  return 20 * Math.log10(
    (A * Math.hypot(1 - A * w * w, (w * sqrtA) / q))
    / Math.hypot(A - w * w, (w * sqrtA) / q),
  )
}

test('high-frequency bells track their analog prototype', () => {
  // 0.6 dB is the budget for bells a musical move would actually use — wide to
  // moderately narrow, ordinary gains. Measured worst across these cases is
  // 0.53 dB (the 9 kHz cut; deeper cuts have steeper skirts and so a larger
  // error in dB), against 2.13 dB for the same band at the base rate. Every
  // case improves by roughly 4x. The extreme corner of the control range is a
  // separate test below, because it does not meet this bound and pretending
  // otherwise would just be a tolerance tuned until it passed.
  const TOLERANCE_DB = 0.6
  const cases = [
    { frequencyHz: 8000, q: 0.7, gainDb: 4 },
    { frequencyHz: 10000, q: 0.7, gainDb: 4 },
    { frequencyHz: 12000, q: 0.7, gainDb: 4 },
    { frequencyHz: 10000, q: 2, gainDb: 4 },
    { frequencyHz: 12000, q: 4, gainDb: -6 },
    { frequencyHz: 9000, q: 1, gainDb: -8 },
  ]
  const probes = []
  for (let f = 4000; f <= 16000; f += 500) probes.push(f)

  for (const spec of cases) {
    const bands = [band(spec)]
    const got = eqResponseDb(SR, bands, probes)
    for (let i = 0; i < probes.length; i++) {
      const want = analogPeakingDb(probes[i], spec.frequencyHz, spec.q, spec.gainDb)
      assert.ok(
        Math.abs(got[i] - want) < TOLERANCE_DB,
        `bell ${spec.frequencyHz} Hz Q=${spec.q}: at ${probes[i]} Hz got `
        + `${got[i].toFixed(2)} dB, analog ${want.toFixed(2)} dB`,
      )
    }
  }
})

test('high shelves track their analog prototype', () => {
  const TOLERANCE_DB = 0.3
  for (const spec of [
    { type: 'highshelf', frequencyHz: 8000, q: 0.7, gainDb: 4 },
    { type: 'highshelf', frequencyHz: 10000, q: 0.7, gainDb: 4 },
    { type: 'highshelf', frequencyHz: 12000, q: 0.7, gainDb: -5 },
  ]) {
    const got = eqResponseDb(SR, [band(spec)], [4000, 8000, 12000, 16000, 20000])
    const probes = [4000, 8000, 12000, 16000, 20000]
    for (let i = 0; i < probes.length; i++) {
      const want = analogHighShelfDb(probes[i], spec.frequencyHz, spec.q, spec.gainDb)
      assert.ok(
        Math.abs(got[i] - want) < TOLERANCE_DB,
        `shelf ${spec.frequencyHz} Hz: at ${probes[i]} Hz got ${got[i].toFixed(2)} dB, `
        + `analog ${want.toFixed(2)} dB`,
      )
    }
  }
})

test('a bell keeps its nominal gain at its centre', () => {
  // Cramping never moved the centre gain — that was always exact, and it has to
  // stay exact, because it is the number printed on the control.
  for (const frequencyHz of [100, 1000, 8000, 12000, 16000, 20000]) {
    for (const gainDb of [-12, -6, 6, 12]) {
      const got = eqResponseDb(SR, [band({ frequencyHz, gainDb, q: 2 })], [frequencyHz])[0]
      assert.ok(
        Math.abs(got - gainDb) < 0.01,
        `${frequencyHz} Hz at ${gainDb} dB measured ${got.toFixed(3)}`,
      )
    }
  }
})

test('the kernel really applies the uncramped response, not just the curve', () => {
  // eqResponseDb is analytic. This measures the running kernel's impulse
  // response, so a bug that uncramped the display while leaving the audio at
  // the base rate cannot pass.
  const spec = { frequencyHz: 10000, q: 0.7, gainDb: 4 }
  const probes = [8000, 10000, 12000, 14000, 16000]
  const measured = measuredResponseDb({ bands: [band(spec)] }, probes)
  for (let i = 0; i < probes.length; i++) {
    const want = analogPeakingDb(probes[i], spec.frequencyHz, spec.q, spec.gainDb)
    assert.ok(
      Math.abs(measured[i] - want) < 0.3,
      `kernel at ${probes[i]} Hz: measured ${measured[i].toFixed(2)} dB, `
      + `analog ${want.toFixed(2)} dB`,
    )
  }
})

test('the extreme corner of the control range is improved, not solved', () => {
  // Q=10 at ±18 dB centred at 16 kHz is the worst the UI can ask for: a nearly
  // vertical skirt right up against Nyquist, where a small warping of the
  // frequency axis is worth a lot of dB. 2x brings it from 6.9 dB of deviation
  // to 1.5; 4x would reach 0.35 for 70% more CPU across the whole plugin.
  //
  // Staying at 2x is a deliberate call, and it is defensible because the curve
  // on screen is drawn from these same coefficients — the user sees the filter
  // they are getting. What is left is fidelity to an analog prototype nobody is
  // comparing against, not a control that misbehaves.
  //
  // This test exists to keep that honest: if the residual is ever claimed to be
  // gone, it should have to change here.
  const probes = []
  for (let f = 4000; f <= 16000; f += 250) probes.push(f)

  const spec = { frequencyHz: 16000, q: 10, gainDb: 18 }
  const got = eqResponseDb(SR, [band(spec)], probes)
  let worst = 0
  for (let i = 0; i < probes.length; i++) {
    const want = analogPeakingDb(probes[i], spec.frequencyHz, spec.q, spec.gainDb)
    worst = Math.max(worst, Math.abs(got[i] - want))
  }
  assert.ok(worst < 2.0, `extreme bell deviates by ${worst.toFixed(2)} dB, expected < 2`)
  assert.ok(worst > 0.5, `extreme bell deviates by only ${worst.toFixed(2)} dB — `
    + 'better than the 2x profile can do, so this test is measuring something else now')
})
