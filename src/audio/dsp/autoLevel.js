/**
 * Auto Leveler — client port of the server's clip-automation leveler.
 *
 * Direct port of server/pipeline/autoLeveler.js. Same constants, same steps,
 * same order: VAD voiced runs -> sub-phrase splits at sustained internal level
 * drops -> per-clip K-weighted LUFS -> shapeDrift against a per-clip target ->
 * merge conflicting neighbours -> cosine crossfades at the lowest-energy point
 * of each boundary.
 *
 * WHAT A "CLIP" IS, AND WHY THERE IS NO SMOOTHING. Gain is piecewise constant
 * within a clip, so the dynamics *inside* a phrase survive untouched and only
 * the level *between* phrases moves. That is the whole difference between this
 * and a compressor, and it is why the leveler can sit in front of one without
 * the two fighting over the same transients.
 *
 * ── THE ONE THING THAT IS NOT PORTED ─────────────────────────────────────────
 *
 * The voiced/silence mask. The server gets it from Silero v5 through a Python
 * subprocess; there is no Silero in the browser, and unlike VoiceRx's corrective
 * EQ — which wants *pitched* frames specifically and so can substitute an F0
 * tracker honestly — this wants speech presence, which is exactly the
 * distinction dsp/f0.js warns against faking. Fricatives and breaths are speech
 * and are not pitched, and a leveler that ends its clips early at every /s/
 * would place crossfades inside words.
 *
 * So the mask comes from the server, once, through /api/analyze/vad, and
 * everything downstream of it runs here. That split is not a compromise: the
 * mask depends only on the audio, while every control the user turns
 * (target mode and window, deadband, knee, the two caps) acts on numbers
 * derived *after* it. One round trip buys unlimited knob turns.
 *
 * ── THE TWO-PHASE SHAPE ──────────────────────────────────────────────────────
 *
 *   prepareAutoLevel()  audio + mask -> clips, per-clip LUFS, prefix sums.
 *                       O(n) with two biquad passes. Runs once per analysis.
 *   solveAutoLevel()    prepared + config -> gains, merges, crossfades.
 *                       O(clips). Runs on every knob move.
 *
 * The split falls exactly where the server's own data flow does; it is only
 * that the server never had a reason to name the halves.
 *
 * Dependency-free apart from ./biquad.js. No Web Audio, no DOM — the caller
 * hands in a mono Float32Array, which keeps this unit-testable without an
 * AudioContext.
 */

import { BiquadCascade } from './biquad.js'

// ── Constants (must track server/pipeline/autoLeveler.js) ────────────────────

export const HOP_MS = 100

// VAD hysteresis parameters
const VAD_MIN_VOICED_MS   = 200
const VAD_MIN_UNVOICED_MS = 300

// Skip condition thresholds
const MIN_FILE_DURATION_S   = 10
const MIN_VOICED_DURATION_S = 5

// Sub-phrase splitting: split a voiced run when an internal level drop of
// >= SUBPHRASE_SPLIT_DROP_DB is sustained for >= SUBPHRASE_SPLIT_MIN_DURATION_MS.
const SUBPHRASE_SPLIT_DROP_DB         = 6.0
const SUBPHRASE_SPLIT_MIN_DURATION_MS = 500

// Cosine crossfade duration at clip boundaries.
export const CROSSFADE_MS = 30

// Transparent-fallback merge: adjacent clips with gain delta exceeding this
// threshold are merged into one clip with a duration-weighted average gain.
const MERGE_MAX_DELTA_DB = 6.0

// Sub-phrase splitting recursion guard — never split a sub-clip shorter than
// twice the minimum drop duration (otherwise the split point can't itself
// satisfy the duration check).
const MIN_SUBCLIP_HOPS_FACTOR = 2

/** Short-term LUFS window for the sub-phrase split curve. */
const ST_WINDOW_MS = 400

/**
 * Defaults, from the ACX Audiobook preset's autoLeveler block.
 *
 * `global` rather than `running_median` because a spot edit is usually one
 * passage: a running median over a 60 s window inside a 30 s selection is the
 * global median with extra steps, and on a long selection the global target is
 * the one that makes two separately-levelled regions match each other.
 */
export const AUTOLEVEL_DEFAULTS = {
  target_mode:             'global',
  target_window_s:         60,
  noise_floor_target_dbfs: -60,
  deadband_db:             0.75,
  knee_db:                 1.0,
  max_up_db:               10.0,
  max_down_db:             10.0,
}

// ── K-weighting filter (EBU R128 / ITU-R BS.1770-4) ──────────────────────────

/**
 * The two BS.1770 stages as normalised biquad sections.
 *
 * Coefficients are the server's, which are the standard's: a high-shelf
 * pre-filter approximating the head's acoustic effect, then a 38 Hz high-pass.
 * They are written out rather than designed through biquad.js's `highShelf`
 * because the standard specifies these exact numbers, and a design function
 * that agrees to five decimals is not the same thing as the reference.
 */
