/**
 * Auto Leveler — Stage 4b, M Leveller-style clip-automation.
 *
 * Repositioned pre-compression. The leveler segments voiced audio into clips,
 * applies a single flat gain offset per clip, and crossfades between clips at
 * low-energy boundaries. There is no continuous IIR smoothing of a sample-rate
 * gain curve — gain is piecewise constant within each clip, so the dynamics
 * inside a clip are preserved exactly.
 *
 *   Segmentation:  VAD voiced runs, plus sub-phrase splits at sustained
 *                  internal level drops (>= subphrase_split_drop_db for
 *                  >= subphrase_split_min_duration_ms within a run).
 *   Per-clip gain: shapeDrift(target - clipLufs) with deadband + cubic knee,
 *                  capped by per-preset max_up/down and noise-floor headroom.
 *   Boundaries:    short cosine crossfade (crossfade_ms) at the lowest-energy
 *                  point near each boundary. Adjacent clips with too-large gain
 *                  delta are merged into one clip with a duration-weighted
 *                  average gain (transparent fallback).
 *
 * Chain position: immediately before the Compression stage. Hands the
 * compressor a level-stable input so it can act with a consistent character.
 * Input: frameAnalysis from analyzeFramesRaw / remeasureFramesPostNr.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'
import { PRESETS }            from '../presets.js'

const HOP_MS       = 100
const FRAME_MS     = 25   // Silero VAD frame duration (matches frameAnalysis.js FRAME_DURATION_S * 1000)

// VAD hysteresis parameters
const VAD_MIN_VOICED_MS   = 200
const VAD_MIN_UNVOICED_MS = 300

// Skip condition thresholds
const MIN_FILE_DURATION_S   = 10
const MIN_VOICED_DURATION_S = 5
const LEVELED_STD_THRESHOLD = 1.5   // dB — duration-weighted std of clip LUFS

// Sub-phrase splitting recursion guard — never split a sub-clip shorter than
// twice the minimum drop duration (otherwise the split point can't itself
// satisfy the duration check).
const MIN_SUBCLIP_HOPS_FACTOR = 2

// ─── K-weighting filter (EBU R128 / ITU-R BS.1770-4) ─────────────────────────

function computeKWeightingCoefficients(sampleRate) {
  // Stage 1: high-shelf pre-filter
  const K1  = Math.tan(Math.PI * 1681.974450955533 / sampleRate)
  const Vh  = Math.pow(10.0, 3.999843853973347 / 20.0)
  const Vb  = Math.pow(Vh, 0.4996667741545416)
  const Q1  = 0.7071752369554196
  const a0s = 1.0 + K1 / Q1 + K1 * K1
  const s1  = {
    b: [
      (Vh + Vb * K1 / Q1 + K1 * K1) / a0s,
      2.0 * (K1 * K1 - Vh) / a0s,
      (Vh - Vb * K1 / Q1 + K1 * K1) / a0s,
    ],
    a: [
      1.0,
      2.0 * (K1 * K1 - 1.0) / a0s,
      (1.0 - K1 / Q1 + K1 * K1) / a0s,
    ],
  }

  // Stage 2: high-pass filter at 38.135 Hz
  const K2  = Math.tan(Math.PI * 38.13547087602444 / sampleRate)
  const Q2  = 0.5003270373238773
  const a0h = 1.0 + K2 / Q2 + K2 * K2
  const s2  = {
    b: [1.0 / a0h, -2.0 / a0h, 1.0 / a0h],
    a: [1.0, 2.0 * (K2 * K2 - 1.0) / a0h, (1.0 - K2 / Q2 + K2 * K2) / a0h],
  }

  return { stage1: s1, stage2: s2 }
}

function applyBiquad(samples, b, a) {
  const n = samples.length
  const out = new Float64Array(n)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < n; i++) {
    const x0 = samples[i]
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
    out[i] = y0
    x2 = x1; x1 = x0
    y2 = y1; y1 = y0
  }
  return out
}

function applyKWeighting(samples, sampleRate) {
  const { stage1, stage2 } = computeKWeightingCoefficients(sampleRate)
  return applyBiquad(applyBiquad(samples, stage1.b, stage1.a), stage2.b, stage2.a)
}

// ─── LUFS sliding-window curve (voiced hops only) ─────────────────────────────

function computeLufsCurve(kwSamples, hopVoiced, windowSamples, hopSamples) {
  const n       = kwSamples.length
  const numHops = hopVoiced.length

  // Running power sum for O(1) window queries
  const powerSum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    powerSum[i + 1] = powerSum[i] + kwSamples[i] * kwSamples[i]
  }

  const halfWin = Math.floor(windowSamples / 2)
  const curve   = new Float64Array(numHops)

  for (let h = 0; h < numHops; h++) {
    if (!hopVoiced[h]) {
      curve[h] = NaN
      continue
    }
    const center = h * hopSamples + Math.floor(hopSamples / 2)
    const start  = Math.max(0, center - halfWin)
    const end    = Math.min(n, center + halfWin)
    if (end <= start) { curve[h] = NaN; continue }
    const meanSq = (powerSum[end] - powerSum[start]) / (end - start)
    curve[h] = meanSq > 0 ? -0.691 + 10.0 * Math.log10(meanSq) : NaN
  }

  return curve
}

// ─── VAD conditioning with hysteresis ─────────────────────────────────────────

function applyVadHysteresis(frames, sampleRate) {
  if (!frames || frames.length === 0) return new Uint8Array(0)

  const frameSamples  = frames[0].lengthSamples ?? Math.round(FRAME_MS * 0.001 * sampleRate)
  const frameMs       = (frameSamples / sampleRate) * 1000
  const minVoicedF    = Math.max(1, Math.round(VAD_MIN_VOICED_MS   / frameMs))
  const minUnvoicedF  = Math.max(1, Math.round(VAD_MIN_UNVOICED_MS / frameMs))
  const n             = frames.length

  // Convert binary isSilence flags to raw voiced array
  const raw = new Uint8Array(n)
  for (let f = 0; f < n; f++) raw[f] = (!frames[f].isSilence) ? 1 : 0

  const voiced = new Uint8Array(raw)

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

// Expand per-frame voiced mask to per-hop (any voiced frame in hop → voiced hop)
function frameVoicedToHopVoiced(framedVoiced, framesPerHop, numHops) {
  const hopVoiced = new Uint8Array(numHops)
  for (let h = 0; h < numHops; h++) {
    const f0 = h * framesPerHop
    for (let k = 0; k < framesPerHop; k++) {
      if (f0 + k < framedVoiced.length && framedVoiced[f0 + k]) {
        hopVoiced[h] = 1
        break
      }
    }
  }
  return hopVoiced
}

// ─── Drift correction with deadband + cubic knee ──────────────────────────────

function shapeDrift(delta, deadband, knee, maxUp, maxDown) {
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

// ─── Power-sum prefix array (for O(1) energy-in-range queries) ────────────────

function buildPowerSum(samples) {
  const n = samples.length
  const ps = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + samples[i] * samples[i]
  return ps
}

function meanSquareRange(powerSum, start, end) {
  if (end <= start) return 0
  return (powerSum[end] - powerSum[start]) / (end - start)
}

// ─── Clip detection (VAD voiced runs + sub-phrase splits) ─────────────────────

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
 * Recursive sub-phrase splitter. Splits a clip at the deepest hop within any
 * internal drop region where L_st falls ≥ splitDropDb below the clip's median
 * for ≥ splitMinDurationHops contiguous hops.
 *
 * @returns {Clip[]} one or more sub-clips (sample fields set from hop fields)
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

function detectClips({ hopVoiced, L_st, hopSamples, totalSamples, splitDropDb, splitMinDurationMs }) {
  const splitMinDurationHops = Math.max(1, Math.round(splitMinDurationMs / HOP_MS))
  const baseClips = vadRunsToClips(hopVoiced, hopSamples, totalSamples)
  const out = []
  let totalSplits = 0
  for (const clip of baseClips) {
    const sub = splitClipBySubphrase(clip, L_st, hopSamples, totalSamples, splitDropDb, splitMinDurationHops)
    totalSplits += sub.length - 1
    out.push(...sub)
  }
  return { clips: out, subphraseSplits: totalSplits }
}

// ─── Per-clip K-weighted LUFS ─────────────────────────────────────────────────

function computeClipLufs(kwPowerSum, clip) {
  const meanSq = meanSquareRange(kwPowerSum, clip.sampleStart, clip.sampleEnd)
  return meanSq > 0 ? -0.691 + 10.0 * Math.log10(meanSq) : -120.0
}

// ─── Weighted statistics ──────────────────────────────────────────────────────

function weightedMedian(values, weights) {
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

function weightedStd(values, weights) {
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

// ─── Per-clip targets ─────────────────────────────────────────────────────────

function computeClipTargets(clipLufs, clipDurations, sampleStarts, targetWindowS, sampleRate, mode) {
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

// ─── Lowest-energy window search (for crossfade placement in gaps) ────────────

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

// ─── Merge adjacent clips whose gain delta exceeds threshold ──────────────────

function mergeClipsForGainConflict(clips, gains, mergeMaxDeltaDb) {
  // Work on copies; iterate until stable.
  let cs = clips.map(c => ({ ...c }))
  let gs = Array.from(gains)
  let durs = cs.map(c => c.sampleEnd - c.sampleStart)
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

// ─── Boundary crossfade plan ──────────────────────────────────────────────────

/**
 * For each pair of adjacent clips, place a cosine crossfade window:
 *   - Gap boundary: place inside the gap, at its lowest-energy crossfade-length window.
 *   - Voiced-adjacent boundary (no gap): straddle the boundary sample.
 *
 * Plan entry: { startSample, endSample, fromGain, toGain }
 */
