/**
 * Rumble — the one correction VoiceRx makes without a deviation measurement.
 *
 * WHY THIS IS NOT A REGION. Every other finding is "this part of the spectrum
 * departs from its own neighbourhood". Below the fundamental that question has
 * no answer, and the region machinery fails at it in four compounding ways:
 *
 *  - `sub_bass` scans 60-130 Hz, and the analysed span starts at 60, so its
 *    left context window lies entirely outside the spectrum. The baseline there
 *    is one-sided.
 *  - At 44.1 kHz with N_FFT 4096 the bins are 10.77 Hz apart, so that scan is
 *    6.5 bins wide and its context is 1.3. `nasal` gets 51 bins.
 *  - It carries the highest threshold in the table, 4.0 dB, so the region with
 *    the least evidence has to clear the highest bar.
 *  - Real rumble — HVAC, traffic, handling, plosive thump — is mostly BELOW
 *    60 Hz, which the envelope never looks at.
 *
 * Measured on a synthetic voice: a +20 dB resonance at 90 Hz moves the chord's
 * `sub_bass` deviation from 1.12 to 2.83 dB, never reaching its threshold, and
 * a +20 dB peak at 40 Hz moves it by 0.06 dB. The region is effectively blind,
 * and no amount of threshold tuning fixes a measurement taken from 6 bins with
 * one anchor.
 *
 * SO THIS ASKS A DIFFERENT QUESTION. Below F0 there cannot be voice — that is
 * physics, not a comparison — which is why mixing engineers roll off the bottom
 * of a vocal more or less unconditionally, and why the server's ACX chain
 * carries a fixed 80 Hz high-pass. VoiceRx is often a front-end user's FIRST
 * step, before any of that, so it should offer the same thing.
 *
 * The corner is prophylactic and the depth is measured: a shelf is always
 * placed just under where this speaker's voice actually begins, but it only
 * carries gain when there is something below it worth removing. A clean booth
 * recording gets a shelf of roughly zero, which is suppressed.
 *
 * Reads the mean spectrum of the WHOLE selection, not the voiced-frame cepstral
 * envelope. Deliberate: rumble does not stop when the narrator does, so the
 * pauses are evidence rather than something to gate away.
 */

import { getFFT, rfftBinCount } from '../dsp/fft.js'
import { hannSymmetric, percentile, FRAME_SIZE, HOP_SIZE, N_FFT } from './analysis.js'

/**
 * Where to put the corner, relative to the pitch the speaker actually uses.
 *
 * NOT from a low percentile of F0, which is the obvious choice and is wrong.
 * The tracker's search floor is 70 Hz, and octave-halving errors pile up
 * against it: on the reference clip the F0 quantiles run p1 71, p5 76, p10 84,
 * p25 107, median 138 — so p5 is reporting the floor, not the speaker. Taking
 * the lower of two robust statistics, one from the low quarter and one from the
 * median, gives an estimate that survives a tracker that slips occasionally.
 */
const P25_FACTOR = 0.75
const MEDIAN_FACTOR = 0.55

/**
 * Hard bounds on the corner. The upper one matters most: an F0 estimate that
 * comes out too HIGH would put the shelf into the voice and thin it, which is
 * the one failure here that is worse than doing nothing. 100 Hz is above any
 * adult speaking fundamental's useful floor and still below most female F0.
 */
const MIN_CORNER_HZ = 40
const MAX_CORNER_HZ = 100

/**
 * The measurement: how the spectrum is tilted BELOW the corner.
 *
 * An absolute energy ratio was tried first and discriminates poorly — 20 dB of
 * added rumble moved it by 5.5 dB, and a resonance at 90 Hz (above the corner,
 * not rumble at all) moved it in the same direction. Tilt separates cleanly
 * because it tests the SHAPE that distinguishes the two cases: with no voice
 * energy below F0, a clean recording's spectrum falls away toward DC, while
 * rumble is energy piled at the very bottom, which flattens or reverses it.
 *
 * Measured on the reference clip, comparing the octave under the corner
 * against the bottom of the range:
 *
 *   clean                 -14.7 dB      +12 dB shelf at 55 Hz   -7.4 dB
 *   +6 dB shelf at 55 Hz  -11.1 dB      +20 dB shelf at 55 Hz   -3.2 dB
 *   +10 dB peak at 90 Hz  -20.3 dB   <- correctly ignored, it is above the corner
 */
const LOW_BAND = [0.25, 0.5]
const HIGH_BAND = [0.72, 1.0]

