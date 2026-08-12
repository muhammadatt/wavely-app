/**
 * VoiceRx v2 — representation.
 *
 * Produces everything downstream reads from one pass over the audio: the
 * voiced-frame spectral envelope, the noise floor measured the same way, and
 * the two half-selection envelopes that the confidence stage needs.
 *
 * WHY THE NOISE FLOOR IS MEASURED AND NOT ASSUMED. v1 decides what part of the
 * spectrum is real with `DEAD_REGION_DB`: anything more than 60 dB below the
 * envelope peak is treated as empty. That is a guess standing in for a
 * measurement, and the scorecard shows what it costs — a clean voice whose
 * bandwidth ends at 9 kHz gets an 8 dB cut it does not need, while a voice with
 * a 17 dB notch in it sails through the same test because the notch floor is
 * nowhere near 60 dB down.
 *
 * The distinction those two cases need is not "how far below the peak" but "is
 * there any voice here at all", and that is answerable directly. Frames above
 * the gate carry speech plus noise; frames in the pauses carry noise alone.
 * Subtract the two and you have per-frequency SNR — a measurement, in dB, of
 * exactly the thing the mask is supposed to represent. Above a bandwidth edge
 * it collapses to nothing. Inside a notch it does not: the reference clip holds
 * 23 dB there, which is why one is unreadable and the other is merely quiet.
 *
 * Both curves are liftered identically so the subtraction is meaningful. A
 * smoothed speech envelope minus a raw noise spectrum would be comparing two
 * different things and the difference would carry the smoothing, not the SNR.
 */

import { getFFT, rfftBinCount } from '../../dsp/fft.js'
import { F0Tracker } from '../../dsp/f0.js'
import { hannSymmetric, percentile } from '../analysis.js'

export const FRAME_SIZE = 2048
export const HOP_SIZE = 512
export const N_FFT = 4096
const NATS_TO_DB = 10.0 / Math.LN10

/** Frames needed before an analysis is worth returning at all. */
export const MIN_VOICED_FRAMES = 40

/** Cap on frames fed to the mean, strided across the selection when exceeded. */
const MAX_ANALYSIS_FRAMES = 2000

/**
 * Percentile of frame energies taken as the noise floor, and the margin above
 * it that counts as speech.
 *
 * Same shape as v1's gate and for the same reason, but used differently: v1
 * wants one number to compare a whole region against, while this wants two
 * disjoint FRAME SETS — everything above the gate, and everything at the very
 * bottom — so that the two spectra it averages are actually different material.
 */
const FLOOR_PERCENTILE = 10
const VOICED_MARGIN_DB = 8
const QUIET_PERCENTILE = 15

/**
 * Build the tapered cepstral lifter. Keeps the low quefrencies — the smooth
 * formant envelope — and fades to zero approaching the cutoff where harmonic
 * structure lives.
 */
function buildLifter(lifterCutoff) {
  const tl = Math.max(1, Math.min(lifterCutoff, N_FFT >>> 1))
  const full = hannSymmetric(2 * tl)
  const half = full.subarray(tl)
  let peak = 0
  for (let i = 0; i < half.length; i++) if (half[i] > peak) peak = half[i]
  const norm = peak > 0 ? 1 / peak : 1

  const lifter = new Float64Array(N_FFT)
  for (let i = 0; i < tl; i++) {
    lifter[i] = half[i] * norm
    lifter[N_FFT - tl + i] = half[tl - 1 - i] * norm
  }
  return lifter
}

/**
 * Accumulates liftered log-spectra into a mean envelope.
 *
 * Separate object per frame set so the full selection, its two halves and the
 * noise can all be built in ONE pass over the audio. Running the analysis three
 * times to get the halves would triple the transform count, which is the entire
 * cost of this module.
 */
class EnvelopeAccumulator {
  constructor(bins) {
    this.sum = new Float64Array(bins)
    this.count = 0
  }

  add(envReal) {
    for (let k = 0; k < this.sum.length; k++) this.sum[k] += envReal[k]
    this.count++
  }

  toDb() {
    const out = new Float64Array(this.sum.length)
    if (this.count === 0) return out.fill(-Infinity)
    const scale = NATS_TO_DB / this.count
    for (let k = 0; k < out.length; k++) out[k] = this.sum[k] * scale
    return out
  }
}

/**
 * Measure a selection.
 *
 * @param {Float32Array} audio mono
 * @param {number} sampleRate
 * @returns {object|null} null when there is not enough pitched material
 */
