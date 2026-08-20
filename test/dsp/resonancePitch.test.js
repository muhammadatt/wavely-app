/**
 * Resonance Suppressor — pitch behaviour.
 *
 * Separate from resonance.test.js because this file is about the two things
 * harmonic protection was built for, and about what it costs. Both were design
 * arguments carried for a long time without a number attached:
 *
 *   REASON 1 — processing a passage whose pitch moves produced audible pitch
 *   artefacts. A harmonic sliding across bins makes each bin rise and fall, the
 *   detector reads that as a resonance appearing and leaving, and the per-bin
 *   gain chases it. The result is amplitude modulation locked to the pitch
 *   contour.
 *
 *   REASON 2 — the cepstral reference sits at the INTER-HARMONIC FLOOR, so
 *   every harmonic of a pitched source protrudes above it and reads as a
 *   resonance.
 *
 * The probes below measure reason 1 directly, and measure what the mask that
 * answers both of them costs. THE COST TEST IS NOT AN APPROVAL. It records a
 * measured fact — that on pitched material the shipping configuration removes
 * nothing at all — so that a change to the reference has something to move.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResonanceKernel,
  processResonanceBuffer,
  RESONANCE_KERNEL_DEFAULTS,
} from '../../src/audio/resonanceProcessor.js'
import {
  DEFAULT_REF_MODE,
  RESONANCE_REF_MODE_DEFAULTS,
  resolveRefMode,
  withRefModeDefaults,
} from '../../src/audio/resonanceParams.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const LATENCY = 2048

/**
 * Harmonic stack on a pitch contour, with amplitudes taken from a fixed
 * SPECTRAL ENVELOPE and no cap on harmonic count.
 *
 * Both properties are load-bearing and the obvious generator has neither. A
 * source shaped by harmonic INDEX (1/k, capped at 30 or 40) modulates itself
 * when the pitch moves, because the top of the stack slides across the band —
 * the first version of the vibrato probe measured 25 dB of "artefact" in
 * 6–14 kHz that was entirely the generator. The same cap also silently
 * flattered the frequency sweep in `resonance.test.js`: at F0 150 a 30-harmonic
 * source carries nothing above 4.5 kHz, so a probe up there measures the noise
 * floor rather than the suppressor.
 *
 * Amplitude is otherwise constant, so anything that modulates in the output is
 * the effect's doing.
 */
