/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VocalSatKernel,
  VOCAL_SAT_KERNEL_DEFAULTS,
  VOCAL_SAT_LATENCY_SAMPLES,
  HARDNESS_MIN,
  HARDNESS_MAX,
  MODE_SERIES,
  MODE_PARALLEL,
  processVocalSatBuffer,
} from '../../src/audio/vocalSatProcessor.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'
import { highpass, BiquadCascade } from '../../src/audio/dsp/biquad.js'

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
    drive: 0, asymmetry: 0, wetDry: 0.5,
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

test('asymmetry produces even harmonics', () => {
  // A symmetric transfer generates odd harmonics only; running the curve off
  // centre is the ONLY source of even ones. Was `bias`, and the number is the
  // same offset scaled by 100 — see ASYM_REFERENCE.
  const n = 32768
  const f0 = 220
  const sig = tone(n, f0, 0.4)

  const measureSecond = asymmetry => {
    const { channelData } = processVocalSatBuffer([sig], SR, {
      ...VOCAL_SAT_KERNEL_DEFAULTS, drive: 3, wetDry: 0.8, asymmetry,
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
    measureSecond(50) > measureSecond(0) * 5,
    'asymmetry should raise the second harmonic substantially',
  )
  // Additive, not a rebalancing — tapeCharacter's claim, re-pinned here because
  // it is what makes this a character control rather than a second drive knob.
  assert.ok(measureSecond(100) > measureSecond(50), 'more asymmetry, more H2')
})

test('asymmetry at 0 is absent, not merely a zero offset', () => {
  // The DC blocker must not run for a user who never touches the control, and
  // `asymActive` is what buys that. Bit-identical, not close.
  const n = 16384
  const sig = tone(n, 220)
  const a = processVocalSatBuffer([sig], SR, {}).channelData[0]
  const b = processVocalSatBuffer([sig], SR, { asymmetry: 0 }).channelData[0]
  const c = processVocalSatBuffer([sig], SR, { asymmetry: 0.001 }).channelData[0]
  let differs = false
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) differs = true
  assert.ok(differs, 'the default is not asymmetry 0, so these should differ')
  // Below ASYM_EPSILON the offset is exactly 0 and the branch is not taken.
  for (let i = 0; i < n; i++) {
    assert.equal(b[i], c[i], `asymmetry below the epsilon should be absent (i=${i})`)
  }
})

test('the asymmetry offset opposes the material lean', () => {
  // tapeCharacter measured up to 7.9 dB of OTHER distortion riding on this
  // choice. The sign is the whole reason the skew tracker is wired in: a fixed
  // positive offset is right on two of three real narrators and costs the third
  // 4.9 dB for nothing. Probed with a deliberately skewed wave, gated as voice.
  const n = SR * 6 // past SKEW_EVIDENCE_S, which is 3 s
  const skewed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * 220 * i) / SR
    // Asymmetric by construction: tall narrow positive lobe, long shallow
    // negative one. Third moment is strongly positive.
    skewed[i] = 0.4 * (Math.sin(t) + 0.5 * Math.sin(2 * t))
  }
  const flipped = Float32Array.from(skewed, v => -v)

  const distortion = sig => {
    const { channelData } = processVocalSatBuffer([sig], SR, {
      ...VOCAL_SAT_KERNEL_DEFAULTS, drive: 3, wetDry: 1, asymmetry: 60,
    })
    let s = 0
    const tail = channelData[0].subarray(n - SR)
    for (let i = 0; i < tail.length; i++) s += tail[i] * tail[i]
    return Math.sqrt(s / tail.length)
  }

  // A polarity flip flips the measured skew and therefore the chosen offset, so
  // the two must come out at the same level. That symmetry is the property the
  // tracker exists to give, and it fails outright for a fixed-sign offset.
  const a = distortion(skewed)
  const b = distortion(flipped)
  const diffDb = Math.abs(20 * Math.log10(a / b))
  assert.ok(diffDb < 0.5, `polarity flip changed the result by ${diffDb.toFixed(2)} dB`)
})

