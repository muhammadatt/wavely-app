/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VocalSatKernel,
  VOCAL_SAT_KERNEL_DEFAULTS,
  processVocalSatBuffer,
} from '../../src/audio/vocalSatProcessor.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100

function rms(buf, from = 0) {
  let s = 0
  for (let i = from; i < buf.length; i++) s += buf[i] * buf[i]
  return Math.sqrt(s / (buf.length - from))
}

function tone(n, freqHz, amp = 0.4) {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / SR)
  return out
}

test('is transparent at zero drive and zero bias', () => {
  // transfer(0*x + 0) === 0, so wet is silent and the blend collapses to dry.
  const n = 8192
  const sig = tone(n, 220)
  const { channelData } = processVocalSatBuffer([sig], SR, {
    drive: 0, bias: 0, wetDry: 0.5,
  })
  let maxErr = 0
  for (let i = 1000; i < n; i++) maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i]))
  assert.ok(maxErr < 1e-5, `not transparent: max error ${maxErr}`)
})

test('is transparent at zero wet/dry', () => {
  const n = 8192
  const sig = tone(n, 220)
  const { channelData } = processVocalSatBuffer([sig], SR, { wetDry: 0 })
  let maxErr = 0
  for (let i = 1000; i < n; i++) maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i]))
  assert.ok(maxErr < 1e-5, `not transparent: max error ${maxErr}`)
})

test('is level-neutral, which is the point of the double RMS match', () => {
  const n = SR // one second, well past the 300 ms follower
  for (const amp of [0.05, 0.2, 0.6]) {
    const sig = tone(n, 180, amp)
    const { channelData } = processVocalSatBuffer([sig], SR, VOCAL_SAT_KERNEL_DEFAULTS)
    const inDb = 20 * Math.log10(rms(sig, SR / 2))
    const outDb = 20 * Math.log10(rms(channelData[0], SR / 2))
    assert.ok(
      Math.abs(outDb - inDb) < 0.6,
      `amp ${amp}: in ${inDb.toFixed(2)} dB, out ${outDb.toFixed(2)} dB`,
    )
  }
})

test('primed followers keep the opening of a region level-matched', () => {
  // Without RmsFollower priming the first ~300 ms reads far too quiet and the
  // two gain divisions overshoot, leaving an audible step at a selection edge.
  const n = SR
  const sig = tone(n, 180, 0.4)
  const { channelData } = processVocalSatBuffer([sig], SR, VOCAL_SAT_KERNEL_DEFAULTS)

  // Compare the first 20 ms against the settled tail.
  const head = rms(channelData[0].subarray(0, Math.floor(SR * 0.02)))
  const tail = rms(channelData[0].subarray(Math.floor(SR * 0.7)))
  const stepDb = 20 * Math.log10(head / tail)
  assert.ok(
    Math.abs(stepDb) < 1.5,
    `region opens ${stepDb.toFixed(2)} dB away from its settled level`,
  )
})

test('actually adds harmonics', () => {
  const n = 32768
  const f0 = 220
  const sig = tone(n, f0, 0.4)
  const { channelData } = processVocalSatBuffer([sig], SR, {
    ...VOCAL_SAT_KERNEL_DEFAULTS,
    drive: 3,
    wetDry: 0.8,
  })

  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(channelData[0], re, im)

  const at = f => {
    const k = Math.round((f * n) / SR)
    return Math.hypot(re[k], im[k])
  }
  const fundamental = at(f0)
  const second = at(f0 * 2)
  const third = at(f0 * 3)
  assert.ok(second / fundamental > 1e-3, `no 2nd harmonic (${second / fundamental})`)
  assert.ok(third / fundamental > 1e-3, `no 3rd harmonic (${third / fundamental})`)
})

test('bias asymmetry produces even harmonics', () => {
  // A symmetric transfer generates odd harmonics only; the bias term is what
  // gives the "tube" second harmonic.
  const n = 32768
  const f0 = 220
  const sig = tone(n, f0, 0.4)

  const measureSecond = biasValue => {
    const { channelData } = processVocalSatBuffer([sig], SR, {
      ...VOCAL_SAT_KERNEL_DEFAULTS, drive: 3, wetDry: 0.8, bias: biasValue,
    })
    const fft = getFFT(n)
    const bins = rfftBinCount(n)
    const re = new Float64Array(bins)
    const im = new Float64Array(bins)
    fft.rfft(channelData[0], re, im)
    const at = f => {
      const k = Math.round((f * n) / SR)
      return Math.hypot(re[k], im[k])
    }
    return at(f0 * 2) / at(f0)
  }

  assert.ok(
    measureSecond(0.5) > measureSecond(0) * 5,
    'bias should raise the second harmonic substantially',
  )
})