export function kWeightingSections(sampleRate) {
  // Stage 1: high-shelf pre-filter
  const K1  = Math.tan(Math.PI * 1681.974450955533 / sampleRate)
  const Vh  = Math.pow(10.0, 3.999843853973347 / 20.0)
  const Vb  = Math.pow(Vh, 0.4996667741545416)
  const Q1  = 0.7071752369554196
  const a0s = 1.0 + K1 / Q1 + K1 * K1

  // Stage 2: high-pass filter at 38.135 Hz
  const K2  = Math.tan(Math.PI * 38.13547087602444 / sampleRate)
  const Q2  = 0.5003270373238773
  const a0h = 1.0 + K2 / Q2 + K2 * K2

  return [
    {
      b0: (Vh + Vb * K1 / Q1 + K1 * K1) / a0s,
      b1: 2.0 * (K1 * K1 - Vh) / a0s,
      b2: (Vh - Vb * K1 / Q1 + K1 * K1) / a0s,
      a1: 2.0 * (K1 * K1 - 1.0) / a0s,
      a2: (1.0 - K1 / Q1 + K1 * K1) / a0s,
    },
    {
      b0: 1.0 / a0h,
      b1: -2.0 / a0h,
      b2: 1.0 / a0h,
      a1: 2.0 * (K2 * K2 - 1.0) / a0h,
      a2: (1.0 - K2 / Q2 + K2 * K2) / a0h,
    },
  ]
}

/** @returns {Float64Array} K-weighted copy of `samples`. */
export function applyKWeighting(samples, sampleRate) {
  const cascade = new BiquadCascade(2, 1)
  cascade.setSections(kWeightingSections(sampleRate))
  const out = new Float64Array(samples.length)
  cascade.process(samples, out, samples.length, 0)
  return out
}

// ── Power-sum prefix array (for O(1) energy-in-range queries) ────────────────

export function buildPowerSum(samples) {
  const n = samples.length
  const ps = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + samples[i] * samples[i]
  return ps
}

function meanSquareRange(powerSum, start, end) {
  if (end <= start) return 0
  return (powerSum[end] - powerSum[start]) / (end - start)
}

function meanSquareToLufs(meanSq) {
  return meanSq > 0 ? -0.691 + 10.0 * Math.log10(meanSq) : NaN
}

// ── VAD mask ─────────────────────────────────────────────────────────────────

/**
 * Expand the route's run-length encoded voiced runs back to a per-frame mask.
 *
 * @param {Array<[number, number]>} voicedRuns [startInclusive, endExclusive)
 * @param {number} numFrames
 */
export function expandVoicedRuns(voicedRuns, numFrames) {
  const mask = new Uint8Array(numFrames)
  for (const [start, end] of voicedRuns ?? []) {
    const a = Math.max(0, Math.min(numFrames, start))
    const b = Math.max(0, Math.min(numFrames, end))
    for (let f = a; f < b; f++) mask[f] = 1
  }
  return mask
}

/**
 * Two-pass hysteresis over the raw mask.
 *
 * Pass 1 drops voiced islands shorter than VAD_MIN_VOICED_MS — a single
 * mislabelled frame in a pause would otherwise start a clip. Pass 2 bridges
 * unvoiced gaps shorter than VAD_MIN_UNVOICED_MS, which is what keeps a clip
 * running across the stop consonant in the middle of a word.
 *
 * The order matters and is the server's: dropping first means a bridged gap
 * cannot be re-opened by an island that was never real.
 */
export function conditionVoicedMask(rawMask, frameDurationS) {
  const n = rawMask.length
  if (n === 0) return new Uint8Array(0)

  const frameMs      = frameDurationS * 1000
  const minVoicedF   = Math.max(1, Math.round(VAD_MIN_VOICED_MS   / frameMs))
  const minUnvoicedF = Math.max(1, Math.round(VAD_MIN_UNVOICED_MS / frameMs))

  const voiced = new Uint8Array(rawMask)

  // Pass 1: drop voiced segments shorter than minVoicedF (false positives)
  let f = 0
  while (f < n) {
    if (voiced[f] === 1) {
      let e = f
      while (e < n && voiced[e] === 1) e++
      if (e - f < minVoicedF) for (let k = f; k < e; k++) voiced[k] = 0
      f = e
    } else {
      f++
    }
  }

  // Pass 2: bridge unvoiced gaps shorter than minUnvoicedF (false negatives)
  f = 0
  while (f < n) {
    if (voiced[f] === 0) {
      let e = f
      while (e < n && voiced[e] === 0) e++
      if (e - f < minUnvoicedF) for (let k = f; k < e; k++) voiced[k] = 1
      f = e
    } else {
      f++
    }
  }

  return voiced
}

/**
 * Collapse the 25 ms frame mask onto the 100 ms hop grid.
 *
 * Any voiced frame makes the hop voiced. Asymmetric on purpose: the cost of
 * calling a hop voiced when a quarter of it is speech is that a clip starts
 * 75 ms early, into silence, where the gain step is inaudible. The cost of the
 * other rule is clipping the first phoneme of a phrase.
 *
 * `frameDurationS` and `sampleRate` rather than a frame count, because the
 * server's frames come off a 44.1 kHz grid and the project may be at 48.
 */
export function frameVoicedToHopVoiced(frameVoiced, frameDurationS, numHops) {
  const framesPerHop = Math.max(1, Math.round((HOP_MS * 0.001) / frameDurationS))
  const hopVoiced = new Uint8Array(numHops)
  for (let h = 0; h < numHops; h++) {
    const f0 = h * framesPerHop
    for (let k = 0; k < framesPerHop; k++) {
      if (f0 + k < frameVoiced.length && frameVoiced[f0 + k]) {
        hopVoiced[h] = 1
        break
      }
    }
  }
  return hopVoiced
}

// ── LUFS sliding-window curve (voiced hops only) ─────────────────────────────

