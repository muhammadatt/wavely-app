/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VocalSatKernel,
  VOCAL_SAT_KERNEL_DEFAULTS,
  VOCAL_SAT_LATENCY_SAMPLES,
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
  // "Transparent" now means the dry signal delayed by the reported latency: the
  // saturation runs oversampled, and the dry side is held back to meet it.
  // Nothing filters the dry path, so this is still an exact delay.
  const n = 8192
  const sig = tone(n, 220)
  const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, {
    drive: 0, bias: 0, wetDry: 0.5,
  })
  assert.equal(latencySamples, VOCAL_SAT_LATENCY_SAMPLES)
  let maxErr = 0
  for (let i = 1000; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i - VOCAL_SAT_LATENCY_SAMPLES]))
  }
  assert.ok(maxErr < 1e-5, `not transparent: max error ${maxErr}`)
})

test('is transparent at zero wet/dry', () => {
  const n = 8192
  const sig = tone(n, 220)
  const { channelData } = processVocalSatBuffer([sig], SR, { wetDry: 0 })
  let maxErr = 0
  for (let i = 1000; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i - VOCAL_SAT_LATENCY_SAMPLES]))
  }
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

/** FFT length used by the aliasing measurements. */
const FFT_N = 32768

/** The bin index whose tone completes a whole number of periods in FFT_N. */
function cyclesFor(freqHz) {
  return Math.round((freqHz * FFT_N) / SR)
}

/**
 * Settled spectrum of a bin-centred tone put through the effect.
 *
 * The tone must complete exactly `cycles` periods in the FFT length. That
 * gives zero spectral leakage, so every bin that is not a multiple of `cycles`
 * is genuinely alias energy rather than a smeared harmonic. Measuring with a
 * non-bin-centred tone reads ~80 dB worse purely from leakage.
 *
 * Analysis runs on a settled window, past the filter and follower warmup.
 */
function spectrumOf(params, cycles, amp = 0.4) {
  const f0 = (cycles * SR) / FFT_N
  const total = FFT_N * 3
  const sig = new Float32Array(total)
  for (let i = 0; i < total; i++) sig[i] = amp * Math.sin((2 * Math.PI * f0 * i) / SR)

  const { channelData } = processVocalSatBuffer([sig], SR, params)
  const settled = channelData[0].subarray(total - FFT_N)

  const fft = getFFT(FFT_N)
  const bins = rfftBinCount(FFT_N)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(settled, re, im)
  return { re, im, bins }
}

/** Total alias energy relative to the tone and its harmonics, in dB. */
function aliasToSignalDb(params, cycles, amp = 0.4) {
  const { re, im, bins } = spectrumOf(params, cycles, amp)
  let harmonic = 0
  let alias = 0
  for (let k = 1; k < bins; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    if (k % cycles === 0) harmonic += p
    else alias += p
  }
  return 10 * Math.log10(alias / harmonic)
}

test('aliasing stays inaudible', () => {
  // The three transfer curves run at 2x. These are the numbers that decision is
  // worth — if a future change removes the oversampling, they are what fails.
  //
  // NOTE ON COVERAGE: this test once stopped at 2 kHz, which is why the effect
  // shipped without oversampling for as long as it did. The low band carries
  // the hard drive and its harmonics have room below Nyquist, so low tones look
  // clean whether or not anything is oversampled. High tones are where folding
  // shows, and cymbals and air are exactly the material a music user brings.
  const D = VOCAL_SAT_KERNEL_DEFAULTS
  const cases = [
    ['defaults', D, 235, 0.4],
    ['low tone', D, 91, 0.4],
    ['hot input', D, 235, 0.8],
    ['drive 5', { ...D, drive: 5 }, 235, 0.4],
    ['fully wet', { ...D, wetDry: 1 }, 235, 0.4],
    ['mid-band tone', D, 1486, 0.4],
    // High tones: a 12 kHz partial's second harmonic is above Nyquist and its
    // third lands back at 8 kHz, in the middle of everything.
    ['6 kHz tone', D, cyclesFor(6000), 0.4],
    ['9 kHz tone', D, cyclesFor(9000), 0.4],
    ['12 kHz tone', D, cyclesFor(12000), 0.4],
    ['12 kHz, drive 5', { ...D, drive: 5 }, cyclesFor(12000), 0.4],
    ['12 kHz, drive 5, fully wet', { ...D, drive: 5, wetDry: 1 }, cyclesFor(12000), 0.4],
  ]
  for (const [label, params, cycles, amp] of cases) {
    const db = aliasToSignalDb(params, cycles, amp)
    assert.ok(
      db < -70,
      `${label}: alias/signal ${db.toFixed(1)} dB — oversampling may have regressed`,
    )
  }
})