function pitched(contour, { seconds = 4, amp = 0.2, noiseDb = -70, tilt = 1.5 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const noiseAmp = Math.pow(10, noiseDb / 20)
  // `tilt` is the exponent of the spectral roll-off above 300 Hz. It matters to
  // any test that probes the top of the spectrum: a steeper source has less up
  // there for a defect to sit on, so detection falls for a reason that is the
  // material rather than the detector. Stated per test rather than fixed.
  const envelope = f => (f <= 300 ? 1 : Math.pow(300 / f, tilt))
  let phase = 0
  let s = 991
  for (let i = 0; i < n; i++) {
    const f0 = contour(i / SR)
    phase += (2 * Math.PI * f0) / SR
    let v = 0
    for (let k = 1; k * f0 < SR / 2; k++) v += envelope(k * f0) * Math.sin(k * phase + k * 0.9)
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = amp * v * 0.25 + noiseAmp * (s / 0x3fffffff - 1)
  }
  return out
}

function resonate(sig, freqHz, q, gainDb) {
  const cascade = new BiquadCascade(1, 1)
  cascade.setSections([peaking(SR, freqHz, q, gainDb)])
  const out = new Float32Array(sig.length)
  cascade.process(sig, out, sig.length, 0)
  return out
}

/** Isolate a band by zeroing everything else in one big transform. */
function bandpass(sig, lo, hi) {
  const n = 1 << Math.ceil(Math.log2(sig.length))
  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const x = new Float64Array(n)
  x.set(sig)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(x, re, im)
  const binHz = SR / n
  for (let k = 0; k < bins; k++) {
    const f = k * binHz
    if (f < lo || f > hi) { re[k] = 0; im[k] = 0 }
  }
  const y = new Float64Array(n)
  fft.irfft(re, im, y)
  return y.subarray(0, sig.length)
}

/** Level contour in dB, one point per STFT hop. */
function levelContour(sig, band) {
  const x = band ? bandpass(sig, band[0], band[1]) : sig
  const H = 512
  const m = Math.floor(sig.length / H)
  const out = new Float64Array(m)
  for (let j = 0; j < m; j++) {
    let sum = 0
    for (let i = 0; i < H; i++) { const v = x[j * H + i]; sum += v * v }
    out[j] = 10 * Math.log10(sum / H + 1e-20)
  }
  return out
}

/** Peak-to-peak dB of the level contour's component at `rateHz`. */
function wobbleAt(contour, rateHz) {
  const m = contour.length
  let mean = 0
  for (const v of contour) mean += v
  mean /= m
  const fs = SR / 512
  let cr = 0
  let ci = 0
  for (let j = 0; j < m; j++) {
    const a = (2 * Math.PI * rateHz * j) / fs
    cr += (contour[j] - mean) * Math.cos(a)
    ci += (contour[j] - mean) * Math.sin(a)
  }
  return (4 * Math.hypot(cr, ci)) / m
}

/** Worst level departure in the 200 ms after `atSec`, against the level before. */
function stepExcursion(sig, band, atSec = 2) {
  const e = levelContour(sig, band)
  const at = t => Math.round((t * SR) / 512)
  let pre = 0
  let n = 0
  for (let j = at(atSec - 0.8); j < at(atSec - 0.1); j++) { pre += e[j]; n++ }
  pre /= n
  let worst = 0
  for (let j = at(atSec + 0.05); j < at(atSec + 0.25); j++) {
    const d = Math.abs(e[j] - pre)
    if (d > worst) worst = d
  }
  return worst
}

const FFT_N = 16384
const bandFft = getFFT(FFT_N)
const BAND_BINS = rfftBinCount(FFT_N)
function bandDb(buf, freqHz, from, halfHz) {
  const w = new Float64Array(FFT_N)
  for (let i = 0; i < FFT_N; i++) {
    w[i] = buf[from + i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_N))
  }
  const re = new Float64Array(BAND_BINS)
  const im = new Float64Array(BAND_BINS)
  bandFft.rfft(w, re, im)
  const binHz = SR / FFT_N
  const lo = Math.max(0, Math.round((freqHz - halfHz) / binHz))
  const hi = Math.min(BAND_BINS - 1, Math.round((freqHz + halfHz) / binHz))
  let p = 0
  for (let k = lo; k <= hi; k++) p += re[k] * re[k] + im[k] * im[k]
  return 10 * Math.log10(p / (hi - lo + 1) / (FFT_N * FFT_N) + 1e-20)
}

function removedFrom(sig, freqHz, q, gainDb, params) {
  const wet = resonate(sig, freqHz, q, gainDb)
  const out = processResonanceBuffer([wet], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...params })
    .channelData[0]
  const halfHz = Math.max(60, freqHz * 0.05)
  return bandDb(wet, freqHz, SR, halfHz) - bandDb(out, freqHz, SR + LATENCY, halfHz)
}

const VIBRATO_HZ = 5
const VIBRATO = t => 150 * (1 + 0.06 * Math.sin(2 * Math.PI * VIBRATO_HZ * t))
const STEP = t => (t < 2 ? 150 : 195)
const UNPROTECTED = { preserveHarmonics: false }

// ── Reason 1: what pitch movement does to a per-bin dynamic suppressor ───────

test('reason 1 exists: vibrato drives amplitude modulation when unprotected', () => {
  const sig = pitched(VIBRATO)
  const wet = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...UNPROTECTED })
    .channelData[0].subarray(LATENCY)

  const before = wobbleAt(levelContour(sig, [2000, 6000]), VIBRATO_HZ)
  const after = wobbleAt(levelContour(wet, [2000, 6000]), VIBRATO_HZ)
  assert.ok(
    after > before * 4,
    `expected the suppressor to chase the moving harmonics; ${before.toFixed(2)} -> ${after.toFixed(2)} dB`,
  )
})

test('reason 1 is worse on a pitch step than on vibrato', () => {
  // A phoneme-boundary jump is the case the server answers with a UNION mask
  // across the pre- and post-transition pitches plus an 80% depth cut on the
  // straddle frames. This port carries neither — it dropped them because the
  // detector needs +-5 frames of lookahead — so the whole of its answer here is
  // the mask.
  const sig = pitched(STEP)
  const wet = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...UNPROTECTED })
    .channelData[0].subarray(LATENCY)

  const before = stepExcursion(sig, [2000, 6000])
  const after = stepExcursion(wet, [2000, 6000])
  assert.ok(before < 3, `the source itself steps by ${before.toFixed(2)} dB; probe is invalid`)
  assert.ok(
    after > 8,
    `expected a large excursion across the pitch step, got ${after.toFixed(2)} dB`,
  )
})