export function computeLufsCurve(kwPowerSum, hopVoiced, windowSamples, hopSamples, totalSamples) {
  const numHops = hopVoiced.length
  const halfWin = Math.floor(windowSamples / 2)
  const curve   = new Float64Array(numHops)

  for (let h = 0; h < numHops; h++) {
    if (!hopVoiced[h]) {
      curve[h] = NaN
      continue
    }
    const center = h * hopSamples + Math.floor(hopSamples / 2)
    const start  = Math.max(0, center - halfWin)
    const end    = Math.min(totalSamples, center + halfWin)
    if (end <= start) { curve[h] = NaN; continue }
    curve[h] = meanSquareToLufs(meanSquareRange(kwPowerSum, start, end))
  }

  return curve
}

// ── Clip detection (VAD voiced runs + sub-phrase splits) ─────────────────────

/**
 * @typedef {{ hopStart: number, hopEnd: number, sampleStart: number, sampleEnd: number }} Clip
 */

function vadRunsToClips(hopVoiced, hopSamples, totalSamples) {
  const clips = []
  const n = hopVoiced.length
  let h = 0
  while (h < n) {
    if (hopVoiced[h] === 1) {
      let e = h
      while (e < n && hopVoiced[e] === 1) e++
      clips.push({
        hopStart:    h,
        hopEnd:      e,
        sampleStart: h * hopSamples,
        sampleEnd:   Math.min(e * hopSamples, totalSamples),
      })
      h = e
    } else {
      h++
    }
  }
  return clips
}

/**
 * Recursive sub-phrase splitter.
 *
 * A long unbroken voiced run is not one level: a narrator drops into a
 * parenthetical and comes back up without ever pausing long enough for the VAD
 * to notice. Splitting at a sustained internal drop gives those their own clip
 * and their own gain, which is most of what makes this sound like levelling
 * rather than like fader moves between sentences.
 *
 * Splits at the deepest hop within any internal region where L_st falls
 * >= splitDropDb below the clip's median for >= splitMinDurationHops hops.
 */
function splitClipBySubphrase(clip, L_st, hopSamples, totalSamples, splitDropDb, splitMinDurationHops) {
  const { hopStart, hopEnd } = clip
  const minSubclipHops = MIN_SUBCLIP_HOPS_FACTOR * splitMinDurationHops

  if (hopEnd - hopStart < minSubclipHops) return [clip]

  // Median of finite L_st values inside the clip
  const vals = []
  for (let h = hopStart; h < hopEnd; h++) {
    if (Number.isFinite(L_st[h])) vals.push(L_st[h])
  }
  if (vals.length < 2) return [clip]
  vals.sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  const median = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]
  const dropThreshold = median - splitDropDb

  // Find drop regions
  let bestSplitHop = -1
  let bestSplitVal = Infinity
  let regionStart = -1
  for (let h = hopStart; h <= hopEnd; h++) {
    const below = h < hopEnd && Number.isFinite(L_st[h]) && L_st[h] < dropThreshold
    if (below && regionStart < 0) {
      regionStart = h
    } else if (!below && regionStart >= 0) {
      const regionEnd = h
      if (regionEnd - regionStart >= splitMinDurationHops) {
        // Find local minimum hop in [regionStart, regionEnd)
        let localMinHop = regionStart
        let localMinVal = L_st[regionStart]
        for (let k = regionStart; k < regionEnd; k++) {
          if (L_st[k] < localMinVal) {
            localMinVal = L_st[k]
            localMinHop = k
          }
        }
        // Pick the deepest drop across all qualifying regions
        if (localMinVal < bestSplitVal) {
          bestSplitVal = localMinVal
          bestSplitHop = localMinHop
        }
      }
      regionStart = -1
    }
  }

  if (bestSplitHop < 0) return [clip]

  // Avoid degenerate splits (one sub-clip too short)
  const leftLen  = bestSplitHop - hopStart
  const rightLen = hopEnd - bestSplitHop
  if (leftLen < splitMinDurationHops || rightLen < splitMinDurationHops) return [clip]

  const left = {
    hopStart,
    hopEnd:      bestSplitHop,
    sampleStart: hopStart * hopSamples,
    sampleEnd:   Math.min(bestSplitHop * hopSamples, totalSamples),
  }
  const right = {
    hopStart:    bestSplitHop,
    hopEnd,
    sampleStart: bestSplitHop * hopSamples,
    sampleEnd:   Math.min(hopEnd * hopSamples, totalSamples),
  }

  return [
    ...splitClipBySubphrase(left,  L_st, hopSamples, totalSamples, splitDropDb, splitMinDurationHops),
    ...splitClipBySubphrase(right, L_st, hopSamples, totalSamples, splitDropDb, splitMinDurationHops),
  ]
}

export function detectClips({ hopVoiced, L_st, hopSamples, totalSamples }) {
  const splitMinDurationHops = Math.max(1, Math.round(SUBPHRASE_SPLIT_MIN_DURATION_MS / HOP_MS))
  const baseClips = vadRunsToClips(hopVoiced, hopSamples, totalSamples)
  const out = []
  let subphraseSplits = 0
  for (const clip of baseClips) {
    const sub = splitClipBySubphrase(
      clip, L_st, hopSamples, totalSamples,
      SUBPHRASE_SPLIT_DROP_DB, splitMinDurationHops,
    )
    subphraseSplits += sub.length - 1
    out.push(...sub)
  }
  return { clips: out, subphraseSplits }
}