/**
 * The tilt a recording with nothing wrong is expected to show.
 *
 * CALIBRATED ON ONE FILE and physically motivated rather than fitted: it stands
 * for the natural fall-off below the fundamental. Anything flatter than this is
 * energy that the voice cannot have put there. This is the weakest constant
 * here and the first thing to re-derive once raw, unmastered narrator
 * recordings exist — every file available when it was written was either
 * synthetic or already mastered, and mastering has usually already high-passed
 * the bottom away.
 */
const CLEAN_TILT_DB = -14

/** Shelf slope. Gentle, so a slightly misplaced corner costs little. */
export const RUMBLE_Q = 0.7

/** The most this will ever remove, and the least it will bother reporting. */
const MAX_RUMBLE_CUT_DB = 12
const MIN_REPORTABLE_DB = 1.0

/** Mean power spectrum across the whole selection, pauses included. */
function meanPowerSpectrum(audio, sampleRate) {
  const fft = getFFT(N_FFT)
  const bins = rfftBinCount(N_FFT)
  const window = hannSymmetric(FRAME_SIZE)
  const padded = new Float64Array(N_FFT)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  const acc = new Float64Array(bins)

  let frames = 0
  for (let s = 0; s + FRAME_SIZE <= audio.length; s += HOP_SIZE) {
    padded.fill(0)
    for (let i = 0; i < FRAME_SIZE; i++) padded[i] = audio[s + i] * window[i]
    fft.rfft(padded, re, im)
    for (let k = 0; k < bins; k++) acc[k] += re[k] * re[k] + im[k] * im[k]
    frames++
  }
  if (frames === 0) return null
  for (let k = 0; k < bins; k++) acc[k] /= frames
  return acc
}

/**
 * Mean power per bin over a band, in dB.
 *
 * Per bin rather than summed, so the two bands being compared are not biased by
 * being different widths — the comparison is of levels, not of totals.
 */
function bandLevelDb(spectrum, sampleRate, loHz, hiHz) {
  let sum = 0
  let n = 0
  for (let k = 1; k < spectrum.length; k++) {
    const f = (k * sampleRate) / N_FFT
    if (f >= loHz && f < hiHz) {
      sum += spectrum[k]
      n++
    }
  }
  // Fewer than two bins is not a measurement. Returning null rather than a
  // number keeps a 0-bin band from reading as silence, which would look exactly
  // like a steep clean roll-off and suppress the shelf on the files that most
  // need it.
  return n >= 2 ? 10 * Math.log10(sum / n + 1e-30) : null
}

/** Where this speaker's voice stops, with the tracker's failures allowed for. */
export function rumbleCornerHz(f0Values) {
  if (!f0Values?.length) return null
  const p25 = percentile(f0Values, 25)
  const median = percentile(f0Values, 50)
  if (!(p25 > 0) || !(median > 0)) return null
  const wanted = Math.min(p25 * P25_FACTOR, median * MEDIAN_FACTOR)
  return Math.min(MAX_CORNER_HZ, Math.max(MIN_CORNER_HZ, wanted))
}

/**
 * @returns {null | {
 *   cornerHz: number, tiltDb: number, gainDb: number, q: number, applies: boolean
 * }} null when there is not enough to measure from at all.
 */
export function analyzeRumble(audio, sampleRate, f0Values) {
  const cornerHz = rumbleCornerHz(f0Values)
  if (cornerHz === null) return null

  const spectrum = meanPowerSpectrum(audio, sampleRate)
  if (!spectrum) return null

  const low = bandLevelDb(spectrum, sampleRate, cornerHz * LOW_BAND[0], cornerHz * LOW_BAND[1])
  const high = bandLevelDb(spectrum, sampleRate, cornerHz * HIGH_BAND[0], cornerHz * HIGH_BAND[1])
  if (low === null || high === null) return null

  const tiltDb = low - high
  // Flatter than a clean roll-off is rumble; steeper is a quiet bottom end and
  // wants nothing. Negative excess clamps to zero rather than becoming a boost:
  // there is never a reason to LIFT a band that cannot contain voice.
  const excessDb = Math.max(0, tiltDb - CLEAN_TILT_DB)
  // `|| 0` normalises the -0 that negating a zero excess produces. It is
  // harmless arithmetically and not harmless in a stored band gain, where it
  // survives into state and compares unequal to 0 under Object.is.
  const gainDb = -Math.min(MAX_RUMBLE_CUT_DB, excessDb) || 0

  return {
    cornerHz: Math.round(cornerHz * 10) / 10,
    tiltDb: Math.round(tiltDb * 100) / 100,
    gainDb: Math.round(gainDb * 100) / 100,
    q: RUMBLE_Q,
    applies: Math.abs(gainDb) >= MIN_REPORTABLE_DB,
  }
}
