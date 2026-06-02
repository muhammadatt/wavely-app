/**
 * Analytic noise-floor lift prediction for parametric peaking EQ chains.
 *
 * Replaces the apply+remeasure ACX backoff loops in correctiveEQ and referenceEQ.
 * Given a noise-floor PSD (measured, or a pink-1/f fallback) and a set of
 * peaking-biquad EQ bands, predicts the lift in dB that the cascade applies to
 * the RMS of a signal with that PSD. The solver inverts this prediction to find
 * the smallest uniform reduction across low-frequency boost bands that keeps
 * the post-EQ noise floor under the ACX ceiling.
 *
 * Approach matches the digital RBJ peaking-biquad |H(e^jω)|² that FFmpeg's
 * `equalizer` filter implements, so the prediction tracks the realised filter
 * response — not an analog approximation.
 *
 * PSD model precedence (per the design call): measured (Welch-style over the
 * silence frames classified by the upstream Silero VAD) when available; pink
 * 1/f over a log-spaced grid as a fallback so the predictor never depends on
 * the measurement succeeding.
 */

import Meyda from 'meyda'
import { readWavSamples } from './wavReader.js'

const PSD_FFT_SIZE     = 1024  // power-of-2, ≤ 25 ms frame at 44.1 kHz (1102 samples)
const PSD_BAND_COUNT   = 64    // log-spaced bins used by the predictor
const PSD_F_MIN_HZ     = 20
const PSD_F_MAX_HZ     = 22050
const PSD_MIN_FRAMES   = 5     // below this, measurement is too noisy — fall back

/**
 * Digital RBJ peaking-biquad |H(e^jω)|² at one frequency.
 * Same coefficients FFmpeg's `equalizer` filter realises for width_type=q.
 */
export function peakingBiquadResponseSq(freqHz, fc, q, gainDb, sampleRate = 44100) {
  const A     = Math.pow(10, gainDb / 40)
  const w0    = 2 * Math.PI * fc / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)

  const b0 =  1 + alpha * A
  const b1 = -2 * cosW0
  const b2 =  1 - alpha * A
  const a0 =  1 + alpha / A
  const a1 = -2 * cosW0
  const a2 =  1 - alpha / A

  const w     = 2 * Math.PI * freqHz / sampleRate
  const cosW  = Math.cos(w)
  const cos2W = Math.cos(2 * w)

  const num = b0*b0 + b1*b1 + b2*b2 + 2*(b0*b1 + b1*b2)*cosW + 2*b0*b2*cos2W
  const den = a0*a0 + a1*a1 + a2*a2 + 2*(a0*a1 + a1*a2)*cosW + 2*a0*a2*cos2W
  return num / den
}

/**
 * Predicted RMS lift in dB applied by a peaking-biquad cascade to a signal
 * with the given PSD. ΔdB = 10·log10(⟨|H_total|²·S⟩ / ⟨S⟩).
 *
 * @param {{freq_hz:number,q:number,gain_db:number}[]} bands
 * @param {{freqHz:Float64Array, power:Float64Array}} psd
 * @param {number} [sampleRate]
 */
export function predictNoiseFloorLiftDb(bands, psd, sampleRate = 44100) {
  let powerOut = 0
  let powerIn  = 0
  for (let i = 0; i < psd.freqHz.length; i++) {
    const f = psd.freqHz[i]
    let hSq = 1
    for (const b of bands) {
      hSq *= peakingBiquadResponseSq(f, b.freq_hz, b.q, b.gain_db, sampleRate)
    }
    powerOut += hSq * psd.power[i]
    powerIn  += psd.power[i]
  }
  if (powerIn <= 0) return 0
  return 10 * Math.log10(powerOut / powerIn)
}