test('hardness tilts the harmonic series, and only below saturation', () => {
  // THE CLAIM THAT MAKES THIS A CHARACTER CONTROL, and the limit on it.
  //
  // Measured as TILT — the top of the series against the bottom — because an
  // absolute harmonic level moves with the AMOUNT of distortion as well as its
  // kind, and hardness changes both (THD 20.0% at n=2 to 23.1% at n=8 at a
  // fixed drive). A ratio between two harmonics cancels the amount and leaves
  // the decay rate, which is the thing the knob is actually for.
  //
  // ⚠ IT ONLY WORKS BELOW SATURATION, AND THE SHIPPED PATCH IS ABOVE IT. Every
  // member of this family tends to sign(x) for large |x|, so once the drive has
  // squared the wave off there is no knee left to shape and the knob converges
  // to inert. Measured tilt swing from n=2 to n=8:
  //
  //   drive 1 (effective 5)    12.8 dB    <- the knob works
  //   drive 3 (effective 15)    1.4 dB    <- near-inert
  //
  // The `softness` control this replaced was inert for the SAME reason, at
  // every setting, which is the likely explanation for why nobody ever reported
  // that it did nothing. Lowering the default drive would put the knob inside
  // its own window; that is a change to the shipped sound and has not been made
  // here.
  const n = 32768
  const f0 = 220
  const sig = tone(n, f0, 0.4)
  const tilt = hardness => {
    const { channelData } = processVocalSatBuffer([sig], SR, {
      ...VOCAL_SAT_KERNEL_DEFAULTS, drive: 1, wetDry: 1, asymmetry: 0, hardness,
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
    return 20 * Math.log10(at(f0 * 11) / at(f0 * 5))
  }
  const swing = tilt(HARDNESS_MAX) - tilt(HARDNESS_MIN)
  assert.ok(
    swing > 8,
    `hardness should tilt the series; swung ${swing.toFixed(1)} dB (expected ~12.8)`,
  )
})

/**
 * Bursts with instant onsets and a decaying body — the material the
 * transient-behaviour claims are about. A steady tone cannot probe any of this.
 */
function bursts(hits = 8) {
  const n = SR * 4
  const sig = new Float32Array(n)
  for (let k = 0; k < hits; k++) {
    const h = Math.round(SR * (0.25 + 0.45 * k))
    for (let i = 0; i < SR * 0.35 && h + i < n; i++) {
      const t = i / SR
      const env = Math.exp(-t / 0.045)
      const body = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t)
      const click = Math.exp(-t / 0.004)
        * (Math.sin(2 * Math.PI * 3200 * t) + Math.sin(2 * Math.PI * 6100 * t))
      sig[h + i] += 0.30 * env * (body * 0.55 + click * 0.5)
    }
  }
  return sig
}

function crestDb(buf, latency = 0) {
  let peak = 0
  let sum = 0
  let count = 0
  for (let i = 0; i < buf.length - latency; i++) {
    const v = buf[i + latency]
    peak = Math.max(peak, Math.abs(v))
    sum += v * v
    count++
  }
  return 20 * Math.log10(peak) - 20 * Math.log10(Math.sqrt(sum / count))
}

// asymmetry 0 deliberately: it has its own strong effect on crest (see the
// interaction test below), and the topology claims must not ride on it.
const HOT = {
  drive: 2.0, wetDry: 1, asymmetry: 0, hardness: 2.5,
  lowCrossover: 500, midCrossover: 3500,
  lowDriveMult: 8, midDriveMult: 8, highDriveMult: 8, hfLoss: 0,
}

test('the default patch is bit-identical to the build before the switch', () => {
  // ⚠ THE WHOLE LICENCE FOR ADDING A TOPOLOGY SWITCH TO A SHIPPED STAGE. Series
  // is a different-sounding stage, not a better one, and every saved patch
  // assumes the old wiring — so the default must be exactly what it was, and
  // "exactly" has to mean sample equality rather than "sounds the same".
  const sig = bursts(2)
  const a = processVocalSatBuffer([sig], SR, {}).channelData[0]
  const b = processVocalSatBuffer([sig], SR, {
    mode: MODE_PARALLEL, emphasis: 0,
  }).channelData[0]
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `default is not parallel/emphasis-0 (i=${i})`)
  }
})

test('emphasis at 0 is absent, not merely a flat shelf', () => {
  // Same rule HF Loss and asymmetry follow: below the epsilon the pair is
  // skipped outright, so a user who never touches it runs no extra biquads and
  // pays nothing for the feature existing.
  const sig = bursts(2)
  const a = processVocalSatBuffer([sig], SR, { emphasis: 0 }).channelData[0]
  const b = processVocalSatBuffer([sig], SR, { emphasis: 0.00001 }).channelData[0]
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `emphasis below the epsilon should be absent (i=${i})`)
  }
})

