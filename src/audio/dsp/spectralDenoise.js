/**
 * Spectral denoise — the pure-DSP pieces (no Web Audio, no worklet).
 *
 * A noise-PROFILE denoiser in the STFT domain: the noise's power spectrum is
 * learned once from room tone, and every frame each bin is turned down by the
 * Ephraim–Malah MMSE log-spectral-amplitude gain (MMSE-LSA, 1985), with the
 * a priori SNR from the "decision-directed" estimate. That pairing is what
 * keeps the residual from twinkling ("musical noise") the way plain spectral
 * subtraction does; a gain floor (Reduction) and gain smoothing finish it.
 *
 * It removes STATIONARY noise — hiss, fans, HVAC, preamp noise, steady room
 * tone. Noise that changes from moment to moment (traffic, keyboards, babble)
 * is not in a fixed profile and passes through; that is the server's DF3.
 *
 * Framing is StftProcessor's (dsp/stft.js): periodic Hann, 2048 / 512, rfft
 * unscaled. The profile is learned with the same window and transform, so its
 * units are the kernel's |X|² exactly and no scaling ever crosses the two.
 */

import { getFFT, rfftBinCount } from './fft.js'
import { hannPeriodic } from './stft.js'

export const DENOISE_FFT_SIZE = 2048
export const DENOISE_HOP_SIZE = 512

/** Decision-directed smoothing (Ephraim–Malah's 0.98). */
export const DD_ALPHA = 0.98
/** Floor on the a priori SNR, −25 dB: below it the gain rule is all floor anyway. */
export const XI_MIN = 10 ** (-25 / 10)

// ── Exponential integral E1(x), x > 0 ──────────────────────────────────────
//
// Abramowitz & Stegun 5.1.53 (x ≤ 1, |ε| < 2e-7) and 5.1.56 (x ≥ 1,
// |ε| < 5e-5). The gain uses exp(E1/2), so an absolute error of 5e-5 in E1 is
// a relative gain error of 2.5e-5 — 0.0002 dB.
export function expint1(x) {
  if (!(x > 0)) return Infinity
  if (x <= 1) {
    return -Math.log(x) - 0.57721566
      + x * (0.99999193 + x * (-0.24991055 + x * (0.05519968 + x * (-0.00976004 + x * 0.00107857))))
  }
  const num = x * x + 2.334733 * x + 0.250621
  const den = x * x + 3.330657 * x + 1.681534
  return (num / den) * Math.exp(-x) / x
}

/**
 * MMSE-LSA gain for one bin from the a priori SNR ξ and a posteriori SNR γ,
 * capped at 1 (the rule can exceed unity at very low γ, which would ADD noise).
 */
export function lsaGain(xi, gamma) {
  const r = xi / (1 + xi)
  const v = Math.max(r * gamma, 1e-8)
  // Past v ≈ 20, E1 < 1e-10: the exp is 1 to double precision.
  const g = v > 20 ? r : r * Math.exp(0.5 * expint1(v))
  return g > 1 ? 1 : g
}

// ── Noise profile ───────────────────────────────────────────────────────────

/** Frames under this RMS are digital silence (edits, padding), never room tone. */
const SILENCE_FLOOR_DB = -100

/**
 * Learn a noise profile from mono samples.
 *
 * `mode`:
 *   'auto' — the quietest `quietFraction` of frames by RMS, which on speech are
 *            the pauses. Biased a little LOW (a minimum of noisy frames sits
 *            under their mean), which the kernel's Threshold default offsets.
 *   'all'  — every non-silent frame: the caller says the samples ARE room tone.
 *
 * Two passes so memory stays flat on long material: frame RMS first (no FFT),
 * then the spectra of the chosen frames only.
 *
 * Returns { ok, reason?, profile (Float32Array, |X|² per bin), frames,
 *           noiseDb, speechDb, gapDb } — levels are frame RMS, dBFS.
 */
