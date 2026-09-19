/**
 * The two numbers the Punch Chain's plate prints, and the phrase segmentation
 * behind one of them.
 *
 * DENSITY is gated RMS minus the 99.9th percentile of sample magnitude, in dB,
 * signed so that HIGHER IS DENSER. It is the user's own definition — "lower the
 * crest, raise the RMS" — collapsed to one number, which those two statements
 * become as soon as the output is peak-pinned: with the peak held at a ceiling,
 * crest down and RMS up are the same move.
 *
 * ⚠ REFERENCED TO THE 99.9th PERCENTILE AND NOT TO THE SAMPLE PEAK, and this is
 * not a detail — it is the third time this codebase has had to learn it (see
 * MAKEUP_PERCENTILE, and the server compressor's voiced-frame crest). Measured
 * on one narration clip with and without a single 12 ms plosive, FET drive 50
 * into the Opto at PR 0:
 *
 *                      no plosive   plosive
 *   rms - P99.9          -10.75     -10.75
 *   rms - sample peak    -12.57     -23.07
 *
 * A peak-referenced readout moves 10.5 dB because of one transient, and a knob
 * solved against it would be reading the plosive rather than the voice. The
 * percentile reference is invariant to it across all three test clips.
 *
 * LEVEL SPREAD is the P90-P10 range of per-phrase RMS, in dB, LOWER IS MORE
 * CONSISTENT. It exists because density alone actively misleads in the region
 * of the panel people should be using: on real narration at FET drive 25,
 * taking the Opto from PR 40 to PR 75 reads as -11.43 -> -12.09 density, which
 * looks like pure loss, while spread goes 5.23 -> 2.88, which is the entire
 * reason to be there. One number makes the Opto's job look like a mistake; two
 * make the trade visible and let the user decide, which is what the plate is
 * for.
 */

import { percentileOfChannels, MAKEUP_PERCENTILE } from './makeupReference.js'
import { gatedRmsOfChannels } from './inputAlign.js'

/** Block length for phrase detection, ms. */
const PHRASE_BLOCK_MS = 20
/**
 * How far below the file's gated RMS a block has to sit to count as between
 * phrases, dB. Wide enough that the quiet tail of a sentence stays inside its
 * phrase; narrow enough that a breath between sentences does not join two.
 */
const PHRASE_GATE_BELOW_DB = 15
/** Shortest run of blocks that counts as a phrase (80 ms at the block above). */
const PHRASE_MIN_BLOCKS = 4

const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))

/**
 * Energy-gated phrase boundaries, as `[startSample, endSample]` pairs.
 *
 * ⚠ DETECT ON THE SOURCE AND REUSE THE RESULT FOR EVERY PROCESSED RENDER. The
 * gate is relative to the material's own gated RMS, so re-detecting on a
 * compressed render moves the boundaries: compression lifts the quiet blocks
 * toward the gate and phrases merge, which makes the spread of a heavily
 * compressed render look better than it is by measuring FEWER, LONGER phrases
 * rather than more consistent ones. Segment once, measure many times — that is
 * why this is a separate export rather than something `measureChainMetrics`
 * does for itself.
 *
 * Deliberately not the VAD behind the Auto Leveler: this is a readout that has
 * to refresh on a knob's cadence, and the VAD is a server round trip.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Array<[number, number]>}
 */
export function detectPhrases(channels, sampleRate) {
  if (!channels?.length || !(channels[0].length > 0)) return []
  const ch = channels[0]
  const blk = Math.max(1, Math.round(sampleRate * PHRASE_BLOCK_MS / 1000))
  const n = Math.floor(ch.length / blk)
  if (n === 0) return []

  const energy = new Float32Array(n)
  for (let b = 0; b < n; b++) {
    let sum = 0
    const from = b * blk
    for (let i = from; i < from + blk; i++) sum += ch[i] * ch[i]
    energy[b] = Math.sqrt(sum / blk)
  }

  const gate = gatedRmsOfChannels(channels, sampleRate)
    * Math.pow(10, -PHRASE_GATE_BELOW_DB / 20)

  const runs = []
  let start = -1
  for (let b = 0; b < n; b++) {
    if (energy[b] > gate) {
      if (start < 0) start = b
    } else if (start >= 0) {
      if (b - start >= PHRASE_MIN_BLOCKS) runs.push([start * blk, b * blk])
      start = -1
    }
  }
  if (start >= 0 && n - start >= PHRASE_MIN_BLOCKS) runs.push([start * blk, n * blk])
  return runs
}

/**
 * Density in dB — gated RMS minus the 99.9th percentile. Higher is denser.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {number} dB, or NaN if the region has no measurable content
 */
export function measureDensityDb(channels, sampleRate) {
  const rms = gatedRmsOfChannels(channels, sampleRate)
  const pct = percentileOfChannels(channels, MAKEUP_PERCENTILE)
  if (!(rms > 0) || !(pct > 0)) return NaN
  return db(rms) - db(pct)
}

/**
 * Phrase-level spread in dB — P90 minus P10 of per-phrase RMS. Lower is more
 * consistent.
 *
 * ⚠ TAKES THE PHRASES RATHER THAN FINDING THEM, so the same boundaries can be
 * used for the source and for every render measured against it. See
 * `detectPhrases`.
 *
 * @param {Float32Array[]} channels
 * @param {Array<[number, number]>} phrases
 * @returns {number} dB, or NaN with fewer than two measurable phrases
 */
export function measureSpreadDb(channels, phrases) {
  if (!channels?.length || !phrases?.length) return NaN
  const ch = channels[0]
  const levels = []
  for (const [from, to] of phrases) {
    const end = Math.min(to, ch.length)
    if (end - from < 2) continue
    let sum = 0
    for (let i = from; i < end; i++) sum += ch[i] * ch[i]
    const rms = Math.sqrt(sum / (end - from))
    if (rms > 0) levels.push(db(rms))
  }
  if (levels.length < 2) return NaN
  levels.sort((a, b) => a - b)
  const at = (f) => levels[Math.min(levels.length - 1, Math.max(0, Math.round(f * (levels.length - 1))))]
  return at(0.9) - at(0.1)
}

/**
 * Both readouts for one buffer.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {Array<[number, number]>} phrases from `detectPhrases` on the SOURCE
 * @returns {{ densityDb: number, spreadDb: number }}
 */
export function measureChainMetrics(channels, sampleRate, phrases) {
  return {
    densityDb: measureDensityDb(channels, sampleRate),
    spreadDb: measureSpreadDb(channels, phrases),
  }
}
