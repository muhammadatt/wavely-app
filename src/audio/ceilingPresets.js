/**
 * Ceiling presets — putting the soft clipper's threshold where the material
 * says it should go.
 *
 * THE PANEL HAS ONE THRESHOLD MODE: a ceiling in dBFS that the user can see and
 * turn. What these presets add is a way to land on a sensible value for THIS
 * recording without knowing what dBFS means for it — measure the file's own
 * peak distribution and put the ceiling at a chosen percentile of it. The name
 * is then a statement about the result: SOFT clips the top 3% of peaks, SQUASH
 * the top 22%.
 *
 * ⚠ THE PERCENTILE IS OF THE SIGNAL'S OWN BLOCK PEAKS, NOT OF THE SPEECH
 * TRACKER'S READINGS, and the difference is not cosmetic — it decides whether
 * the presets do anything at all. Measured across four real files:
 *
 *   percentile of...        p97          p93          p85          p78
 *   tracker readings    0.0-2.8%     0.0-3.6%     0.0-6.4%     0.0-9.2%   engaged
 *   block peaks         0.2-4.0%     0.5-9.2%    1.3-18.3%    2.3-26.2%
 *
 * The tracker's readings span only 3-9 dB over a whole file, so percentiles of
 * them sit almost on top of each other; on the hard-mastered file every one of
 * the four landed ABOVE the file's own peak (+3.4 to -0.5 dBFS) and all four
 * presets did exactly nothing. Block peaks are the distribution the threshold
 * actually cuts into, so a percentile of them is monotonic on every file and
 * means what the label says.
 *
 * ⚠ ENGAGED DOES NOT EQUAL 100-p, and it should not be expected to. The curve
 * reads a pre-emphasised signal against a threshold the HF lift raises by up to
 * emphasisDb, so the effective ceiling sits above the number set here. The
 * ladder is monotonic and material-relative, which is what a named preset owes
 * the user; it is not a percentage guarantee.
 */

const BLOCK_MS = 10

/**
 * How far below the loudest block a block can sit and still count.
 *
 * Without it, room tone and pauses dominate the distribution and every
 * percentile collapses toward the noise floor — the ceiling would land tens of
 * dB too low and the stage would shred the file.
 */
const VOICED_FLOOR_DB = 40

/**
 * The presets, loudest ceiling first.
 *
 * Values are the user-facing ladder confirmed on four real narrators: each step
 * roughly doubles how much of the file the curve touches, and every step moves
 * on every file — including the hard-mastered one, where a tracker-referenced
 * ladder was completely inert.
 */
export const CEILING_PRESETS = [
  { id: 'soft', label: 'SOFT', percentile: 0.97, title: 'Ceiling at the top 3% of peaks' },
  { id: 'medium', label: 'MEDIUM', percentile: 0.93, title: 'Ceiling at the top 7% of peaks' },
  { id: 'hard', label: 'HARD', percentile: 0.85, title: 'Ceiling at the top 15% of peaks' },
  { id: 'squash', label: 'SQUASH', percentile: 0.78, title: 'Ceiling at the top 22% of peaks' },
]

/** The preset a freshly-opened panel lands on. */
export const DEFAULT_CEILING_PRESET = 'medium'

export function presetById(id) {
  return CEILING_PRESETS.find(p => p.id === id) ?? null
}

/**
 * Measure where a ceiling should sit for one region, in dBFS.
 *
 * @param {Float32Array[]} channelData Region to measure. Channels are combined
 *   by taking the loudest of them per sample, which is what a peak ceiling has
 *   to answer to.
 * @param {number} sampleRate
 * @param {number} percentile 0-1, from CEILING_PRESETS.
 * @returns {number|null} The ceiling in dBFS, or null if the region has no
 *   measurable content — in which case the caller must leave the ceiling alone
 *   rather than moving it somewhere meaningless.
 */
export function measurePeakCeilingDb(channelData, sampleRate, percentile) {
  const n = channelData[0]?.length ?? 0
  const blockN = Math.max(1, Math.round((BLOCK_MS / 1000) * sampleRate))
  if (!n || n < blockN) return null

  const peaks = []
  for (let off = 0; off + blockN <= n; off += blockN) {
    let pk = 0
    for (const ch of channelData) {
      for (let i = off; i < off + blockN; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i]
        if (a > pk) pk = a
      }
    }
    if (pk > 0) peaks.push(20 * Math.log10(pk))
  }
  if (!peaks.length) return null

  let top = -Infinity
  for (const p of peaks) if (p > top) top = p
  const voiced = peaks.filter(p => p > top - VOICED_FLOOR_DB).sort((a, b) => a - b)
  if (!voiced.length) return null

  const idx = Math.min(voiced.length - 1, Math.max(0, Math.floor(percentile * (voiced.length - 1))))
  return voiced[idx]
}