function buildCrossfadePlans(clips, gains, audioPowerSum, crossfadeSamples, totalSamples) {
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

// ─── Build sample-rate gain array ─────────────────────────────────────────────

function buildSampleGainArray(clips, gains, crossfadePlans, totalSamples) {
  const g = new Float32Array(totalSamples)

  if (clips.length === 0) return g  // 0 dB everywhere

  // Pre-roll before first clip is 0 dB.
  for (let i = 0; i < clips[0].sampleStart; i++) g[i] = 0

  // Voiced regions: each clip's own gain (clip's own [sampleStart, sampleEnd)).
  for (let k = 0; k < clips.length; k++) {
    const v = gains[k]
    for (let i = clips[k].sampleStart; i < clips[k].sampleEnd; i++) g[i] = v
  }

  // Boundaries: for each adjacent clip pair, fill the gap with a single
  // from→to transition. Pre-crossfade samples take fromGain, crossfade samples
  // blend, post-crossfade samples take toGain. The crossfade window may extend
  // beyond the gap into voiced regions (voiced-adjacent boundaries or short
  // gaps); the overlay correctly overwrites the voiced fill in that range.
  for (let k = 0; k < clips.length - 1; k++) {
    const plan = crossfadePlans[k]
    const fromGain = gains[k]
    const toGain   = gains[k + 1]
    const gapStart = clips[k].sampleEnd
    const gapEnd   = clips[k + 1].sampleStart
    const xfStart  = plan.startSample
    const xfEnd    = plan.endSample

    for (let i = gapStart; i < xfStart && i < gapEnd; i++) g[i] = fromGain

    const len = xfEnd - xfStart
    if (len > 0) {
      for (let i = xfStart; i < xfEnd; i++) {
        const t = (i - xfStart) / len
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t)   // 0 at start, 1 at end
        g[i] = fromGain * (1 - w) + toGain * w
      }
    }

    for (let i = Math.max(xfEnd, gapStart); i < gapEnd; i++) g[i] = toGain
  }

  // Post-roll: hold the last clip's gain to the end of the file so we don't
  // step to 0 dB after the final clip.
  const lastEnd = clips[clips.length - 1].sampleEnd
  const lastGain = gains[clips.length - 1]
  for (let i = lastEnd; i < totalSamples; i++) g[i] = lastGain

  return g
}

