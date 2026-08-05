/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ManualEqKernel,
  eqSections,
  processManualEqBuffer,
  MAX_BANDS,
} from '../../src/audio/eqProcessor.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'
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
  // Both views render magnitudeResponseDb(eqSections(...)). If these disagree
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
    const analytic = magnitudeResponseDb(eqSections(SR, bands), PROBE.map(binFreq), SR)
    const measured = measuredResponseDb({ bands }, PROBE)
    for (let i = 0; i < PROBE.length; i++) {
      assert.ok(
        Math.abs(analytic[i] - measured[i]) < 0.02,
        `${PROBE[i]} Hz: curve ${analytic[i].toFixed(4)}, kernel ${measured[i].toFixed(4)}`,
      )
    }
  }
})

test('an empty band pool is bit-transparent', () => {
  const n = 4096
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = 0.4 * Math.sin(i / 6) + 0.2 * Math.sin(i / 1.7)
  const { channelData } = processManualEqBuffer([sig], SR, { bands: [] })
  for (let i = 0; i < n; i++) {
    assert.equal(channelData[0][i], sig[i], `sample ${i} changed with no bands`)
  }
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
  assert.ok(channelData[0][0] !== 0, 'signal channel produced nothing')
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
