/**
 * Per-stage result merger registry for the chunked runner.
 *
 * Each entry merges per-chunk writes for a single ctx.results key back into
 * the parent. Adding a new stage to a {chunked: [...]} block means adding
 * an entry here — no changes to chunkedRunner.js.
 *
 * Merge contract:
 *   - Each merger is keyed by the ctx.results key it owns (NOT the stage
 *     function name — a stage may write under a differently-named key, e.g.
 *     clickRemove → ctx.results.clickRemover).
 *   - The merger receives chunkValues: an array of per-chunk values for the
 *     key, in chunk order. Entries are `undefined` for chunks that didn't
 *     write the key. The runner skips the merger entirely when no chunk
 *     wrote anything, so mergers can assume at least one defined value.
 *   - The merger returns the merged value to assign to ctx.results[key].
 *     Returning `undefined` skips the assignment.
 *
 * Whole-file metric scalars (noiseFloorDbfs, voicedRmsDbfs, …) are NOT
 * merged here — refreshPostBlockMetrics in chunkedRunner.js measures the
 * stitched output instead, which is exact rather than averaged.
 */

export const CHUNK_MERGERS = {
  /**
   * hpf — boolean derived from the parent's pre-block noise floor. Identical
   * across chunks because every sub-ctx reads the same metrics.noiseFloorDbfs
   * snapshot. Take the first defined value.
   */
  notch60Hz(chunkValues) {
    return chunkValues.find(v => v !== undefined)
  },

  /**
   * vocalSaturation — config snapshot ({applied, drive, wetDry, …}), identical
   * across chunks. Shallow-copy the first defined entry so the merged value
   * can be mutated downstream without aliasing a sub-ctx's results object.
   */
  vocalSaturation(chunkValues) {
    const first = chunkValues.find(v => v != null)
    return first ? { ...first } : undefined
  },

  /**
   /**
    * clickRemove — structural fields (applied, parameters, per-channel layout)
    * from the first defined chunk value; cumulative counts SUMMED across chunks for a file-level
   * representative sample — per-channel summing would require knowing the
   * channel layout, and the top-level summed counts already give the
   * file-level totals.
   */
  clickRemover(chunkValues) {
    const first = chunkValues.find(v => v != null)
    if (!first) return undefined
    const merged = { ...first }
    const summedKeys = ['clicks_detected', 'clicks_repaired', 'clicks_skipped', 'total_clicks_repaired']
    for (const key of summedKeys) {
      const total = sumDefined(chunkValues.map(v => v?.[key]))
      if (total != null) merged[key] = total
    }
    return merged
  },

  /**
   /**
    * noiseReduce — structural fields (model, applied, reason) from the first defined chunk value;
   * chunks for a representative file-level figure.
   * post_noise_floor_dbfs is overwritten by refreshPostBlockMetrics later
   * so it agrees exactly with the metrics block.
   */
  noiseReduction(chunkValues) {
    const first = chunkValues.find(v => v != null)
    if (!first) return undefined
    const merged = { ...first }
    const averagedKeys = ['makeupGainDb', 'post_noise_floor_dbfs', 'pre_noise_floor_dbfs']
    for (const key of averagedKeys) {
      const avg = meanDefined(chunkValues.map(v => v?.[key]))
      if (avg != null) merged[key] = round2(avg)
    }
    return merged
  },

  /**
   * airBoost — structural fields (requested_gain_db, bands, sibilantMask
   * config) from the first defined chunk value. The ACX compliance loop
   * runs per chunk against each chunk's local noise floor, so applied_gain_db
   * may differ across chunks; report the minimum (most conservative) so the
   * compliance summary doesn't overstate the boost actually applied at any
   * seam.
   */
  airBoost(chunkValues) {
    const first = chunkValues.find(v => v != null)
    if (!first) return undefined
    const merged = { ...first }

    const appliedGains = chunkValues
      .filter(v => v?.applied && typeof v.applied_gain_db === 'number')
      .map(v => v.applied_gain_db)
    if (appliedGains.length) {
      merged.applied_gain_db = round2(Math.min(...appliedGains))
    }

    return merged
  },

  /**
   * resonanceSuppressor — structural fields (lifter_cutoff, band_summary,
   * passes) from the first defined chunk value. Per-chunk band_summary entries
   * are not stitched into a file-level list: bands are detected against each
   * chunk's own spectrum so identical resonances in different chunks would
   * appear as separate entries with slightly different centres; the first
   * chunk's summary is a representative sample, matching the policy used for
   * clickRemover's per-channel layout. Telemetry is aggregated:
   *   max_reduction_db   — max across chunks (worst-case peak)
   *   mean_reduction_db  — mean of per-chunk means (approx file-level mean)
   *   spike_frames       — sum across chunks (frame counts are additive)
   *   artifact_risk      — OR across chunks
   *   sibilant_frames_received — sum across chunks
   *   applied            — OR across chunks (file applied iff any chunk did)
   */
  resonanceSuppressor(chunkValues) {
    const first = chunkValues.find(v => v != null)
    if (!first) return undefined
    const merged = { ...first }

    merged.applied = chunkValues.some(v => v?.applied === true)

    const maxReds = chunkValues
      .map(v => v?.max_reduction_db)
      .filter(v => typeof v === 'number' && isFinite(v))
    if (maxReds.length) merged.max_reduction_db = round2(Math.max(...maxReds))

    const meanRed = meanDefined(chunkValues.map(v => v?.mean_reduction_db))
    if (meanRed != null) merged.mean_reduction_db = round2(meanRed)

    const spikeTotal = sumDefined(chunkValues.map(v => v?.spike_frames))
    if (spikeTotal != null) merged.spike_frames = spikeTotal

    merged.artifact_risk = chunkValues.some(v => v?.artifact_risk === true)

    const sibTotal = sumDefined(chunkValues.map(v => v?.sibilant_frames_received))
    if (sibTotal != null) merged.sibilant_frames_received = sibTotal

    return merged
  },
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function sumDefined(values) {
  let sum = 0
  let count = 0
  for (const v of values) {
    if (typeof v === 'number' && isFinite(v)) {
      sum += v
      count++
    }
  }
  return count > 0 ? sum : null
}

export function meanDefined(values) {
  const finite = values.filter(v => typeof v === 'number' && isFinite(v))
  if (!finite.length) return null
  return finite.reduce((a, b) => a + b, 0) / finite.length
}

export function round2(n) {
  return Math.round(n * 100) / 100
}
