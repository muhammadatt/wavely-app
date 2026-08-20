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
import { hannSymmetric, percentile } from './analysis.js'

/**
 * THIS MEASUREMENT HAS ITS OWN, MUCH LONGER WINDOW, and running it on the
 * region machinery's FRAME_SIZE 2048 / N_FFT 4096 was a defect with two
 * symptoms. Both were found by running the heuristic against real recordings
 * for the first time.
 *
 * SYMPTOM 1 — SILENT TOTAL FAILURE ON LOW CORNERS. The tilt bands are
 * fractions of the corner, so at 2048 they are one or two bins wide, and below
 * two bins `bandLevelDb` returns null, `analyzeRumble` returns null, and no
 * rumble finding is produced at all. Swept across corners 40-100 Hz: at 48 kHz
 * EVERY corner below 75 failed; at 44.1 kHz every corner below 65 failed, and
 * 75 failed while 70 and 80 passed — pure bin-alignment luck. A clean
 * synthetic voice at F0 90 returned null outright. Deep-voiced narrators got
 * no rumble analysis whatsoever and nothing said so. That is the same
 * too-few-bins failure this heuristic was written to REPLACE in `sub_bass`,
 * which the header above criticises for getting 6.5 bins.
 *
 * SYMPTOM 2 — LEAKAGE, worth 8 dB and a sign. At 48 kHz a 2048-sample frame
 * gives 23.4 Hz of true resolution and a Hann mainlobe about 94 Hz wide, so
 * the whole 20-100 Hz region this heuristic reads sat inside one mainlobe. The
 * HIGH band, being nearest F0, caught the most leakage, which made every tilt
 * read steeper than it was. Three real narrators, tilt at frame 2048 / 8192 /
 * 32768:
 *
 *   A (48 kHz, corner 85.8)   -3.28   +4.47   +5.00   <- sign flips
 *   B (44.1 kHz, corner 100)  -3.43   -3.87   -3.90
 *   C (22 kHz, corner 65.4)   -9.57   -8.23   -8.35
 *
 * B and C were roughly right, having had 3-4 bins. A was wrong by 8.3 dB and
 * in the wrong DIRECTION — its spectrum genuinely RISES 5 dB toward DC, which
 * is heavy rumble, and the old window called it a clean-ish fall. Corroborated
 * independently: that file's 40-60 Hz band sits 7.9 dB below its own
 * 300-3000 Hz speech band.
 *
 * 16384 samples gives 2.9 Hz resolution at 48 kHz and 7+ bins in the narrowest
 * band at every corner in range, so symptom 1 cannot recur at any supported
 * rate. It is also CHEAPER than what it replaces — a 16384-point FFT every
 * 4096 samples against a 4096-point one every 512 — and measured rather than
 * assumed: 544 ms -> 307 ms on a 35.5 s selection, 56% of the old cost.
 */
const RUMBLE_FRAME_SIZE = 16384
const RUMBLE_HOP_SIZE = 4096

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
 * ⚠ MOVED WITH THE WINDOW, and the two are not separable. Correcting the
 * leakage shifted every tilt several dB flatter, so the old -14 — calibrated
 * against the leakage-inflated reading — began offering 8.8 dB of cut on clean
 * audio the moment the window was fixed. A constant fitted on top of a broken
 * measurement cannot survive the measurement being repaired.
 *
 * ⚠ AND IT IS STILL NOT REALLY A CONSTANT. The clean tilt varies with where
 * the corner lands, which is a defect in the STATISTIC and is not fixed here.
 * Clean synthetic voices measure, at the corrected window:
 *
 *   F0  90 -> corner 49.5   tilt -20.10
 *   F0 120 -> corner 66     tilt  -9.49
 *   F0 180 -> corner 99     tilt -10.27
 *   F0 220 -> corner 100    tilt  -5.20
 *
 * A 15 dB spread across recordings with nothing wrong with them. So any single
 * number trades false positives against misses, and the only defensible way to
 * pick one for a consumer tool is to refuse the false positives: -5 is the
 * FLATTEST clean reading, so nothing measured as clean can be offered a cut.
 *
 * Swept over the candidates — worst gain offered on a clean case, against what
 * survives of detection:
 *
 *   candidate    worst false positive    on -30 dBFS rumble
 *      -4              0.00 dB                 2.0 dB
 *      -5              0.00                    3.0        <- shipped
 *      -6              0.80 (not reportable)   4.0
 *      -7              1.80                    5.0
 *     -14              8.80                   12.0        <- the old value, post-fix
 *
 * -5 is a knee rather than a point on a slope: it is the last value with no
 * false-positive gain at all, and -6 is the last with none REPORTABLE. On the
 * three real narrators it gives -10.0 / -1.1 / 0.0 dB, which is the ordering
 * their absolute band levels support — the one with 40-60 Hz energy 7.9 dB
 * under its own speech band gets the large cut, the already-high-passed one
 * gets nothing.
 *
 * ⚠ The cost of choosing the conservative end is misses: a genuinely rumbly
 * recording whose corner happens to land where clean audio reads flat will be
 * under-corrected. That is the right way round for a tool that runs unasked.
 *
 * ⚠ STILL NO KNOWN-CLEAN UNMASTERED NARRATOR RECORDING. The flattest clean
 * reading above comes from a synthetic voice; the one real file with a clean
 * bottom end is hard-mastered, so using it as the clean reference would assume
 * what it is meant to prove. The next step is to make the clean tilt a
 * function of the corner rather than a constant — or to decide the tilt is the
 * wrong statistic and measure sub-F0 energy against a proper noise-floor
 * reference instead.
 */