export function measure(audio, sampleRate) {
  const starts = []
  for (let s = 0; s + FRAME_SIZE <= audio.length; s += HOP_SIZE) starts.push(s)
  if (starts.length === 0) return null

  const energiesDb = new Float64Array(starts.length)
  for (let i = 0; i < starts.length; i++) {
    let sumSq = 0
    for (let j = 0; j < FRAME_SIZE; j++) {
      const x = audio[starts[i] + j]
      sumSq += x * x
    }
    energiesDb[i] = 20 * Math.log10(Math.sqrt(sumSq / FRAME_SIZE) + 1e-10)
  }

  const floorDb = percentile(energiesDb, FLOOR_PERCENTILE)
  const loudDb = percentile(energiesDb, 90)
  // Held below the top decile so a selection of unbroken speech, whose 10th
  // percentile is simply its quietest speech, does not gate away most of itself.
  const gateDb = Math.min(floorDb + VOICED_MARGIN_DB, loudDb - VOICED_MARGIN_DB)
  const quietDb = percentile(energiesDb, QUIET_PERCENTILE)

  const tracker = new F0Tracker({ sampleRate, frameSize: FRAME_SIZE })
  const voiced = []
  const f0Values = []
  const quiet = []
  for (let i = 0; i < starts.length; i++) {
    const frame = audio.subarray(starts[i], starts[i] + FRAME_SIZE)
    const { f0, pitched } = tracker.estimate(frame, energiesDb[i] > gateDb)
    if (pitched && f0 > 0) {
      voiced.push(starts[i])
      f0Values.push(f0)
    } else if (energiesDb[i] <= quietDb) {
      quiet.push(starts[i])
    }
  }

  if (voiced.length < MIN_VOICED_FRAMES) {
    return {
      ok: false,
      reason: voiced.length / starts.length < 0.1 ? 'no_voiced_frames' : 'insufficient_voiced',
      voicedFrames: voiced.length,
    }
  }

  let selected = voiced
  if (voiced.length > MAX_ANALYSIS_FRAMES) {
    selected = []
    for (let k = 0; k < MAX_ANALYSIS_FRAMES; k++) {
      selected.push(voiced[Math.round((k * (voiced.length - 1)) / (MAX_ANALYSIS_FRAMES - 1))])
    }
  }

  const medianF0Hz = percentile(f0Values, 50)
  const p5 = percentile(f0Values, 5)
  const lifter = buildLifter(Math.trunc((0.85 / (p5 > 0 ? p5 : medianF0Hz)) * sampleRate))

  const bins = rfftBinCount(N_FFT)
  const fft = getFFT(N_FFT)
  const window = hannSymmetric(FRAME_SIZE)
  const padded = new Float64Array(N_FFT)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  const logPower = new Float64Array(bins)
  const cepstrum = new Float64Array(N_FFT)
  const envRe = new Float64Array(bins)
  const envIm = new Float64Array(bins)

  const full = new EnvelopeAccumulator(bins)
  const firstHalf = new EnvelopeAccumulator(bins)
  const secondHalf = new EnvelopeAccumulator(bins)
  const noise = new EnvelopeAccumulator(bins)

  const liftered = (start) => {
    padded.fill(0)
    for (let i = 0; i < FRAME_SIZE; i++) padded[i] = audio[start + i] * window[i]
    fft.rfft(padded, re, im)
    for (let k = 0; k < bins; k++) logPower[k] = Math.log(re[k] * re[k] + im[k] * im[k] + 1e-10)
    fft.irfft(logPower, null, cepstrum)
    for (let i = 0; i < N_FFT; i++) cepstrum[i] *= lifter[i]
    fft.rfft(cepstrum, envRe, envIm)
    return envRe
  }

  const midpoint = selected.length >> 1
  for (let i = 0; i < selected.length; i++) {
    const env = liftered(selected[i])
    full.add(env)
    // Halves split by POSITION IN THE SELECTION, not by alternating frames.
    // Alternate frames are two samples of the same moment and would agree with
    // each other whatever happened; the question confidence needs answered is
    // whether a feature is still there later in the passage.
    ;(i < midpoint ? firstHalf : secondHalf).add(env)
  }
  for (const start of quiet) noise.add(liftered(start))

  const freqsHz = new Float64Array(bins)
  for (let k = 0; k < bins; k++) freqsHz[k] = (k * sampleRate) / N_FFT

  return {
    ok: true,
    freqsHz,
    envelopeDb: full.toDb(),
    firstHalfDb: firstHalf.toDb(),
    secondHalfDb: secondHalf.toDb(),
    // Absent when the selection has no pauses at all. Downstream treats that as
    // "no floor measured" rather than "floor is zero" — an unbroken take is a
    // reason to be less certain, not a reason to call everything live.
    noiseDb: noise.count > 0 ? noise.toDb() : null,
    medianF0Hz,
    voicedFrames: selected.length,
    totalFrames: starts.length,
    quietFrames: quiet.length,
  }
}