// ── Per-clip LUFS and weighted statistics ────────────────────────────────────

export function computeClipLufs(kwPowerSum, clip) {
  const meanSq = meanSquareRange(kwPowerSum, clip.sampleStart, clip.sampleEnd)
  return meanSq > 0 ? -0.691 + 10.0 * Math.log10(meanSq) : -120.0
}

export function weightedMedian(values, weights) {
  const n = values.length
  if (n === 0) return NaN
  if (n === 1) return values[0]

  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => values[a] - values[b])

  let totalW = 0
  for (let i = 0; i < n; i++) totalW += weights[i]
  if (totalW <= 0) return values[order[Math.floor(n / 2)]]

  const half = totalW / 2
  let cum = 0
  for (let i = 0; i < n; i++) {
    cum += weights[order[i]]
    if (cum >= half) return values[order[i]]
  }
  return values[order[n - 1]]
}

export function weightedStd(values, weights) {
  const n = values.length
  if (n < 2) return 0
  let totalW = 0, mean = 0
  for (let i = 0; i < n; i++) { totalW += weights[i]; mean += values[i] * weights[i] }
  if (totalW <= 0) return 0
  mean /= totalW
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += weights[i] * (values[i] - mean) ** 2
  return Math.sqrt(varSum / totalW)
}

// ── Per-clip targets ─────────────────────────────────────────────────────────

export function computeClipTargets(clipLufs, clipDurations, sampleStarts, targetWindowS, sampleRate, mode) {
  const n = clipLufs.length
  const out = new Float64Array(n)

  // Global fallback target (also used when running_median has insufficient data)
  const globalTarget = weightedMedian(Array.from(clipLufs), Array.from(clipDurations))

  if (mode === 'global' || n < 2) {
    for (let k = 0; k < n; k++) out[k] = globalTarget
    return out
  }

  const windowSamples = Math.round(targetWindowS * sampleRate)
  const winVals = []
  const winWts  = []
  for (let k = 0; k < n; k++) {
    winVals.length = 0
    winWts.length  = 0
    const cutoff = sampleStarts[k] - windowSamples
    for (let j = 0; j <= k; j++) {
      if (sampleStarts[j] >= cutoff) {
        winVals.push(clipLufs[j])
        winWts.push(clipDurations[j])
      }
    }
    out[k] = winVals.length >= 2
      ? weightedMedian(winVals, winWts)
      : globalTarget
  }
  return out
}

// ── Drift correction with deadband + cubic knee ──────────────────────────────

/**
 * The transfer curve from "how far this clip is from its target" to "how much
 * to move it".
 *
 * The deadband is why this does not audibly breathe: inside it the answer is
 * exactly zero, so a clip that is already close is left bit-identical rather
 * than nudged by a tenth of a dB. The smoothstep knee then opens the correction
 * continuously instead of switching it on at the deadband edge, which would put
 * a step in the gain between two clips that differ by a hair either side of it.
 */
export function shapeDrift(delta, deadband, knee, maxUp, maxDown) {
  const abs_d  = Math.abs(delta)
  const sign_d = delta >= 0 ? 1 : -1
  let g

  if (abs_d < deadband) {
    g = 0
  } else if (abs_d <= deadband + knee) {
    const x        = (abs_d - deadband) / knee      // 0..1
    const smoothed = x * x * (3 - 2 * x)            // smoothstep
    g = sign_d * smoothed * (abs_d - deadband)
  } else {
    g = sign_d * (abs_d - deadband)
  }

  return g > 0 ? Math.min(g, maxUp) : Math.max(g, -maxDown)
}

// ── Merge adjacent clips whose gain delta exceeds threshold ──────────────────

/**
 * Transparent fallback: where two neighbouring clips would be pulled more than
 * MERGE_MAX_DELTA_DB apart, level neither and average them instead.
 *
 * A 6 dB step between adjacent phrases is not levelling, it is an edit — and
 * it is nearly always the analysis being wrong about where one phrase ends
 * rather than the narrator really having jumped. Averaging keeps the pair's
 * relationship to the rest of the file while leaving their relationship to each
 * other alone.
 */
export function mergeClipsForGainConflict(clips, gains, mergeMaxDeltaDb = MERGE_MAX_DELTA_DB) {
  const cs   = clips.map(c => ({ ...c }))
  const gs   = Array.from(gains)
  const durs = cs.map(c => c.sampleEnd - c.sampleStart)
  let mergesCount = 0

  let changed = true
  while (changed) {
    changed = false
    for (let k = 0; k < cs.length - 1; k++) {
      if (Math.abs(gs[k + 1] - gs[k]) > mergeMaxDeltaDb) {
        const merged = {
          hopStart:    cs[k].hopStart,
          hopEnd:      cs[k + 1].hopEnd,
          sampleStart: cs[k].sampleStart,
          sampleEnd:   cs[k + 1].sampleEnd,
        }
        const mDur = merged.sampleEnd - merged.sampleStart
        // Sample-duration-weighted average gain (clamping not needed — both
        // inputs were already within caps, average stays within them).
        const mergedGain = (gs[k] * durs[k] + gs[k + 1] * durs[k + 1]) / (durs[k] + durs[k + 1])
        cs.splice(k, 2, merged)
        gs.splice(k, 2, mergedGain)
        durs.splice(k, 2, mDur)
        mergesCount++
        changed = true
        break  // restart scan
      }
    }
  }

  return { clips: cs, gains: gs, mergesCount }
}

