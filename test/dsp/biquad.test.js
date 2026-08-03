/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  peaking,
  highShelf,
  lowShelf,
  lowpass,
  highpass,
  notch,
  octavesToQ,
  qToOctaves,
  butterworthQs,
  BiquadCascade,
  magnitudeResponseDb,
} from '../../src/audio/dsp/biquad.js'

const SR = 44100

/**
 * Measure a cascade's actual gain at a frequency by running a sine through it
 * and reading the steady-state amplitude. Keeps magnitudeResponseDb honest —
 * an analytic response that disagrees with the filter it describes is worse
 * than no response at all, since it drives the EQ curve display.
 */
function measuredGainDb(sections, freqHz, sampleRate = SR) {
  const n = Math.max(8192, Math.ceil((sampleRate / freqHz) * 200))
  const cascade = new BiquadCascade(sections.length, 1)
  cascade.setSections(sections)
  const input = new Float64Array(n)
  for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate)
  const output = new Float64Array(n)
  cascade.process(input, output, n, 0)
  // Ignore the first half as settling time; take the peak of the tail.
  let peak = 0
  for (let i = n >> 1; i < n; i++) peak = Math.max(peak, Math.abs(output[i]))
  return 20 * Math.log10(peak)
}

test('octavesToQ round-trips with qToOctaves', () => {
  for (const oct of [0.25, 0.5, 1, 2, 3.023]) {
    assert.ok(Math.abs(qToOctaves(octavesToQ(oct)) - oct) < 1e-12)
  }
})

test('peaking filter hits its nominal gain at centre frequency', () => {
  for (const gainDb of [-12, -6, -3, 3, 6, 12]) {
    const c = peaking(SR, 1000, 1.0, gainDb)
    const measured = measuredGainDb([c], 1000)
    assert.ok(
      Math.abs(measured - gainDb) < 0.05,
      `peaking ${gainDb} dB measured ${measured.toFixed(3)}`,
    )
  }
})

test('peaking filter is unity far from centre', () => {
  const c = peaking(SR, 1000, 4.0, 12)
  assert.ok(Math.abs(measuredGainDb([c], 60)) < 0.2)
  assert.ok(Math.abs(measuredGainDb([c], 15000)) < 0.2)
})

test('magnitudeResponseDb agrees with the filter it describes', () => {
  const sections = [
    peaking(SR, 300, 1.4, -4),
    peaking(SR, 3000, 0.8, 5),
    highShelf(SR, 8000, 0.7, 3),
  ]
  const freqs = [100, 300, 800, 1500, 3000, 6000, 8000, 12000]
  const analytic = magnitudeResponseDb(sections, freqs, SR)
  for (let i = 0; i < freqs.length; i++) {
    const measured = measuredGainDb(sections, freqs[i])
    assert.ok(
      Math.abs(analytic[i] - measured) < 0.05,
      `at ${freqs[i]} Hz: analytic ${analytic[i].toFixed(3)} vs measured ${measured.toFixed(3)}`,
    )
  }
})

test('shelves reach their nominal gain in the passband', () => {
  const hs = highShelf(SR, 4000, 0.7, 6)
  assert.ok(Math.abs(measuredGainDb([hs], 18000) - 6) < 0.3)
  assert.ok(Math.abs(measuredGainDb([hs], 200)) < 0.3)

  const ls = lowShelf(SR, 200, 0.7, -6)
  assert.ok(Math.abs(measuredGainDb([ls], 40) + 6) < 0.3)
  assert.ok(Math.abs(measuredGainDb([ls], 8000)) < 0.3)
})

test('octave width behaves monotonically and differs from slope=1', () => {
  // The whole reason shelves are hand-rolled: Web Audio hard-codes S=1, while
  // the Maag air band is declared at 3.023 octaves. If those produced the same
  // curve there would be no reason to write this code.
  const wide = highShelf(SR, 14000, 3.023, 6, 'octaves')
  const s1 = highShelf(SR, 14000, 1.0, 6, 'slope')
  const probe = 6000
  const wideDb = measuredGainDb([wide], probe)
  const s1Db = measuredGainDb([s1], probe)
  assert.ok(
    Math.abs(wideDb - s1Db) > 1.0,
    `expected a materially different curve, got ${wideDb.toFixed(2)} vs ${s1Db.toFixed(2)} dB`,
  )
  // Wider shelf reaches further down in frequency.
  assert.ok(wideDb > s1Db, 'the 3-octave shelf should lift 6 kHz more than S=1 does')
})