/**
 * Find the smallest uniform reduction R (dB) applied to bands matched by
 * `isLfBoost(band)` such that pre + predicted-lift ≤ target. Closed-form
 * bisection on R; no audio I/O.
 *
 * Returns `{ reductionDb, bands, predictedLiftDb, exhausted }`:
 *   - reductionDb = 0           → already compliant
 *   - 0 < reductionDb < maxLfG  → partial backoff resolves it
 *   - reductionDb = maxLfG, exhausted=true → non-LF bands alone exceed target
 */
export function solveAcxLfBoostReductionDb(
  bands, noiseFloorPreDb, targetDb, psd, isLfBoost, sampleRate = 44100,
) {
  const headroomDb = targetDb - noiseFloorPreDb

  const filterTrivial = list => list.filter(b => Math.abs(b.gain_db) >= 0.1)
  const applyReduction = (R) => filterTrivial(bands.map(b =>
    isLfBoost(b) ? { ...b, gain_db: Math.max(0, b.gain_db - R) } : b,
  ))

  const baseLift = predictNoiseFloorLiftDb(bands, psd, sampleRate)
  if (baseLift <= headroomDb) {
    return { reductionDb: 0, bands, predictedLiftDb: baseLift, exhausted: false }
  }

  const lfGains = bands.filter(isLfBoost).map(b => b.gain_db)
  const maxLfGain = lfGains.length > 0 ? Math.max(...lfGains) : 0
  if (maxLfGain <= 0) {
    return { reductionDb: 0, bands, predictedLiftDb: baseLift, exhausted: true }
  }

  const zeroedBands = applyReduction(maxLfGain)
  const zeroedLift  = predictNoiseFloorLiftDb(zeroedBands, psd, sampleRate)
  if (zeroedLift > headroomDb) {
    return { reductionDb: maxLfGain, bands: zeroedBands, predictedLiftDb: zeroedLift, exhausted: true }
  }

  // Lift is monotonically non-increasing in R — bisect to ≈1 milli-dB precision.
  let lo = 0, hi = maxLfGain
  for (let i = 0; i < 14; i++) {
    const mid  = (lo + hi) / 2
    const lift = predictNoiseFloorLiftDb(applyReduction(mid), psd, sampleRate)
    if (lift > headroomDb) lo = mid
    else hi = mid
  }
  const reductionDb    = hi
  const finalBands     = applyReduction(reductionDb)
  const predictedLiftDb = predictNoiseFloorLiftDb(finalBands, psd, sampleRate)
  return { reductionDb, bands: finalBands, predictedLiftDb, exhausted: false }
}

/**
 * Pink 1/f PSD on a log-spaced grid. Used when no silence-frame measurement
 * is available. Power per band ∝ 1/fc; band-edge weighting falls out of the
 * log grid spacing and matches a constant-energy-per-octave noise floor.
 */
export function pinkPsdFallback(nyquistHz = PSD_F_MAX_HZ, nBands = PSD_BAND_COUNT) {
  const freqHz = new Float64Array(nBands)
  const power  = new Float64Array(nBands)
  const ratio  = Math.pow(nyquistHz / PSD_F_MIN_HZ, 1 / (nBands - 1))
  let f = PSD_F_MIN_HZ
  for (let i = 0; i < nBands; i++) {
    freqHz[i] = f
    power[i]  = 1 / f
    f *= ratio
  }
  return { freqHz, power, source: 'pink_fallback' }
}

/**
 * Measure the noise-floor PSD and scalar dBFS floor over the upstream VAD's
 * silence frames in a single pass.
 *
 * Iterates the frames classified as isSilence, takes a Hann-windowed
 * PSD_FFT_SIZE window from each, accumulates a mean power spectrum (reduced
 * to a log-spaced PSD_BAND_COUNT grid), and in the same pass accumulates the
 * unweighted sum-of-squares of the same sample windows so the returned PSD
 * and `noiseFloorDbfs` describe the same silence-frame population at the
 * same moment in the chain. Callers therefore don't need to read the global
 * `ctx.results.metrics.noiseFloorDbfs` — which may have been written several
 * stages earlier and grown stale — for the EQ headroom calculation.
 *
 * Returns `null` when fewer than PSD_MIN_FRAMES silence frames are available
 * — callers should fall back to pinkPsdFallback() for the PSD shape and to
 * the upstream ctx scalar (if any) for the floor.
 *
 * @param {string} wavPath
 * @param {{offsetSamples:number,lengthSamples:number,isSilence:boolean}[]} frames
 * @returns {Promise<{
 *   freqHz:Float64Array, power:Float64Array,
 *   source:string, nFrames:number, noiseFloorDbfs:number
 * } | null>}
 */