// ─── Apply gain array to channels ─────────────────────────────────────────────

function applySampleGains(channels, gainDb) {
  const n = gainDb.length
  return channels.map(ch => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      out[i] = ch[i] * Math.pow(10, gainDb[i] / 20.0)
    }
    return out
  })
}

// ─── Output measurement: per-clip LUFS std after leveling ─────────────────────

function computeClipStd(clips, kwSamples) {
  if (clips.length === 0) return 0
  const ps = buildPowerSum(kwSamples)
  const lufs = clips.map(c => computeClipLufs(ps, c))
  const durs = clips.map(c => c.sampleEnd - c.sampleStart)
  return weightedStd(lufs, durs)
}

// ─── Preset config lookup ─────────────────────────────────────────────────────

function getAutoLevelerConfig(presetId) {
  return PRESETS[presetId]?.autoLeveler ?? null
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Apply M Leveller-style clip-automation to an audio file.
 *
 * @param {string} inputPath   - 32-bit float WAV
 * @param {string} outputPath  - Output WAV path
 * @param {string} presetId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {AutoLevelerResult}
 */
export async function applyAutoLeveler(inputPath, outputPath, presetId, frameAnalysis) {
  if (presetId === 'noise_eraser') {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'preset_excluded' }
  }

  const config = getAutoLevelerConfig(presetId)
  if (!config) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'preset_excluded' }
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const audio = channels[0]
  const n     = audio.length

  const durationS = n / sampleRate
  if (durationS < MIN_FILE_DURATION_S) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'duration_too_short' }
  }

  // VAD conditioning + per-hop voiced mask
  const framedVoiced = applyVadHysteresis(frameAnalysis?.frames ?? [], sampleRate)
  const hopSamples   = Math.round(HOP_MS * 0.001 * sampleRate)
  const numHops      = Math.floor(n / hopSamples)

  const frameSamples = frameAnalysis?.frames?.[0]?.lengthSamples
    ?? Math.round(FRAME_MS * 0.001 * sampleRate)
  const framesPerHop = Math.max(1, Math.round(hopSamples / frameSamples))
  const hopVoiced    = frameVoicedToHopVoiced(framedVoiced, framesPerHop, numHops)

  const voicedHops = hopVoiced.reduce((s, v) => s + v, 0)
  if (voicedHops * HOP_MS * 0.001 < MIN_VOICED_DURATION_S) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'insufficient_voiced_audio' }
  }

  // K-weight once; reuse for L_st (sub-phrase splitting) and per-clip LUFS
  const kwSamples   = applyKWeighting(audio, sampleRate)
  const kwPowerSum  = buildPowerSum(kwSamples)
  const audioPowerSum = buildPowerSum(audio)

  const windowSt = Math.round(400 * 0.001 * sampleRate)
  const L_st     = computeLufsCurve(kwSamples, hopVoiced, windowSt, hopSamples)

  // Segmentation: VAD voiced runs + sub-phrase splits at internal drops
  const { clips, subphraseSplits } = detectClips({
    hopVoiced,
    L_st,
    hopSamples,
    totalSamples:        n,
    splitDropDb:         config.subphrase_split_drop_db,
    splitMinDurationMs:  config.subphrase_split_min_duration_ms,
  })

  if (clips.length < 2) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'insufficient_clips' }
  }

  // Per-clip LUFS and durations
  const clipLufs       = clips.map(c => computeClipLufs(kwPowerSum, c))
  const clipDurations  = clips.map(c => c.sampleEnd - c.sampleStart)
  const sampleStarts   = clips.map(c => c.sampleStart)

  // Skip if file is already leveled (clip-LUFS std below threshold)
  const inClipStd = weightedStd(clipLufs, clipDurations)
  if (inClipStd < LEVELED_STD_THRESHOLD) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'file_already_leveled' }
  }

  // Noise-floor headroom cap (single-stage)
  const noiseFloorDbfs = frameAnalysis?.noiseFloorDbfs ?? -60
  const nfHeadroom     = Math.max(0, (config.noise_floor_target_dbfs - noiseFloorDbfs) - 3)
  const maxUpEff       = Math.min(config.max_up_db, nfHeadroom)
  const nfCapActive    = maxUpEff < config.max_up_db

  // Per-clip targets (running_median or global)
  const targets = computeClipTargets(
    clipLufs,
    clipDurations,
    sampleStarts,
    config.target_window_s,
    sampleRate,
    config.target_mode,
  )

  // Per-clip gains
  const totalUp   = config.total_max_up_db
  const totalDown = config.total_max_down_db
  const gains = clipLufs.map((lufs, k) => {
    const g = shapeDrift(
      targets[k] - lufs,
      config.deadband_db,
      config.knee_db,
      maxUpEff,
      config.max_down_db,
    )
    return Math.max(-totalDown, Math.min(totalUp, g))
  })

  // Merge adjacent clips with too-large gain delta (transparent fallback)
  const merged = mergeClipsForGainConflict(clips, gains, config.merge_max_delta_db)

  // Boundary crossfade plans (placed at lowest-energy point in each gap or
  // straddling voiced-adjacent boundaries)
  const crossfadeSamples = Math.max(1, Math.round(config.crossfade_ms * 0.001 * sampleRate))
  const plans = buildCrossfadePlans(
    merged.clips, merged.gains, audioPowerSum, crossfadeSamples, n,
  )

  // Render: piecewise-constant gain with cosine crossfades at boundaries
  const gainSr = buildSampleGainArray(merged.clips, merged.gains, plans, n)
  const processedChannels = applySampleGains(channels, gainSr)

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // Output measurements: clip-LUFS std after leveling (recompute on output)
  const kwOut    = applyKWeighting(processedChannels[0], sampleRate)
  const outClipStd = computeClipStd(merged.clips, kwOut)

  // Gain stats over merged clips, duration-weighted
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

  return {
    applied:        true,
    skipped_reason: null,
    preset_params: {
      total_max_up_db:                   totalUp,
      total_max_down_db:                 totalDown,
      target_mode:                       config.target_mode,
      target_window_s:                   config.target_window_s,
      noise_floor_target_dbfs:           config.noise_floor_target_dbfs,
      deadband_db:                       config.deadband_db,
      knee_db:                           config.knee_db,
      max_up_db:                         config.max_up_db,
      max_down_db:                       config.max_down_db,
      subphrase_split_drop_db:           config.subphrase_split_drop_db,
      subphrase_split_min_duration_ms:   config.subphrase_split_min_duration_ms,
      crossfade_ms:                      config.crossfade_ms,
      merge_max_delta_db:                config.merge_max_delta_db,
    },
    measurements: {
      input_clip_lufs_std_db:    round2(inClipStd),
      output_clip_lufs_std_db:   round2(outClipStd),
      clip_count_initial:        clips.length,
      clip_count_after_merge:    merged.clips.length,
      subphrase_splits_count:    subphraseSplits,
      merges_count:              merged.mergesCount,
      gain_max_up_db:            round2(maxUp   === -Infinity ? 0 : maxUp),
      gain_max_down_db:          round2(maxDown ===  Infinity ? 0 : maxDown),
      gain_rms_db:               round2(gainRmsDb),
      total_max_gain_up_db:      round2(maxUp   === -Infinity ? 0 : maxUp),
      total_max_gain_down_db:    round2(maxDown ===  Infinity ? 0 : maxDown),
      noise_floor_cap_active:    nfCapActive,
    },
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function round2(n) {
  return typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