test('parallel cannot absorb a transient at ANY Wet/Dry, and series can', () => {
  // THE MEASUREMENT THE SWITCH EXISTS FOR. Parallel is an add, so the dry
  // transient is at unity however the knob is set: crest is flat across the
  // whole range, including past what the panel offers.
  const sig = bursts()
  const dry = crestDb(sig)
  for (const wetDry of [0, 0.3, 0.5, 1, 2, 4]) {
    const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, {
      ...HOT, mode: MODE_PARALLEL, wetDry,
    })
    const delta = crestDb(channelData[0], latencySamples) - dry
    assert.ok(
      Math.abs(delta) < 1,
      `parallel at wetDry ${wetDry} changed crest by ${delta.toFixed(2)} dB — `
      + 'if this now absorbs, the blend stopped being an add',
    )
  }
  // Series with a single broadband band is where the curve's peak absorption
  // actually reaches the output. Crossovers pushed past the band so the low
  // band carries everything — see the band-split note below for why that
  // matters so much.
  const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, {
    ...HOT, mode: MODE_SERIES, lowCrossover: 20000, midCrossover: 20500,
  })
  const delta = crestDb(channelData[0], latencySamples) - dry
  assert.ok(delta < -2, `series should absorb; crest moved ${delta.toFixed(2)} dB`)
})

test('TWO OTHER MECHANISMS ALSO RESIST PEAK ABSORPTION, and this records them', () => {
  // Series alone does NOT buy the curve's full 11.7 dB of crest reduction, and
  // the gap is not a defect in the switch. Two other parts of the design give
  // it back, both measured:
  //
  //  1. THE THREE-BAND SPLIT. A transient is broadband, so each band sees only
  //     part of it, saturates mildly, and the SUM reconstructs the peak.
  //     Clipping three bands separately is not clipping their sum.
  //       3-band, as shipped   +0.25 dB
  //       one band             -3.55 dB
  //
  //  2. THE DOUBLE RMS MATCH. Two 300 ms envelope followers renormalise the wet
  //     to the dry's MOVING level, which by construction restores dynamics the
  //     curve removed. Measured on the curve alone, which takes 11.7 dB off:
  //       constant whole-file scalar   -11.69 dB   (crest is scale-invariant)
  //       the shipped 300 ms followers  -4.92 dB   (6.8 dB handed back)
  //
  // Neither is touched here. The band split is the plugin's identity and the
  // RMS match is Python parity with a level-neutrality test on it; changing
  // either is a separate decision. This test exists so that if someone does,
  // the numbers move and say so.
  const sig = bursts()
  const dry = crestDb(sig)
  const at = params => {
    const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, params)
    return crestDb(channelData[0], latencySamples) - dry
  }
  const split = at({ ...HOT, mode: MODE_SERIES })
  const single = at({ ...HOT, mode: MODE_SERIES, lowCrossover: 20000, midCrossover: 20500 })
  assert.ok(
    single < split - 2,
    `the band split should resist absorption: split ${split.toFixed(2)} vs `
    + `single ${single.toFixed(2)} dB`,
  )
})

test('asymmetry works AGAINST peak absorption, and by how much', () => {
  // ⚠ AN INTERACTION NOBODY WOULD PREDICT FROM THE TWO CONTROLS' NAMES, and the
  // reason the topology tests above pin asymmetry at 0.
  //
  // An off-centre curve clips one polarity earlier than the other, so the
  // output is lopsided: the peak is set by the side that clipped LATE while the
  // RMS falls with the side that clipped early. Crest therefore RISES. Series,
  // one band, drive 16:
  //
  //   asymmetry     0      25      50     100
  //   d crest    -3.55   -2.51   +0.76   +5.47  dB
  //
  // So the warmth control and the transient-absorption character pull in
  // opposite directions, and a patch that wants the soft, absorbing sound wants
  // asymmetry LOW. That is worth knowing before reaching for both at once.
  const sig = bursts()
  const dry = crestDb(sig)
  const at = asymmetry => {
    const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, {
      ...HOT, mode: MODE_SERIES, lowCrossover: 20000, midCrossover: 20500, asymmetry,
    })
    return crestDb(channelData[0], latencySamples) - dry
  }
  assert.ok(at(100) > at(0) + 4, `asymmetry should raise crest: ${at(0).toFixed(2)} -> ${at(100).toFixed(2)}`)
})