export function learnNoiseProfile(samples, {
  mode = 'auto',
  quietFraction = 0.1,
  fftSize = DENOISE_FFT_SIZE,
  hopSize = DENOISE_HOP_SIZE,
  minFrames = 16,
} = {}) {
  const bins = rfftBinCount(fftSize)
  const n = samples.length
  const frameCount = n >= fftSize ? Math.floor((n - fftSize) / hopSize) + 1 : 0
  if (frameCount < minFrames) return { ok: false, reason: 'too-short', frames: 0 }

  // Pass 1: frame RMS in dB, digital silence excluded.
  const levels = []
  for (let f = 0; f < frameCount; f++) {
    const o = f * hopSize
    let acc = 0
    for (let i = 0; i < fftSize; i++) acc += samples[o + i] * samples[o + i]
    const db = 10 * Math.log10(acc / fftSize + 1e-30)
    if (db > SILENCE_FLOOR_DB) levels.push({ f, db })
  }
  if (levels.length < minFrames) return { ok: false, reason: 'silent', frames: 0 }

  const sorted = levels.map(l => l.db).sort((a, b) => a - b)
  const quantile = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const speechDb = quantile(0.9)

  let chosen
  if (mode === 'all') {
    chosen = levels
  } else {
    const take = Math.max(minFrames, Math.floor(levels.length * quietFraction))
    const cut = sorted[Math.min(sorted.length - 1, take - 1)]
    chosen = levels.filter(l => l.db <= cut).slice(0, take)
  }

  // Pass 2: mean power spectrum of the chosen frames.
  const fft = getFFT(fftSize)
  const win = hannPeriodic(fftSize)
  const frame = new Float64Array(fftSize)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  const acc = new Float64Array(bins)
  let levelAcc = 0
  for (const { f, db } of chosen) {
    const o = f * hopSize
    for (let i = 0; i < fftSize; i++) frame[i] = samples[o + i] * win[i]
    fft.rfft(frame, re, im)
    for (let k = 0; k < bins; k++) acc[k] += re[k] * re[k] + im[k] * im[k]
    levelAcc += 10 ** (db / 10)
  }
  const profile = new Float32Array(bins)
  for (let k = 0; k < bins; k++) profile[k] = acc[k] / chosen.length
  const noiseDb = 10 * Math.log10(levelAcc / chosen.length)

  return {
    ok: true,
    profile,
    frames: chosen.length,
    noiseDb,
    speechDb,
    gapDb: speechDb - noiseDb,
  }
}

/**
 * A power value from the kernel's spectrum as a sine-equivalent level, dBFS:
 * a full-scale sine's peak bin reads 0. For display only.
 */
export function binPowerToDb(power, fftSize = DENOISE_FFT_SIZE) {
  const half = fftSize / 4 // Σ hann / 2 = N/4
  return 10 * Math.log10(power / (half * half) + 1e-30)
}

// ── Display bands ───────────────────────────────────────────────────────────

export const DENOISE_DISPLAY_BANDS = 72
export const DENOISE_DISPLAY_MIN_HZ = 40

/**
 * bin → display band (log spaced, 40 Hz to Nyquist), −1 for bins below the
 * first band. Shared by the kernel (live spectra) and the panel (the profile),
 * so the two curves are drawn on one grid.
 */
export function displayBandMap(sampleRate, fftSize = DENOISE_FFT_SIZE, bands = DENOISE_DISPLAY_BANDS) {
  const bins = rfftBinCount(fftSize)
  const map = new Int16Array(bins)
  const lo = Math.log(DENOISE_DISPLAY_MIN_HZ)
  const hi = Math.log(sampleRate / 2)
  for (let k = 0; k < bins; k++) {
    const hz = (k * sampleRate) / fftSize
    if (hz < DENOISE_DISPLAY_MIN_HZ) { map[k] = -1; continue }
    map[k] = Math.min(bands - 1, Math.floor(((Math.log(hz) - lo) / (hi - lo)) * bands))
  }
  return map
}

/** Mean of `power` per display band, in dB (binPowerToDb). Empty bands borrow a neighbour. */
export function powerToBandsDb(power, map, out, fftSize = DENOISE_FFT_SIZE) {
  const bands = out.length
  const sum = new Float64Array(bands)
  const count = new Uint16Array(bands)
  for (let k = 0; k < map.length; k++) {
    const b = map[k]
    if (b < 0) continue
    sum[b] += power[k]
    count[b]++
  }
  let last = -120
  for (let b = 0; b < bands; b++) {
    if (count[b] > 0) last = binPowerToDb(sum[b] / count[b], fftSize)
    out[b] = last
  }
  return out
}