export async function measureNoiseFloorPsd(wavPath, frames) {
  if (!frames || frames.length === 0) return null

  const { samples, sampleRate } = await readWavSamples(wavPath)
  const window = hannWindow(PSD_FFT_SIZE)

  Meyda.bufferSize = PSD_FFT_SIZE
  const accum = new Float64Array(PSD_FFT_SIZE / 2)
  // Allocate the windowed-frame scratch buffer once and overwrite per frame.
  // Meyda reads the buffer synchronously inside extract(), so reuse is safe
  // and avoids an O(nSilenceFrames) GC churn on long files.
  const win   = new Float32Array(PSD_FFT_SIZE)
  let nFrames  = 0
  let sumSq    = 0
  let nSamples = 0

  for (const f of frames) {
    if (!f.isSilence) continue
    if (f.offsetSamples + PSD_FFT_SIZE > samples.length) continue
    let frameSumSq = 0
    for (let i = 0; i < PSD_FFT_SIZE; i++) {
      const s = samples[f.offsetSamples + i]
      win[i] = s * window[i]
      frameSumSq += s * s
    }
    const ps = Meyda.extract('powerSpectrum', win)
    if (!ps) continue
    for (let i = 0; i < accum.length; i++) accum[i] += ps[i]
    sumSq    += frameSumSq
    nSamples += PSD_FFT_SIZE
    nFrames++
  }

  if (nFrames < PSD_MIN_FRAMES) return null

  // Scalar floor over the same windows that built the PSD. Floored at -120
  // dBFS for digital-silence regions (e.g. inserted padding).
  const meanSq         = sumSq / nSamples
  const noiseFloorDbfs = meanSq > 0 ? 10 * Math.log10(meanSq) : -120

  for (let i = 0; i < accum.length; i++) accum[i] /= nFrames

  // Reduce raw bin powers (linear freq grid, ~43 Hz/bin at 44.1k) onto a
  // log-spaced PSD_BAND_COUNT-band grid by averaging source bins per band.
  const binHz = sampleRate / PSD_FFT_SIZE
  const freqHz = new Float64Array(PSD_BAND_COUNT)
  const power  = new Float64Array(PSD_BAND_COUNT)
  const ratio  = Math.pow(PSD_F_MAX_HZ / PSD_F_MIN_HZ, 1 / (PSD_BAND_COUNT - 1))

  let fc = PSD_F_MIN_HZ
  for (let b = 0; b < PSD_BAND_COUNT; b++) {
    const lo = fc / Math.sqrt(ratio)
    const hi = fc * Math.sqrt(ratio)
    const loIdx = Math.max(1, Math.floor(lo / binHz))
    const hiIdx = Math.min(accum.length - 1, Math.ceil(hi / binHz))
    let sum = 0
    let count = 0
    for (let i = loIdx; i <= hiIdx; i++) { sum += accum[i]; count++ }
    freqHz[b] = fc
    power[b]  = count > 0 ? sum / count : 0
    fc *= ratio
  }

  return { freqHz, power, source: 'measured', nFrames, noiseFloorDbfs }
}

function hannWindow(n) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))
  return w
}

/**
 * Convert a PSD record to a JSON-serialisable plain object. The Python-side
 * referenceEQ solver consumes the same shape (snake_case keys).
 */
export function serializePsd(psd) {
  return {
    freq_hz: Array.from(psd.freqHz),
    power:   Array.from(psd.power),
    source:  psd.source,
  }
}
