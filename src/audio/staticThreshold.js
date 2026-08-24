/**
 * Speech-level measurement for the soft clipper's STATIC threshold mode.
 *
 * WHY THIS EXISTS. The stage's adaptive threshold follows a 3 s peak-referenced
 * speech tracker, which makes Headroom level-invariant — the same knob value
 * means the same thing on a file at -30 dBFS and one at -6, which is the whole
 * reason a consumer tool does not ask for a threshold in dBFS. It also makes
 * the threshold MOVE, and measured on real narration that movement is
 * expensive: an adaptive threshold rises with the speech level, so it lifts at
 * exactly the moment peak control is wanted, and catching the file's tallest
 * peak then forces Headroom down until the threshold reaches far below where a
 * fixed one would sit. Everything in between pays for it — 4-10x more program
 * energy removed for the same peak control once a limiter reads the same moving
 * T, and up to 39.6 dB of extra shaping residual for the identical output peak
 * even with the limiter bypassed.
 *
 * Static mode keeps the first property and drops the second: measure the speech
 * level ONCE over the region, hand it to the kernel as a parameter, and let the
 * threshold sit still.
 *
 * IT REUSES THE KERNEL'S OWN TRACKER RATHER THAN DEFINING A SECOND ONE. The
 * measurement runs a real SoftClipperKernel over the buffer and reads
 * `speechLevelDb` per block. That is deliberate and worth the cost: a
 * reimplementation would be a second definition of "speech level" free to drift
 * from the one the stage actually uses, and Headroom's calibration is tied to
 * the tracker's reading specifically.
 *
 * PREVIEW AND APPLY STAY SAMPLE-IDENTICAL because the result is a PARAMETER.
 * Both paths receive the same number and run the same kernel — there is no
 * two-pass render, no settle-and-latch under a running preview, and nothing
 * that depends on how much audio has been heard so far. This is the pattern
 * Scheps' Auto Output Trim and both compressors' auto-makeup already use.
 */

import { SoftClipperKernel } from './softClipperProcessor.js'

/**
 * Which percentile of the tracker's readings becomes the static level.
 *
 * DERIVED, on the criterion that the static threshold should DELIVER what the
 * adaptive one delivers minus the movement — matched on achieved peak reduction
 * at the same Headroom, which is also what preserves Headroom's existing
 * calibration. Mean / worst absolute error across four real files x Headroom
 * 4/6/8:
 *
 *   p85  0.290 / 1.344      p93  0.175 / 0.459      p99   0.384 / 0.794
 *   p90  0.261 / 1.175      p95  0.223 / 0.570      p100  0.566 / 1.565
 *
 * A genuine interior optimum — the tracker's own maximum is 3x worse than the
 * best — and what is derived is "HIGH, NOT MEDIAN". The measured optimum is
 * p93; 0.90 ships because the whole p85-p95 band sits within 0.3 dB of mean
 * error, p93's margin over p90 rests on a single cell of one file, and only
 * three of the four files could discriminate at all (the hard-mastered one has
 * so little crest that it reads 0.000 dB error at every percentile).
 *
 * ⚠ CONFIRM ON MORE NARRATORS BEFORE TREATING THE EXACT VALUE AS SETTLED. It is
 * one constant and cheap to move.
 */
export const SPEECH_LEVEL_PERCENTILE = 0.90

/**
 * Blocks of tracker output needed before a measurement is trustworthy.
 *
 * Below this the percentile is a statistic over a handful of syllables. The
 * caller gets null and should fall back to adaptive rather than render against
 * a number that means nothing.
 */
const MIN_VOICED_BLOCKS = 40 // ~0.1 s of gated speech at 128 samples

const BLOCK = 128

/**
 * Measure the speech level of one region, in dBFS.
 *
 * @param {Float32Array[]} channelData Region to measure. Multi-channel input is
 *   passed through as-is; the kernel downmixes internally exactly as it does
 *   when rendering, so the measurement sees what the detector will see.
 * @param {number} sampleRate
 * @param {{percentile?: number}} [options]
 * @returns {number|null} The measured level, or null if the region is too short
 *   or too quiet to measure — in which case the caller must NOT enter static
 *   mode.
 */
export function measureSpeechLevelDb(channelData, sampleRate, options = {}) {
  const percentile = options.percentile ?? SPEECH_LEVEL_PERCENTILE
  const n = channelData[0]?.length ?? 0
  if (!n) return null

  const kernel = new SoftClipperKernel(sampleRate)
  // Headroom does not affect what the tracker READS — it only shifts T — so the
  // measurement is independent of the knob, which is what lets one measurement
  // serve every Headroom setting. The limiter is off because its only effect
  // here would be to cost time.
  kernel.setParams({ limiter: 0 })

  const out = channelData.map(() => new Float32Array(BLOCK))
  const readings = []
  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    kernel.process(
      channelData.map(c => c.subarray(off, off + BLOCK)),
      out,
      BLOCK,
    )
    // ⚠ WARM-UP READINGS MUST NOT REACH THE PERCENTILE. During its first 500 ms
    // the tracker is parked at SPEECH_INIT_HOLD_DB — which is 0 dBFS, i.e. the
    // loudest value in the whole distribution. On a long file those blocks are
    // a rounding error and a high percentile never reaches them; on a short
    // selection they are a quarter of the samples and the measurement becomes
    // "0 dBFS" outright. Excluded explicitly rather than left to the arithmetic.
    if (kernel.speechWarmupCount < kernel.speechWarmupTarget) continue
    readings.push(kernel.speechLevelDb)
  }

  if (readings.length < MIN_VOICED_BLOCKS) return null
  readings.sort((a, b) => a - b)
  return readings[Math.min(readings.length - 1, Math.floor(percentile * (readings.length - 1)))]
}