test('the emphasis pair absorbs the onset edge while the body keeps its harmonics', () => {
  // THE OTHER HALF OF THE ANSWER. A bare curve adds harmonics loudest where the
  // signal is loudest, so it drops new HF onto the onset — squashed but
  // brighter, which reads as edge. Emphasis makes the curve bite HF hardest, so
  // the onset's top end comes DOWN while the body stays thick.
  const sig = bursts()
  const hp = buf => {
    const c = new BiquadCascade(2, 1)
    c.setSections([highpass(SR, 4000), highpass(SR, 4000)])
    const out = new Float64Array(buf.length)
    c.process(buf, out, buf.length, 0)
    return out
  }
  const energy = (buf, fromS, toS) => {
    let sum = 0
    let count = 0
    for (let k = 0; k < 8; k++) {
      const h = Math.round(SR * (0.25 + 0.45 * k))
      for (let i = h + Math.round(SR * fromS); i < h + Math.round(SR * toS); i++) {
        sum += buf[i] * buf[i]
        count++
      }
    }
    return Math.sqrt(sum / count)
  }
  const wholeRms = buf => {
    let s = 0
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
    return Math.sqrt(s / buf.length)
  }
  const dryHf = hp(sig)
  const measure = emphasis => {
    const { channelData, latencySamples } = processVocalSatBuffer([sig], SR, {
      ...HOT, mode: MODE_SERIES, emphasis,
    })
    const aligned = new Float64Array(sig.length)
    for (let i = 0; i < sig.length - latencySamples; i++) {
      aligned[i] = channelData[0][i + latencySamples]
    }
    // Level-match to the dry, or this measures the output trim, not the tone.
    const g = wholeRms(sig) / wholeRms(aligned)
    for (let i = 0; i < aligned.length; i++) aligned[i] *= g
    const hf = hp(aligned)
    return {
      onset: 20 * Math.log10(energy(hf, 0, 0.005) / energy(dryHf, 0, 0.005)),
      body: 20 * Math.log10(energy(hf, 0.05, 0.20) / energy(dryHf, 0.05, 0.20)),
    }
  }
  const off = measure(0)
  const on = measure(100)
  assert.ok(
    on.onset < off.onset - 5,
    `emphasis should absorb the onset's top end: ${off.onset.toFixed(2)} -> ${on.onset.toFixed(2)} dB`,
  )
  assert.ok(
    on.body > 8,
    `the body should keep its added harmonics; measured ${on.body.toFixed(2)} dB`,
  )
})

test('hardness is clamped to the measured range', () => {
  // HARDNESS_MIN is an aliasing measurement, not a preference. A param message
  // from a stale panel must not reach the curve with n below it.
  const k = new VocalSatKernel(SR)
  k.setParams({ hardness: 0.5 })
  assert.equal(k.hardness, HARDNESS_MIN)
  k.setParams({ hardness: 99 })
  assert.equal(k.hardness, HARDNESS_MAX)
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
  // the point where the transfer curves bite and the number should fall away.
  //
  // ⚠ ASYMMETRY MUST BE 0 FOR THIS PROBE TO MEAN WHAT IT SAYS, and that is a
  // statement about the effect rather than about the test. An odd curve has no
  // second-order term AT THE ORIGIN, so a small signal centred there is very
  // nearly linear however curved the transfer is further out. Run the same
  // curve OFF CENTRE and that cancellation is gone: the small signal now rides
  // on a part of the curve that bends, and "drop the drive and the
  // nonlinearity falls away" stops being true at any drive. The offset is not
  // a bias on the measurement — it is a second nonlinearity the drive knob
  // does not reach. See the companion test below for what it costs.
  const db = aliasToSignalDb(
    { ...VOCAL_SAT_KERNEL_DEFAULTS, lowDriveMult: 0.1, asymmetry: 0 }, 235, 0.4,
  )
  assert.ok(db < -120, `expected near-nothing, measured ${db.toFixed(1)} dB`)
})

test('running the curve off centre costs alias margin, and this is how much', () => {
  // THE PRICE OF THE CURVE CHANGE, pinned rather than described. Same probe as
  // above with the offset engaged. The tanh build this replaced measured
  // -139.4 dB here; this curve measures about -109, because a slower-decaying
  // harmonic series is exactly what folds. That is the trade the curve was
  // changed to make, and 109 dB down is 39 dB below this file's own -70 dB
  // audibility bar — but it is a real 30 dB and it should go red if it moves.
  const off = { ...VOCAL_SAT_KERNEL_DEFAULTS, lowDriveMult: 0.1, asymmetry: 50 }
  const db = aliasToSignalDb(off, 235, 0.4)
  assert.ok(db < -100, `off-centre aliasing regressed: ${db.toFixed(1)} dB`)
  assert.ok(
    db > -130,
    `off-centre aliasing improved to ${db.toFixed(1)} dB — if this is real, the `
    + 'comment above and HARDNESS_MIN both need re-measuring',
  )
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