test('harmonic protection answers reason 1 completely, on both contours', () => {
  // Not "reduces" — the protected output tracks the source's own modulation to
  // within a hundredth of a dB. This is the benefit the mask is carried for,
  // and it is the reason turning protection off is not on its own an option.
  for (const [label, contour, measure] of [
    ['vibrato', VIBRATO, s => wobbleAt(levelContour(s, [2000, 6000]), VIBRATO_HZ)],
    ['pitch step', STEP, s => stepExcursion(s, [2000, 6000])],
  ]) {
    const sig = pitched(contour)
    const wet = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS)
      .channelData[0].subarray(LATENCY)
    const before = measure(sig)
    const after = measure(wet)
    assert.ok(
      Math.abs(after - before) < 0.1,
      `${label}: protection should be transparent, ${before.toFixed(3)} -> ${after.toFixed(3)} dB`,
    )
  }
})

// ── What that costs ─────────────────────────────────────────────────────────

test('THE COST: protection on, the suppressor removes nothing from pitched material', () => {
  // NOT AN APPROVAL. A record of measured behaviour, so that a change to the
  // reference has a number to move.
  //
  // On a voiced frame a resonance and the harmonics are THE SAME BINS: a
  // resonance is a filter applied to the harmonic series, so it shows up as the
  // harmonic peaks being taller, and there is no resonance energy between them
  // to cut instead. Protecting the harmonics absolutely is therefore equivalent
  // to declining to process pitched audio at all. Measured across three pitches
  // and six frequencies, and unchanged when the inter-harmonic floor is swept
  // from -45 to -15 dB.
  const sig = pitched(() => 150, { seconds: 3 })
  for (const f of [1200, 2500, 4000]) {
    const removed = removedFrom(sig, f, 25, 14, {})
    assert.ok(
      Math.abs(removed) < 0.2,
      `${f} Hz: expected the mask to block everything, ${removed.toFixed(2)} dB came out`,
    )
    const unmasked = removedFrom(sig, f, 25, 14, UNPROTECTED)
    assert.ok(
      unmasked > 1,
      `${f} Hz: the defect must be detectable at all for the cost to mean anything, got ${unmasked.toFixed(2)} dB`,
    )
  }
})

test('the one regime that works is unpitched material', () => {
  // No pitch, so no mask, whatever `preserveHarmonics` says. Fricatives, room
  // tone and sibilance are the whole of what the shipping configuration
  // currently treats.
  const n = Math.round(3 * SR)
  const noise = new Float32Array(n)
  const amp = Math.pow(10, -20 / 20)
  let s = 77
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    noise[i] = amp * (s / 0x3fffffff - 1)
  }
  const removed = removedFrom(noise, 2500, 25, 14, {})
  assert.ok(removed > 1, `unpitched removal collapsed to ${removed.toFixed(2)} dB`)
})

// ── The two couplings the log-frequency work only half fixed ────────────────

test('detection strength still depends on the speaker\'s pitch', () => {
  // Clamping the lifter cutoff removed the coupling THROUGH THE CUTOFF. A
  // second one survives it: F0 90 and F0 150 run an identical cutoff and still
  // differ by more than an order of magnitude, because how far a defect
  // protrudes above an inter-harmonic-floor reference depends on how dense the
  // comb under it is. No cutoff rule reaches that.
  const removed = [90, 150, 260].map(
    f0 => removedFrom(pitched(() => f0, { seconds: 3 }), 2500, 2, 10, UNPROTECTED),
  )
  for (let i = 1; i < removed.length; i++) {
    assert.ok(removed[i] > removed[i - 1], `not monotone in pitch: ${removed.join(', ')}`)
  }
  assert.ok(
    removed[2] > removed[0] * 10,
    `expected the pitch coupling to still be large, got ${removed.map(v => v.toFixed(2)).join(' / ')}`,
  )
})