const CLEAN_TILT_DB = -5

/** Shelf slope. Gentle, so a slightly misplaced corner costs little. */
export const RUMBLE_Q = 0.7

/** The most this will ever remove, and the least it will bother reporting. */
const MAX_RUMBLE_CUT_DB = 12
const MIN_REPORTABLE_DB = 1.0

/**
 * Mean power spectrum across the whole selection, pauses included.
 *
 * @returns {null | { spectrum: Float64Array, nFft: number }} the transform size
 *   travels WITH the spectrum, because it is chosen from the selection length —
 *   a caller converting bins to Hz against a module constant would be wrong on
 *   any selection shorter than RUMBLE_FRAME_SIZE.
 */
function meanPowerSpectrum(audio) {
  // A selection shorter than the frame would produce no frames at all and
  // silently disable the heuristic — precisely the class of failure the long
  // window was introduced to remove, so it must not be reintroduced here.
  // Halve until it fits, with a floor: below 2048 there is no low-frequency
  // resolution worth having and null is the honest answer rather than a
  // number nothing supports.
  let frameSize = RUMBLE_FRAME_SIZE
  while (frameSize > audio.length) frameSize >>= 1
  if (frameSize < 2048) return null
  const hop = Math.max(1, (frameSize * RUMBLE_HOP_SIZE) / RUMBLE_FRAME_SIZE)

  const nFft = frameSize
  const fft = getFFT(nFft)
  const bins = rfftBinCount(nFft)
  const window = hannSymmetric(frameSize)
  const padded = new Float64Array(nFft)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  const acc = new Float64Array(bins)

  let frames = 0
  for (let s = 0; s + frameSize <= audio.length; s += hop) {
    padded.fill(0)
    for (let i = 0; i < frameSize; i++) padded[i] = audio[s + i] * window[i]
    fft.rfft(padded, re, im)
    for (let k = 0; k < bins; k++) acc[k] += re[k] * re[k] + im[k] * im[k]
    frames++
  }
  if (frames === 0) return null
  for (let k = 0; k < bins; k++) acc[k] /= frames
  return { spectrum: acc, nFft }
}

/**
 * Mean power per bin over a band, in dB.
 *
 * Per bin rather than summed, so the two bands being compared are not biased by
 * being different widths — the comparison is of levels, not of totals.
 */
function bandLevelDb(spectrum, nFft, sampleRate, loHz, hiHz) {
  let sum = 0
  let n = 0
  for (let k = 1; k < spectrum.length; k++) {
    const f = (k * sampleRate) / nFft
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

  const measured = meanPowerSpectrum(audio)
  if (!measured) return null
  const { spectrum, nFft } = measured

  const low = bandLevelDb(spectrum, nFft, sampleRate, cornerHz * LOW_BAND[0], cornerHz * LOW_BAND[1])
  const high = bandLevelDb(spectrum, nFft, sampleRate, cornerHz * HIGH_BAND[0], cornerHz * HIGH_BAND[1])
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