test('lowpass/highpass are -3 dB at cutoff with Butterworth Q', () => {
  const lp = lowpass(SR, 1000, Math.SQRT1_2)
  assert.ok(Math.abs(measuredGainDb([lp], 1000) + 3.0103) < 0.05)
  const hp = highpass(SR, 1000, Math.SQRT1_2)
  assert.ok(Math.abs(measuredGainDb([hp], 1000) + 3.0103) < 0.05)
})

test('notch deeply attenuates its centre only', () => {
  const c = notch(SR, 120, 30)
  assert.ok(measuredGainDb([c], 120) < -20, 'notch should cut hard at centre')
  assert.ok(Math.abs(measuredGainDb([c], 60)) < 0.5, 'and leave an octave away alone')
  assert.ok(Math.abs(measuredGainDb([c], 240)) < 0.5)
})

test('butterworthQs gives a maximally flat 4th-order response', () => {
  const qs = butterworthQs(4)
  assert.equal(qs.length, 2)
  const sections = qs.map(q => lowpass(SR, 1000, q))
  // Flat in the passband...
  assert.ok(Math.abs(measuredGainDb(sections, 100)) < 0.05)
  assert.ok(Math.abs(measuredGainDb(sections, 300)) < 0.05)
  // ...-3 dB at cutoff...
  assert.ok(Math.abs(measuredGainDb(sections, 1000) + 3.0103) < 0.1)
  // ...and rolling off at 24 dB/octave (measured an octave into the stopband).
  const oneOct = measuredGainDb(sections, 2000)
  const twoOct = measuredGainDb(sections, 4000)
  assert.ok(
    Math.abs(twoOct - oneOct + 24) < 1.5,
    `expected ~24 dB/oct, got ${(oneOct - twoOct).toFixed(2)} dB`,
  )
})

test('air band matches FFmpeg af_biquads', () => {
  // The Maag air-band constants in server/pipeline/airBoost.js were fitted
  // against FFmpeg's realisation (fit_airboost_bands.py), so they only transfer
  // if our coefficients reproduce FFmpeg's. Golden values are FFmpeg's measured
  // impulse response for the full 6-band chain at gainDb=6; verified over
  // gainDb 3/6/12 with a worst deviation of 1.0e-3 dB, which is FFmpeg's f32
  // impulse-response quantisation rather than a coefficient difference.
  const REFERENCE_PLATEAU_DB = 12.5932
  const BANDS = [
    { freqHz: 600, type: 'bell', q: 0.5, gRef: -0.02733 },
    { freqHz: 1200, type: 'bell', q: 0.5, gRef: -0.30754 },
    { freqHz: 2400, type: 'bell', q: 0.5, gRef: -1.18676 },
    { freqHz: 4800, type: 'bell', q: 0.5, gRef: -0.90883 },
    { freqHz: 9600, type: 'bell', q: 0.5, gRef: +0.91883 },
    { freqHz: 14000, type: 'shelf', wOct: 3.023, gRef: +22.54678 },
  ]
  const scale = 6 / REFERENCE_PLATEAU_DB
  const sections = BANDS.map(b =>
    b.type === 'bell'
      ? peaking(SR, b.freqHz, b.q, b.gRef * scale, 'q')
      : highShelf(SR, b.freqHz, b.wOct, b.gRef * scale, 'octaves'),
  )

  const golden = [
    [200, 0.00771], [600, 0.12904], [1200, 0.64985], [2400, 2.03291],
    [4800, 3.86623], [9600, 5.28343], [14000, 5.55684], [18000, 5.69645],
  ]
  const freqs = golden.map(g => g[0])
  const ours = magnitudeResponseDb(sections, freqs, SR)
  for (let i = 0; i < golden.length; i++) {
    assert.ok(
      Math.abs(ours[i] - golden[i][1]) < 2e-3,
      `at ${golden[i][0]} Hz: ffmpeg ${golden[i][1]}, ours ${ours[i].toFixed(5)}`,
    )
  }

  // Low-frequency lift. NOTE: the comment at server/pipeline/airBoost.js:76
  // states "Low-frequency lift below 300 Hz is < 0.04 dB at reference plateau".
  // That is inaccurate — FFmpeg measures 0.08835 dB at 300 Hz at the plateau,
  // matching us to 8e-5 dB. The < 0.04 dB claim holds only below ~210 Hz.
  // Pinned here to the values FFmpeg actually produces.
  const atPlateau = magnitudeResponseDb(
    BANDS.map(b =>
      b.type === 'bell'
        ? peaking(SR, b.freqHz, b.q, b.gRef, 'q')
        : highShelf(SR, b.freqHz, b.wOct, b.gRef, 'octaves'),
    ),
    [50, 100, 200, 300],
    SR,
  )
  const plateauGolden = [0.00211, 0.0086, 0.0369, 0.08835]
  for (let i = 0; i < plateauGolden.length; i++) {
    assert.ok(
      Math.abs(atPlateau[i] - plateauGolden[i]) < 1e-3,
      `plateau LF at index ${i}: expected ~${plateauGolden[i]}, got ${atPlateau[i].toFixed(5)}`,
    )
  }

  // What actually matters in practice: at the gainDb=6 the presets use, the
  // sub-300 Hz lift really is negligible, which is what keeps it ACX-safe.
  const atOperating = magnitudeResponseDb(sections, [50, 100, 200, 300], SR)
  for (const v of atOperating) {
    assert.ok(v < 0.025, `operating-gain LF lift ${v.toFixed(4)} dB is higher than expected`)
  }
})