// ── Boundary crossfade plan ──────────────────────────────────────────────────

function findLowestEnergyWindow(audioPowerSum, fromSample, toSample, windowSamples, totalSamples) {
  const lo  = Math.max(0, fromSample)
  const hi  = Math.min(totalSamples, toSample)
  const win = Math.max(1, Math.min(windowSamples, hi - lo))
  if (hi - lo <= win) return lo

  const stride = Math.max(1, Math.floor(win / 4))
  let bestStart = lo
  let bestEnergy = Infinity
  for (let s = lo; s + win <= hi; s += stride) {
    const e = meanSquareRange(audioPowerSum, s, s + win)
    if (e < bestEnergy) { bestEnergy = e; bestStart = s }
  }
  return bestStart
}

/**
 * Place a cosine crossfade for each adjacent pair of clips.
 *
 * Gap boundaries get theirs at the quietest window inside the gap, which is
 * where a gain change has the least signal to be heard on. Voiced-adjacent
 * boundaries — a sub-phrase split, where there is no gap at all — straddle the
 * split point, because there is nowhere quieter to go.
 */
export function buildCrossfadePlans(clips, gains, audioPowerSum, crossfadeSamples, totalSamples) {
  const plans = []
  for (let k = 0; k < clips.length - 1; k++) {
    const a = clips[k], b = clips[k + 1]
    const gapStart = a.sampleEnd
    const gapEnd   = b.sampleStart
    let winStart
    if (gapEnd > gapStart) {
      winStart = findLowestEnergyWindow(audioPowerSum, gapStart, gapEnd, crossfadeSamples, totalSamples)
    } else {
      // Voiced-adjacent: straddle the boundary
      winStart = Math.max(0, a.sampleEnd - Math.floor(crossfadeSamples / 2))
    }
    const winEnd = Math.min(totalSamples, winStart + crossfadeSamples)
    plans.push({
      startSample: winStart,
      endSample:   winEnd,
      fromGain:    gains[k],
      toGain:      gains[k + 1],
    })
  }
  return plans
}

// ── Gain curve: segments, and the per-sample expansion of them ───────────────

/**
 * @typedef {{ startSample: number, endSample: number, fromDb: number, toDb: number }} GainSegment
 *   A span of the timeline over which gain is either constant (fromDb === toDb)
 *   or a raised-cosine ramp between the two.
 */

/**
 * The gain curve as a segment list rather than a per-sample array.
 *
 * WHY THIS IS THE CANONICAL FORM HERE AND NOT ON THE SERVER. The server builds
 * a Float32Array of one gain per sample, which is fine when it is about to
 * stream it into a file and drop it. In a browser holding a whole chapter it is
 * 317 MB for thirty minutes of mono at 44.1 kHz — before the AudioBuffer copy
 * that would be needed to schedule it. The segment list is the same curve at
 * the size of the speech structure: a few hundred entries for that chapter.
 *
 * Both consumers derive from this one list, which is what makes preview and
 * apply the same curve by construction rather than by two implementations
 * agreeing: playback schedules the segments onto an AudioParam, and apply
 * expands them with expandGainSegments below.
 *
 * The layout follows the server's buildSampleGainArray exactly, including the
 * post-roll: gain holds at the last clip's value to the end of the region
 * rather than stepping back to 0 dB, so a trailing breath does not jump.
 */
export function buildGainSegments(clips, gains, crossfadePlans, totalSamples) {
  if (clips.length === 0) {
    return [{ startSample: 0, endSample: totalSamples, fromDb: 0, toDb: 0 }]
  }

  // ── Paint operations, in the server's order ────────────────────────────────
  //
  // THE ORDER IS THE ALGORITHM, and getting it wrong is silent. The server
  // fills EVERY clip span first and only then overlays EVERY boundary, so a
  // crossfade window that reaches past a clip edge wins over the flat fill
  // underneath it. Emitting each clip and its following boundary together
  // instead — the obvious reading — lets the *next* clip's fill land on top of
  // the crossfade's second half, which flattens the back half of every
  // voiced-adjacent fade. It shows up as a step at exactly the place the fade
  // existed to smooth, and only on sub-phrase splits, where there is no gap for
  // the fade to hide in.
  const ops = []
  const paint = (start, end, fromDb, toDb) => {
    if (end > start) ops.push({ start, end, fromDb, toDb })
  }

  paint(0, clips[0].sampleStart, 0, 0)                       // pre-roll: 0 dB
  for (let k = 0; k < clips.length; k++) {
    paint(clips[k].sampleStart, clips[k].sampleEnd, gains[k], gains[k])
  }
  const last = clips[clips.length - 1]
  paint(last.sampleEnd, totalSamples, gains[gains.length - 1], gains[gains.length - 1])

  for (let k = 0; k < clips.length - 1; k++) {
    const plan     = crossfadePlans[k]
    const fromGain = gains[k]
    const toGain   = gains[k + 1]
    const gapStart = clips[k].sampleEnd
    const gapEnd   = clips[k + 1].sampleStart

    paint(gapStart, Math.min(plan.startSample, gapEnd), fromGain, fromGain)
    paint(plan.startSample, plan.endSample, fromGain, toGain)
    paint(Math.max(plan.endSample, gapStart), gapEnd, toGain, toGain)
  }

  return overlayOps(ops, totalSamples)
}

