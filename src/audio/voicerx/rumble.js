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

/**
 * ⚠ MEASURED AGAINST THREE REAL NARRATORS AND NOT RE-DERIVED, because the
 * measurement turns out to have two structural defects that have to be fixed
 * FIRST — and a constant fitted on top of a broken measurement is worse than
 * the one already here. Recorded so the next attempt starts from evidence.
 *
 * DEFECT 1 — SILENT TOTAL FAILURE ON LOW CORNERS. The tilt bands are fractions
 * of the corner, so they are only a few FFT bins wide at the region
 * machinery's FRAME_SIZE 2048 / N_FFT 4096, and below two bins `bandLevelDb`
 * returns null, `analyzeRumble` returns null, and no rumble finding is
 * produced at all. Swept across corners 40-100 Hz: at 48 kHz EVERY corner
 * below 75 fails; at 44.1 kHz every corner below 65 fails, and 75 fails while
 * 70 and 80 pass — pure bin-alignment luck. Reproduced on a synthetic clean
 * voice at F0 90 (corner 49.5), which returns null outright. A deep-voiced
 * narrator gets no rumble analysis whatsoever and nothing says so. This is the
 * same "too few bins" failure this heuristic was written to replace in
 * `sub_bass`, which the note at the top of this file criticises for getting
 * 6.5 bins; the tilt bands get one or two.
 *
 * DEFECT 2 — THE CLEAN TILT IS NOT A CONSTANT. It varies with where the corner
 * lands, so a single CLEAN_TILT_DB cannot be right for every voice. On the
 * shipped build, clean synthetic voices measure:
 *
 *   F0  90  ->  corner 49.5   NULL (defect 1)
 *   F0 120  ->  corner 66     tilt -15.76   gain  0.00   <- what -14 was fitted to
 *   F0 180  ->  corner 99     tilt -10.22   gain -3.78
 *   F0 220  ->  corner 100    tilt  -8.24   gain -5.76
 *
 * So a higher-pitched narrator with a perfectly clean bottom end is already
 * offered a 5.8 dB cut. The constant was calibrated at F0 120 and is a
 * function of the corner, not a property of clean audio.
 *
 * WHAT THE WINDOW IS DOING TO IT. At 48 kHz, FRAME_SIZE 2048 gives 23.4 Hz of
 * true resolution and a Hann mainlobe about 94 Hz wide — the whole 20-100 Hz
 * region this heuristic reads fits inside one mainlobe, and the HIGH band,
 * being nearest F0, catches the most leakage, which makes the tilt look
 * steeper than it is. Re-measuring with 16384-sample frames on three real
 * narrators (tilt at frame 2048 / 8192 / 32768):
 *
 *   A (48 kHz, corner 85.8)   -3.28   +4.47   +5.00   <- sign flips
 *   B (44.1 kHz, corner 100)  -3.43   -3.87   -3.90
 *   C (22 kHz, corner 65.4)   -9.57   -8.23   -8.35
 *
 * B and C were roughly right, having had 3-4 bins. A was wrong by 8.3 dB and
 * in the wrong DIRECTION: its spectrum genuinely RISES 5 dB toward DC, which is
 * heavy rumble, and the shipped window called it a clean-ish fall.
 *
 * WHAT THE THREE FILES ACTUALLY CONTAIN, independently of any of this — mean
 * band level relative to the same file's 300-3000 Hz speech band:
 *
 *   A (normalised)      40-60 Hz  -7.9 dB     <- a great deal of LF energy
 *   B (raw)             40-60 Hz -11.5 dB
 *   C (hard-mastered)   40-60 Hz -16.2 dB, 10-40 Hz -22 to -24  <- high-passed
 *
 * The shipped heuristic offers -10.72 / -10.57 / -4.43 dB on these, which is
 * the right ORDERING and plausibly the right magnitudes for A and B. So the
 * heuristic is not obviously wrong on real rumble; it is wrong about clean
 * audio and blind on low corners.
 *
 * THE ORDER OF WORK IS: give this measurement its own long window (16384
 * samples is cheaper than what runs now — a 16384-point FFT every 4096 samples
 * against a 4096-point one every 512), which fixes defect 1 outright; then
 * decide whether the clean tilt can be predicted from the corner or whether
 * the tilt is simply the wrong statistic. Only then re-derive this number.
 * Re-deriving it now would fit it to leakage.
 *
 * ⚠ Still no KNOWN-CLEAN unmastered narrator recording. C is high-passed, so
 * using it as the clean reference assumes what it is meant to prove.
 */

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