test('isolated octave-width shelf matches FFmpeg', () => {
  // The octave→alpha conversion is the part most likely to diverge, so it is
  // pinned on its own. Golden values from FFmpeg
  // `highshelf=f=14000:width_type=o:w=3.023:g=6`.
  const c = highShelf(SR, 14000, 3.023, 6, 'octaves')
  const measured = magnitudeResponseDb([c], [6000], SR)[0]
  assert.ok(Math.abs(measured - 2.67) < 5e-3, `at 6 kHz got ${measured.toFixed(4)}`)
})

test('cascade keeps per-channel state independent', () => {
  const c = lowpass(SR, 500, 0.7)
  const cascade = new BiquadCascade(1, 2)
  cascade.setSections([c])

  const n = 64
  const impulse = new Float64Array(n)
  impulse[0] = 1
  const silence = new Float64Array(n)

  const outL = new Float64Array(n)
  const outR = new Float64Array(n)
  cascade.process(impulse, outL, n, 0)
  cascade.process(silence, outR, n, 1)

  assert.ok(outL[0] > 0, 'left channel should respond to its impulse')
  for (let i = 0; i < n; i++) {
    assert.equal(outR[i], 0, `right channel leaked at ${i}: ${outR[i]}`)
  }
})

test('ensureChannels widens without disturbing existing channels', () => {
  const c = lowpass(SR, 500, 0.7)
  const wide = new BiquadCascade(1, 2)
  wide.setSections([c])
  const narrow = new BiquadCascade(1, 1)
  narrow.setSections([c])

  const n = 128
  const sig = new Float64Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin(i / 5)

  // Run half the signal through both, then widen the narrow one mid-stream.
  const half = n >> 1
  const a = new Float64Array(n)
  const b = new Float64Array(n)
  wide.process(sig, a, half, 0)
  narrow.process(sig, b, half, 0)
  narrow.ensureChannels(4)
  assert.equal(narrow.channelCount, 4)
  wide.process(sig.subarray(half), a.subarray(half), half, 0)
  narrow.process(sig.subarray(half), b.subarray(half), half, 0)

  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-15, `state lost on widen at ${i}`)
  }
  // Narrowing is a no-op rather than a truncation.
  narrow.ensureChannels(2)
  assert.equal(narrow.channelCount, 4)
})

test('reset clears state', () => {
  const cascade = new BiquadCascade(1, 1)
  cascade.setSections([lowpass(SR, 500, 0.7)])
  const n = 32
  const impulse = new Float64Array(n)
  impulse[0] = 1
  const a = new Float64Array(n)
  cascade.process(impulse, a, n, 0)
  cascade.reset()
  const b = new Float64Array(n)
  cascade.process(impulse, b, n, 0)
  for (let i = 0; i < n; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-15)
})