/**
 * Flatten overlapping paint operations into a segment list that tiles
 * [0, totalSamples) exactly once, last writer winning.
 *
 * A sweep rather than a stack, because the winner of a span is not generally
 * the operation before it in the list: every crossfade is painted after every
 * clip, so the thing a fade overwrites was emitted long earlier. Cutting the
 * timeline at every operation edge and asking which operation covers each
 * elementary interval gets that right without caring about the list's shape.
 *
 * RAMPS ARE NEVER SPLIT. A cosine is not linear, so a fade emitted as two
 * half-fades with interpolated endpoints is a different curve. It never has to
 * be: crossfade windows cannot overlap each other (clips are >= 200 ms after
 * VAD hysteresis, fades are 30 ms), so any interval a ramp wins, it wins the
 * whole of. Consecutive intervals won by the same operation are regrouped
 * below, which restores a ramp that an unrelated edge — the clip boundary a
 * voiced-adjacent fade straddles — happened to cut in two.
 */
function overlayOps(ops, totalSamples) {
  const edges = new Set([0, totalSamples])
  for (const op of ops) {
    if (op.start > 0 && op.start < totalSamples) edges.add(op.start)
    if (op.end   > 0 && op.end   < totalSamples) edges.add(op.end)
  }
  const cuts = Array.from(edges).sort((a, b) => a - b)

  // Winner per elementary interval: the last operation that covers it.
  const winners = new Array(cuts.length - 1).fill(null)
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1]
    for (let j = ops.length - 1; j >= 0; j--) {
      if (ops[j].start <= a && ops[j].end >= b) { winners[i] = ops[j]; break }
    }
  }

  /** @type {GainSegment[]} */
  const segments = []
  let i = 0
  while (i < cuts.length - 1) {
    const op = winners[i]
    let j = i
    while (j + 1 < cuts.length - 1 && winners[j + 1] === op) j++

    const start = cuts[i]
    const end   = cuts[j + 1]

    if (!op) {
      // Uncovered — only reachable if the ops leave a hole, which the pre-roll
      // and post-roll rule out. Hold the level either side rather than dropping
      // to unity mid-file.
      const fill = segments.length ? segments[segments.length - 1].toDb : 0
      segments.push({ startSample: start, endSample: end, fromDb: fill, toDb: fill })
    } else if (op.fromDb === op.toDb) {
      const prev = segments[segments.length - 1]
      if (prev && prev.endSample === start && prev.fromDb === prev.toDb && prev.toDb === op.fromDb) {
        prev.endSample = end   // coalesce abutting holds at the same level
      } else {
        segments.push({ startSample: start, endSample: end, fromDb: op.fromDb, toDb: op.toDb })
      }
    } else {
      segments.push({ startSample: op.start, endSample: op.end, fromDb: op.fromDb, toDb: op.toDb })
    }

    i = j + 1
  }

  return segments
}

/** The raised-cosine weight used by every ramp segment. 0 at t=0, 1 at t=1. */
export function crossfadeWeight(t) {
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}

/**
 * Expand segments to one gain in dB per sample — the server's gainSr.
 *
 * Only the apply path calls this, over the region being written. Preview never
 * does; see buildGainSegments for why.
 */
export function expandGainSegments(segments, totalSamples) {
  const g = new Float32Array(totalSamples)
  for (const seg of segments) {
    const start = Math.max(0, seg.startSample)
    const end   = Math.min(totalSamples, seg.endSample)
    if (end <= start) continue
    if (seg.fromDb === seg.toDb) {
      g.fill(seg.fromDb, start, end)
      continue
    }
    const len = seg.endSample - seg.startSample
    for (let i = start; i < end; i++) {
      const w = crossfadeWeight((i - seg.startSample) / len)
      g[i] = seg.fromDb * (1 - w) + seg.toDb * w
    }
  }
  return g
}

/** Gain in dB at one sample position — for the meter, which needs one value. */
export function gainDbAtSample(segments, sample) {
  // Segments tile the region in order, so a binary search is exact.
  let lo = 0, hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const seg = segments[mid]
    if (sample < seg.startSample) hi = mid - 1
    else if (sample >= seg.endSample) lo = mid + 1
    else {
      if (seg.fromDb === seg.toDb) return seg.fromDb
      const w = crossfadeWeight((sample - seg.startSample) / (seg.endSample - seg.startSample))
      return seg.fromDb * (1 - w) + seg.toDb * w
    }
  }
  return 0
}

// ── Phase 1: prepare (audio + VAD dependent, runs once) ──────────────────────

/**
 * @typedef {Object} PreparedAutoLevel
 * @property {boolean} applicable
 * @property {string|null} reason        - why not, when applicable is false
 * @property {Clip[]} clips
 * @property {number[]} clipLufs
 * @property {number[]} clipDurations
 * @property {number[]} sampleStarts
 * @property {number} inClipStd          - duration-weighted std of clip LUFS
 * @property {number} subphraseSplits
 * @property {number} sampleRate
 * @property {number} totalSamples
 * @property {number} noiseFloorDbfs
 * @property {Float64Array} audioPowerSum
 */

/**
 * Everything derived from the audio and the mask, before any control is read.
 *
 * The skip conditions are the server's and they are about honesty rather than
 * cost: under ten seconds, or under five seconds of speech, there are not
 * enough phrases for a median to mean anything, and a leveler fitted to two
 * clips is just a random gain change.
 *
 * @param {Object} input
 * @param {Float32Array} input.audio        mono
 * @param {number} input.sampleRate
 * @param {Uint8Array} input.frameVoiced    raw per-frame mask (pre-hysteresis)
 * @param {number} input.frameDurationS
 * @param {number} input.noiseFloorDbfs
 * @returns {PreparedAutoLevel}
 */