/**
 * Alias-to-signal ratio in dB for a bin-centred tone.
 *
 * The tone must complete exactly `cycles` periods in the FFT length. That
 * gives zero spectral leakage, so every bin that is not a multiple of `cycles`
 * is genuinely alias energy rather than a smeared harmonic. Measuring with a
 * non-bin-centred tone reads ~80 dB worse purely from leakage.
 *
 * Analysis runs on a settled window, past the filter and follower warmup.
 */
function aliasToSignalDb(params, cycles, amp = 0.4) {
  const n = 32768
  const f0 = (cycles * SR) / n
  const total = n * 3
  const sig = new Float32Array(total)
  for (let i = 0; i < total; i++) sig[i] = amp * Math.sin((2 * Math.PI * f0 * i) / SR)

  const { channelData } = processVocalSatBuffer([sig], SR, params)
  const settled = channelData[0].subarray(total - n)

  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(settled, re, im)

  let harmonic = 0
  let alias = 0
  for (let k = 1; k < bins; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    if (k % cycles === 0) harmonic += p
    else alias += p
  }
  return 10 * Math.log10(alias / harmonic)
}

test('aliasing stays inaudible without oversampling', () => {
  // The Python oversamples 2x whenever a band's effective drive reaches 0.5,
  // and at default settings the low band runs at 10. This kernel does not
  // oversample, because a streaming 2x up/down pair costs 7 samples of latency
  // and would make this a latent effect. These numbers are what that decision
  // actually costs — all far below anything audible.
  //
  // Measured: -91.8 dB at defaults, -87.2 dB on a 122 Hz tone, -92.6 dB even
  // at drive 5 (low band effective drive 25), -79.1 dB fully wet.
  const D = VOCAL_SAT_KERNEL_DEFAULTS
  const cases = [
    ['defaults', D, 235, 0.4],
    ['low tone', D, 91, 0.4],
    ['hot input', D, 235, 0.8],
    ['drive 5', { ...D, drive: 5 }, 235, 0.4],
    ['fully wet', { ...D, wetDry: 1 }, 235, 0.4],
    ['mid-band tone', D, 1486, 0.4],
  ]
  for (const [label, params, cycles, amp] of cases) {
    const db = aliasToSignalDb(params, cycles, amp)
    assert.ok(
      db < -70,
      `${label}: alias/signal ${db.toFixed(1)} dB — oversampling may now be needed`,
    )
  }
})

test('a near-linear band produces essentially no aliasing', () => {
  // Sanity check on the measurement itself: drop the low band's drive below
  // the point where the transfer curves and the number should fall away.
  const db = aliasToSignalDb(
    { ...VOCAL_SAT_KERNEL_DEFAULTS, lowDriveMult: 0.1 }, 235, 0.4,
  )
  assert.ok(db < -120, `expected near-nothing, measured ${db.toFixed(1)} dB`)
})

test('block size does not change the result', () => {
  const n = 6000
  const sig = tone(n, 180)
  const oneShot = processVocalSatBuffer([sig], SR, VOCAL_SAT_KERNEL_DEFAULTS).channelData[0]

  const kernel = new VocalSatKernel(SR)
  kernel.setParams(VOCAL_SAT_KERNEL_DEFAULTS)
  const chunked = new Float32Array(n)
  let off = 0
  while (off < n) {
    const len = Math.min(off % 2 === 0 ? 37 : 211, n - off)
    kernel.process(
      [sig.subarray(off, off + len)],
      [chunked.subarray(off, off + len)],
      len,
    )
    off += len
  }
  let maxErr = 0
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(oneShot[i] - chunked[i]))
  assert.ok(maxErr < 1e-6, `block-size dependence: max error ${maxErr}`)
})

test('channels are processed independently', () => {
  const n = 4096
  const sig = tone(n, 180)
  const silence = new Float32Array(n)
  const { channelData } = processVocalSatBuffer([sig, silence], SR, VOCAL_SAT_KERNEL_DEFAULTS)
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(channelData[1][i]) < 1e-9, `silent channel leaked at ${i}`)
  }
})

test('output stays inside [-1, 1]', () => {
  const n = 8192
  const sig = tone(n, 120, 0.99)
  const { channelData } = processVocalSatBuffer([sig], SR, {
    ...VOCAL_SAT_KERNEL_DEFAULTS, drive: 5, wetDry: 1,
  })
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(channelData[0][i]) <= 1, `clipped past unity at ${i}`)
  }
})

test('survives silence without producing NaN', () => {
  // The two RMS divisions are the risk: an unguarded follower reaching zero
  // would turn the whole buffer into NaN.
  const n = 4096
  const { channelData } = processVocalSatBuffer(
    [new Float32Array(n)], SR, VOCAL_SAT_KERNEL_DEFAULTS,
  )
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(channelData[0][i]), `non-finite output at ${i}`)
  }
})