test('detection still falls away above 4 kHz, and is flat below it', () => {
  // The spread kernel is a constant width in octaves now, which is what took
  // 500 Hz-4 kHz flat. The cepstral reference's OWN smoothing scale is still
  // uniform in Hz, and it tracks the noise floor upward where the harmonics are
  // weak, so the top of the spectrum still falls off. A spread kernel cannot
  // reach that half.
  // The carrier the numbers in resonanceProcessor.js's header were taken on:
  // tilt 1.2, and a 3 Hz pitch jitter. BOTH matter to the top of the sweep. A
  // steeper tilt confounds the detector's falloff with the source's own, and a
  // perfectly steady pitch is the bigger distortion of the two — the nth
  // harmonic jitters n times as far, so at 6.4 kHz an ordinary +-3 Hz wobble
  // smears a harmonic across six bins and flattens the peak the detector is
  // looking for. Measured on a rock-steady carrier the falloff above 4 kHz
  // nearly disappears (9.1 -> 7.7 dB), which would have been a finding about
  // synthetic material rather than about the effect.
  const jittered = t => 150 + 3 * Math.sin(2 * Math.PI * 2.7 * t)
  const sig = pitched(jittered, { seconds: 3, noiseDb: -45, tilt: 1.2 })
  const speech = [500, 1200, 2500, 4000].map(f => removedFrom(sig, f, 1.5, 10, UNPROTECTED))
  const top = removedFrom(sig, 6400, 1.5, 10, UNPROTECTED)

  const lo = Math.min(...speech)
  const hi = Math.max(...speech)
  assert.ok(
    hi - lo < 3.5,
    `500 Hz-4 kHz should be flat, spread was ${(hi - lo).toFixed(1)} dB: ${speech.map(v => v.toFixed(1)).join(', ')}`,
  )
  assert.ok(
    top < speech[3] * 0.6,
    `expected a falloff above 4 kHz; 4 kHz ${speech[3].toFixed(1)} dB, 6.4 kHz ${top.toFixed(1)} dB`,
  )
})

// ── The peak-envelope reference ─────────────────────────────────────────────

const PEAK = {
  refMode: 'peak',
  preserveHarmonics: false,
  selectivity: RESONANCE_REF_MODE_DEFAULTS.peak.selectivity,
  depth: RESONANCE_REF_MODE_DEFAULTS.peak.depth,
}

/**
 * Peak protrusion the kernel measures in a band — what `selectivity` is
 * thresholding. Read off the kernel's own arrays rather than inferred from the
 * output, because the question is what the DETECTOR sees.
 */
function protrusionDb(sig, params, freqHz, halfHz) {
  const kernel = new ResonanceKernel(SR)
  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, ...params })
  const scratch = new Float32Array(128)
  const lo = Math.round((freqHz - halfHz) / kernel.binWidth)
  const hi = Math.round((freqHz + halfHz) / kernel.binWidth)
  let acc = 0
  let n = 0
  for (let off = 0; off + 128 <= sig.length; off += 128) {
    kernel.process([sig.subarray(off, off + 128)], [scratch], 128)
    if (off < SR / 2) continue // let the pitch tracker and the STFT settle
    let m = -Infinity
    for (let b = lo; b <= hi; b++) {
      const v = kernel.magDb[b] - kernel.envDb[b]
      if (v > m) m = v
    }
    acc += m
    n++
  }
  return acc / n
}

test('the cepstral reference cannot see a defect at all; the peak one can', () => {
  // THE MEASUREMENT THIS WHOLE DIRECTION RESTS ON. Protrusion is the quantity
  // `selectivity` thresholds. From the inter-harmonic floor a clean voice
  // already protrudes by 21-24 dB — that is the comb, not a defect — and adding
  // a real +10 dB hump moves the reading by essentially nothing. An envelope
  // drawn through the harmonic peaks reads a clean voice at 2-4 dB and the same
  // defect at 7-11.
  const clean = pitched(() => 150, { seconds: 2 })
  const wet = resonate(clean, 1600, 2, 10)

  const cepClean = protrusionDb(clean, UNPROTECTED, 1600, 400)
  const cepWet = protrusionDb(wet, UNPROTECTED, 1600, 400)
  const peakClean = protrusionDb(clean, PEAK, 1600, 400)
  const peakWet = protrusionDb(wet, PEAK, 1600, 400)

  assert.ok(cepClean > 15, `cepstral floor should be dominated by the comb, got ${cepClean.toFixed(2)} dB`)
  assert.ok(
    Math.abs(cepWet - cepClean) < 3,
    `a +10 dB defect should be nearly invisible to the cepstral reference, moved ${(cepWet - cepClean).toFixed(2)} dB`,
  )
  assert.ok(peakClean < 6, `peak reference should read a clean voice as near zero, got ${peakClean.toFixed(2)} dB`)
  assert.ok(
    peakWet - peakClean > 4,
    `the defect should be visible to the peak reference, moved only ${(peakWet - peakClean).toFixed(2)} dB`,
  )
})