export function prepareAutoLevel({ audio, sampleRate, frameVoiced, frameDurationS, noiseFloorDbfs }) {
  const n = audio.length
  const fail = reason => ({ applicable: false, reason, clips: [], sampleRate, totalSamples: n })

  if (n / sampleRate < MIN_FILE_DURATION_S) return fail('duration_too_short')

  const hopSamples = Math.round(HOP_MS * 0.001 * sampleRate)
  const numHops    = Math.floor(n / hopSamples)
  if (numHops === 0) return fail('duration_too_short')

  const conditioned = conditionVoicedMask(frameVoiced, frameDurationS)
  const hopVoiced   = frameVoicedToHopVoiced(conditioned, frameDurationS, numHops)

  let voicedHops = 0
  for (let h = 0; h < numHops; h++) voicedHops += hopVoiced[h]
  if (voicedHops * HOP_MS * 0.001 < MIN_VOICED_DURATION_S) {
    return fail('insufficient_voiced_audio')
  }

  // K-weight once; reuse for L_st (sub-phrase splitting) and per-clip LUFS.
  const kwSamples     = applyKWeighting(audio, sampleRate)
  const kwPowerSum    = buildPowerSum(kwSamples)
  const audioPowerSum = buildPowerSum(audio)

  const windowSt = Math.round(ST_WINDOW_MS * 0.001 * sampleRate)
  const L_st     = computeLufsCurve(kwPowerSum, hopVoiced, windowSt, hopSamples, n)

  const { clips, subphraseSplits } = detectClips({
    hopVoiced, L_st, hopSamples, totalSamples: n,
  })

  if (clips.length < 2) return fail('insufficient_clips')

  const clipLufs      = clips.map(c => computeClipLufs(kwPowerSum, c))
  const clipDurations = clips.map(c => c.sampleEnd - c.sampleStart)
  const sampleStarts  = clips.map(c => c.sampleStart)
  const inClipStd     = weightedStd(clipLufs, clipDurations)

  return {
    applicable: true,
    reason: null,
    clips,
    clipLufs,
    clipDurations,
    sampleStarts,
    inClipStd,
    subphraseSplits,
    sampleRate,
    totalSamples: n,
    noiseFloorDbfs: Number.isFinite(noiseFloorDbfs) ? noiseFloorDbfs : -60,
    audioPowerSum,
  }
}

// ── Phase 2: solve (config dependent, runs on every knob move) ───────────────

/**
 * @typedef {Object} SolvedAutoLevel
 * @property {boolean} applied
 * @property {string|null} reason
 * @property {GainSegment[]} segments
 * @property {Clip[]} clips              - post-merge
 * @property {number[]} gains            - post-merge, dB
 * @property {Object} measurements
 */

/**
 * Turn the prepared analysis into a gain curve under the current settings.
 *
 * O(clips) apart from the crossfade search, which touches only the gaps. No
 * audio is re-read and nothing is re-filtered, which is what makes the controls
 * feel live on a chapter-length selection.
 */
export function solveAutoLevel(prepared, config = AUTOLEVEL_DEFAULTS) {
  if (!prepared?.applicable) {
    return {
      applied: false,
      reason: prepared?.reason ?? 'not_analyzed',
      segments: [],
      clips: [],
      gains: [],
      measurements: null,
    }
  }

  const {
    clips, clipLufs, clipDurations, sampleStarts, inClipStd,
    subphraseSplits, sampleRate, totalSamples, noiseFloorDbfs, audioPowerSum,
  } = prepared

  // Already level: every clip would land inside the deadband, so the whole
  // stage is a no-op. Tying this to the deadband rather than a constant keeps
  // the file-level and per-clip no-op conditions the same condition.
  if (inClipStd < config.deadband_db) {
    return {
      applied: false,
      reason: 'file_already_leveled',
      segments: [],
      clips: [],
      gains: [],
      measurements: { input_clip_lufs_std_db: inClipStd, clip_count_initial: clips.length },
    }
  }

  // Noise-floor headroom cap. Lifting a quiet clip lifts its room tone with it,
  // so the boost available is whatever distance the floor has left before it
  // reaches the target, less 3 dB of margin.
  const nfHeadroom  = Math.max(0, (config.noise_floor_target_dbfs - noiseFloorDbfs) - 3)
  const maxUpEff    = Math.min(config.max_up_db, nfHeadroom)
  const nfCapActive = maxUpEff < config.max_up_db

  const targets = computeClipTargets(
    clipLufs, clipDurations, sampleStarts,
    config.target_window_s, sampleRate, config.target_mode,
  )

  const gains = clipLufs.map((lufs, k) => shapeDrift(
    targets[k] - lufs,
    config.deadband_db,
    config.knee_db,
    maxUpEff,
    config.max_down_db,
  ))

  const merged = mergeClipsForGainConflict(clips, gains)

  const crossfadeSamples = Math.max(1, Math.round(CROSSFADE_MS * 0.001 * sampleRate))
  const plans = buildCrossfadePlans(
    merged.clips, merged.gains, audioPowerSum, crossfadeSamples, totalSamples,
  )

  const segments = buildGainSegments(merged.clips, merged.gains, plans, totalSamples)

  // Gain stats over merged clips, duration-weighted — the same numbers the
  // server reports, so a levelled selection can be compared with a mastered one.
  let maxUp = -Infinity, maxDown = Infinity
  let powSum = 0, dSum = 0
  for (let k = 0; k < merged.gains.length; k++) {
    const g = merged.gains[k]
    if (g > maxUp)   maxUp   = g
    if (g < maxDown) maxDown = g
    const lin = Math.pow(10, g / 20.0)
    const d   = merged.clips[k].sampleEnd - merged.clips[k].sampleStart
    powSum += lin * lin * d
    dSum   += d
  }
  const gainRmsDb = dSum > 0 ? 20 * Math.log10(Math.sqrt(powSum / dSum)) : 0

  // Predicted output spread. The gain is flat within a clip, so a clip's output
  // LUFS is its input LUFS plus its gain exactly — no need to re-measure the
  // processed audio the way the server does after rendering it.
  const outLufs = merged.clips.map(
    (c, k) => clipLufsForMerged(clipLufs, clips, c) + merged.gains[k],
  )
  const outDurs = merged.clips.map(c => c.sampleEnd - c.sampleStart)
  const outClipStd = weightedStd(outLufs, outDurs)

  return {
    applied: true,
    reason: null,
    segments,
    clips: merged.clips,
    gains: merged.gains,
    measurements: {
      input_clip_lufs_std_db:  inClipStd,
      output_clip_lufs_std_db: outClipStd,
      clip_count_initial:      clips.length,
      clip_count_after_merge:  merged.clips.length,
      subphrase_splits_count:  subphraseSplits,
      merges_count:            merged.mergesCount,
      gain_max_up_db:          maxUp   === -Infinity ? 0 : maxUp,
      gain_max_down_db:        maxDown ===  Infinity ? 0 : maxDown,
      gain_rms_db:             gainRmsDb,
      noise_floor_cap_active:  nfCapActive,
      max_up_effective_db:     maxUpEff,
    },
  }
}