test('the worst folded product on a high tone stays far down', () => {
  // aliasToSignalDb aggregates every non-harmonic bin, which mixes a large
  // inaudible product at 20 kHz with a small audible one at 8 kHz. This pins
  // the individual worst offender instead, and reports where it landed, so a
  // regression says something useful rather than just going red.
  const D = VOCAL_SAT_KERNEL_DEFAULTS
  const cycles = cyclesFor(12000)
  const { re, im, bins } = spectrumOf({ ...D, drive: 5, wetDry: 1 }, cycles, 0.4)
  const power = b => re[b] * re[b] + im[b] * im[b]

  let worst = 0
  let worstBin = -1
  for (let b = 8; b < bins; b++) {
    if (b % cycles === 0) continue
    if (power(b) > worst) {
      worst = power(b)
      worstBin = b
    }
  }
  const dbc = 10 * Math.log10(worst / power(cycles))
  assert.ok(
    dbc < -80,
    `worst folded product ${dbc.toFixed(1)} dBc at ${((worstBin * SR) / FFT_N).toFixed(0)} Hz`,
  )
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

// ── HF Loss (moved here from the soft clipper's Drive knob) ─────────────────

test('HF Loss is absent at zero, not merely flat', () => {
  // THE RULE THAT BUYS THE RIGHT TO PUT A COLOUR INSIDE AN EXISTING PLUGIN.
  // People already rely on this plugin's defaults, so the patch that shipped
  // before this control existed has to be bit-identical rather than close: the
  // filter is skipped outright at 0, not run at unity gain.
  const n = 16384
  const sig = tone(n, 300, 0.5)
  const a = processVocalSatBuffer([sig], SR, {}).channelData[0]
  const b = processVocalSatBuffer([sig], SR, { hfLoss: 0 }).channelData[0]
  for (let i = 0; i < n; i++) {
    assert.equal(a[i], b[i], `hfLoss 0 altered sample ${i}`)
  }
})

test('HF Loss is a shelf that cuts, never boosts, and deepens with the knob', () => {
  // The structure is `g*x + (1-g)*lowpass(x)`, which is provably incapable of
  // boosting: |g + (1-g)*LP| <= g + (1-g)*|LP| <= 1 for any 0 <= g <= 1. The
  // measurement is here so the proof cannot quietly stop describing the code.
  //
  // Drive 0 / bias 0 makes the saturation silent, so the shelf is the only
  // thing running and the numbers are the filter rather than the plugin.
  const base = { drive: 0, bias: 0, wetDry: 0 }
  const at = (f, knob) => {
    const sig = tone(32768, f, 0.5)
    const off = processVocalSatBuffer([sig], SR, { ...base, hfLoss: 0 }).channelData[0]
    const on = processVocalSatBuffer([sig], SR, { ...base, hfLoss: knob }).channelData[0]
    return 20 * Math.log10(rms(on, 8000) / rms(off, 8000))
  }
  // Measured at full knob: -0.22 / -0.79 / -2.34 / -4.75 / -6.51 dB at
  // 1k / 2k / 4k / 8k / 16k. Stated loosely enough to be about the shape
  // rather than the fourth decimal, and tightly enough to fail on a corner or
  // depth change.
  const full = [1000, 2000, 4000, 8000, 16000].map(f => at(f, 100))
  for (const v of full) assert.ok(v <= 0.01, `the shelf boosted: ${full.map(x => x.toFixed(2))}`)
  for (let i = 1; i < full.length; i++) {
    assert.ok(full[i] < full[i - 1], `not monotonic in frequency: ${full.map(x => x.toFixed(2))}`)
  }
  assert.ok(Math.abs(full[0]) < 0.5, `too much at 1 kHz: ${full[0].toFixed(2)} dB`)
  assert.ok(full[3] < -3 && full[3] > -7, `8 kHz depth moved: ${full[3].toFixed(2)} dB`)
  // Deeper at a higher setting, at the frequency the control is about.
  assert.ok(at(8000, 100) < at(8000, 50) - 1, 'the knob is not monotonic in depth')
})

test('HF Loss acts on the output, so Wet/Dry does not bypass it', () => {
  // ⚠ THE ONE PLACE THIS PLUGIN'S PARALLEL-BLEND CONTRACT IS DELIBERATELY
  // BROKEN, and it is the whole claim about what is being modelled: this is the
  // MEDIUM's bandwidth, not the saturation's, and a medium the dry path
  // bypasses is not a medium. Measured on real narration, a wet-path version
  // manages 0.79 dB above 4 kHz at the default blend where this manages 3.77.
  //
  // The mutation this catches is moving the filter onto the wet path, where at
  // wetDry 0 it would do nothing at all.
  const sig = tone(16384, 8000, 0.5)
  const base = { drive: 2, bias: 0.5, wetDry: 0 }
  const off = processVocalSatBuffer([sig], SR, { ...base, hfLoss: 0 }).channelData[0]
  const on = processVocalSatBuffer([sig], SR, { ...base, hfLoss: 100 }).channelData[0]
  const cut = 20 * Math.log10(rms(on, 8000) / rms(off, 8000))
  assert.ok(cut < -3, `HF Loss did nothing at Wet/Dry 0 — it is on the wet path: ${cut.toFixed(2)} dB`)
})

test('HF Loss is not undone by the output level match', () => {
  // ⚠ PLACED AFTER `out *= dryRms/outRms`, deliberately. Before it, the level
  // match reads the energy the filter just removed as a level drop and pushes
  // the whole signal back up to compensate — the match silently undoing the
  // tone control. The tell is broadband level: with the filter after the match,
  // removing treble must make the output QUIETER, not the same.
  const sig = tone(65536, 8000, 0.5)
  const base = { drive: 2, bias: 0.5, wetDry: 0.3 }
  const off = processVocalSatBuffer([sig], SR, { ...base, hfLoss: 0 }).channelData[0]
  const on = processVocalSatBuffer([sig], SR, { ...base, hfLoss: 100 }).channelData[0]
  const level = 20 * Math.log10(rms(on, 20000) / rms(off, 20000))
  assert.ok(level < -2,
    `removing treble did not lower the output — the level match is undoing it: ${level.toFixed(2)} dB`)
})