test('the peak reference is transparent to pitch movement with no mask at all', () => {
  // The mask's whole job, done by the reference instead. Same assertion as the
  // protection test above, run with protection OFF.
  for (const [label, contour, measure] of [
    ['vibrato', VIBRATO, s => wobbleAt(levelContour(s, [2000, 6000]), VIBRATO_HZ)],
    ['pitch step', STEP, s => stepExcursion(s, [2000, 6000])],
  ]) {
    const sig = pitched(contour)
    const wet = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...PEAK })
      .channelData[0].subarray(LATENCY)
    const before = measure(sig)
    const after = measure(wet)
    assert.ok(
      Math.abs(after - before) < 0.15,
      `${label}: ${before.toFixed(3)} -> ${after.toFixed(3)} dB with no harmonic protection`,
    )
  }
})

test('the peak reference cuts pitched material, which the masked path cannot', () => {
  const sig = pitched(() => 150, { seconds: 3 })
  for (const f of [1600, 3200]) {
    const masked = removedFrom(sig, f, 2, 10, {})
    const peak = removedFrom(sig, f, 2, 10, PEAK)
    assert.ok(Math.abs(masked) < 0.2, `${f} Hz: masked path should be inert, got ${masked.toFixed(2)}`)
    assert.ok(peak > 3, `${f} Hz: peak reference removed only ${peak.toFixed(2)} dB of a 10 dB hump`)
  }
})

test('the peak reference does not regress unpitched material', () => {
  // No pitch means no mask, so this is the one regime the shipping path already
  // treats. It must not be traded away.
  const n = Math.round(3 * SR)
  const noise = new Float32Array(n)
  const amp = Math.pow(10, -20 / 20)
  let s = 77
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    noise[i] = amp * (s / 0x3fffffff - 1)
  }
  for (const f of [1200, 2500]) {
    const shipping = removedFrom(noise, f, 25, 14, {})
    const peak = removedFrom(noise, f, 25, 14, PEAK)
    assert.ok(peak > shipping - 0.5, `${f} Hz: ${shipping.toFixed(2)} -> ${peak.toFixed(2)} dB`)
  }
})

test('the geometric reference window is geometric', () => {
  // REGRESSION GUARD, and it caught a real bug. A window whose half-width in
  // BINS is computed from an octave growth factor is not a log-frequency
  // window: at 2.5 kHz it spans DC to 6.8 kHz, so the reference is set by the
  // bass, sits far above the local level, and nothing protrudes. It reads
  // exactly like a detector blind to broad defects.
  const kernel = new ResonanceKernel(SR)
  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, refMode: 'peak' })
  kernel.magDb.fill(-100)
  // A single loud bin high up; with a geometric window the reference below it
  // must be unaffected well before DC.
  const spike = Math.round(2500 / kernel.binWidth)
  kernel.magDb[spike] = 0
  kernel._peakEnvelope(150)
  const at = f => kernel.envDb[Math.round(f / kernel.binWidth)]
  assert.ok(at(2500) > -100, 'the spike should reach its own bin')
  assert.ok(
    at(300) < -95,
    `a 2.5 kHz spike must not move the reference at 300 Hz, got ${at(300).toFixed(1)} dB`,
  )
})

test('the reference-mode override falls back rather than passing a typo through', () => {
  assert.equal(resolveRefMode(), DEFAULT_REF_MODE, 'no window under test means the shipping mode')
  assert.equal(withRefModeDefaults({ selectivity: 8 }).selectivity, 8)
  // Peak mode carries its own calibration, because the two references disagree
  // about what selectivity measures by an order of magnitude.
  const peak = { ...{ selectivity: 8, depth: 0.67 }, ...RESONANCE_REF_MODE_DEFAULTS.peak }
  assert.ok(peak.selectivity < 8)
  assert.equal(peak.preserveHarmonics, false)
})