/**
 * Energy-weighted LUFS of a merged clip, from the pre-merge measurements.
 *
 * A merge concatenates two spans, and LUFS is a log of a mean square, so the
 * combined value is the duration-weighted mean of the two *powers* — averaging
 * the dB values instead would be wrong by up to 3 dB on an uneven pair.
 */
function clipLufsForMerged(clipLufs, originalClips, mergedClip) {
  let powSum = 0, dSum = 0
  for (let i = 0; i < originalClips.length; i++) {
    const c = originalClips[i]
    if (c.sampleStart >= mergedClip.sampleStart && c.sampleEnd <= mergedClip.sampleEnd) {
      const d = c.sampleEnd - c.sampleStart
      powSum += Math.pow(10, (clipLufs[i] + 0.691) / 10) * d
      dSum   += d
    }
  }
  if (dSum === 0) return -120
  return -0.691 + 10 * Math.log10(powSum / dSum)
}

/**
 * Multiply a window of the curve into a region's channels.
 *
 * WALKS THE SEGMENTS RATHER THAN EXPANDING THEM. Calling expandGainSegments
 * first would be shorter, and would also allocate a second full-length
 * Float32Array beside the rendered audio — on the chapter-length selections
 * this plugin is for, that is another 317 MB per thirty minutes at the exact
 * moment memory is already at its peak. Walking costs one branch per segment
 * instead, and there are a few hundred of them.
 *
 * expandGainSegments stays as the reference expansion: it is what the parity
 * suite checks against the server, and autoLevelApply.test.js checks this
 * against it, so the lean path is pinned to the verified one.
 *
 * @param {Float32Array[]} channels    rendered region, `numSamples` long
 * @param {GainSegment[]} segments     curve over the ANALYSED region
 * @param {number} numSamples
 * @param {number} offsetSamples       where this region starts within the
 *                                     analysed one — non-zero when the user
 *                                     analysed a span and applies part of it
 */
export function applyGainSegments(channels, segments, numSamples, offsetSamples = 0) {
  // Start from a copy rather than zeros. The segments tile the analysed region,
  // but a caller can hand over a window reaching past it — and an uncovered
  // sample must be untouched audio, not silence. Zero-filling makes that
  // failure inaudible in testing and catastrophic in use.
  const out = channels.map((ch) => {
    const dst = new Float32Array(numSamples)
    dst.set(ch.subarray(0, Math.min(numSamples, ch.length)))
    return dst
  })

  for (const seg of segments) {
    // Intersect the segment with the window, in window coordinates.
    const from = Math.max(0, seg.startSample - offsetSamples)
    const to   = Math.min(numSamples, seg.endSample - offsetSamples)
    if (to <= from) continue

    if (seg.fromDb === seg.toDb) {
      const lin = Math.pow(10, seg.fromDb / 20.0)
      for (let c = 0; c < channels.length; c++) {
        const src = channels[c], dst = out[c]
        for (let i = from; i < to; i++) dst[i] = src[i] * lin
      }
      continue
    }

    const len = seg.endSample - seg.startSample
    for (let i = from; i < to; i++) {
      // Phase is measured against the segment's own start, so a fade clipped by
      // the window keeps the shape it would have had uncut.
      const w  = crossfadeWeight((i + offsetSamples - seg.startSample) / len)
      const db = seg.fromDb * (1 - w) + seg.toDb * w
      const lin = Math.pow(10, db / 20.0)
      for (let c = 0; c < channels.length; c++) out[c][i] = channels[c][i] * lin
    }
  }

  return out
}
