/**
 * Auto Leveler — Stage 4b, dual-loop gain riding architecture.
 *
 * Two parallel control loops share a slow loudness target derived from a
 * moving median of short-term (400 ms) K-weighted LUFS. Their gain contributions
 * sum at sample rate, then clip to a per-preset total cap.
 *
 *   Loop A (drift):   slow 1:1 correction with deadband + cubic-knee transition
 *   Loop B (perf):    asymmetric ratio compression for larger excursions
 *
 * Both loops use one-pole IIR envelope followers and do NOT reset at unvoiced
 * boundaries — the target is held flat through silence, so the gain curve
 * continues smoothly without VAD-boundary pops.
 *
 * Chain position: immediately before the Compression stage.
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
const MIN_FILE_DURATION_S   = 20
const MIN_VOICED_DURATION_S = 15
const LEVELED_STD_THRESHOLD = 1.5   // dB — both std_st and std_mt below this → skip

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

// ─── Fill NaN (unvoiced hops) with last valid value ───────────────────────────

function fillUnvoiced(curve, fallback = -23.0) {
  const filled = new Float64Array(curve)
  let last = fallback
  for (let h = 0; h < filled.length; h++) {
    if (!Number.isNaN(filled[h])) {
      last = filled[h]
    } else {
      filled[h] = last
    }
  }
  return filled
}

// ─── Moving median of L_st over voiced hops only ─────────────────────────────

function movingMedianVoiced(L_st, hopVoiced, windowHops, minDataHops = 10) {
  const numHops = L_st.length
  const target  = new Float64Array(numHops)
  let   lastTarget = NaN

  for (let h = 0; h < numHops; h++) {
    const winStart = Math.max(0, h - windowHops + 1)
    const buf = []
    for (let k = winStart; k <= h; k++) {
      if (hopVoiced[k] && !Number.isNaN(L_st[k])) buf.push(L_st[k])
    }
    if (buf.length >= minDataHops) {
      buf.sort((a, b) => a - b)
      const mid = Math.floor(buf.length / 2)
      lastTarget = buf.length % 2 === 0
        ? (buf[mid - 1] + buf[mid]) / 2
        : buf[mid]
    }
    target[h] = Number.isNaN(lastTarget) ? -23.0 : lastTarget
  }

  return target
}

// ─── Loop A: drift correction with deadband + cubic knee ──────────────────────

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

// ─── Loop B: asymmetric ratio compression ─────────────────────────────────────

function shapeCompression(delta, deadbandUp, deadbandDown, ratioUp, ratioDown, maxUp, maxDown) {
  if (delta > 0) {
    if (delta < deadbandUp) return 0
    return Math.min((delta - deadbandUp) / ratioUp, maxUp)
  } else {
    const abs_d = -delta
    if (abs_d < deadbandDown) return 0
    return Math.max(-((abs_d - deadbandDown) / ratioDown), -maxDown)
  }
}

// ─── Interpolate hop-rate values to sample rate ───────────────────────────────

function linearInterpolateToSamples(hopValues, hopSamples, totalSamples) {
  const numHops = hopValues.length
  const out     = new Float32Array(totalSamples)
  for (let h = 0; h < numHops; h++) {
    const start = h * hopSamples
    const end   = Math.min(start + hopSamples, totalSamples)
    const v0    = hopValues[h]
    const v1    = h + 1 < numHops ? hopValues[h + 1] : hopValues[h]
    for (let i = start; i < end; i++) {
      out[i] = v0 + ((i - start) / hopSamples) * (v1 - v0)
    }
  }
  // Fill any trailing samples beyond the last full hop with the last hop value
  // (avoids an unintended 0 dB discontinuity at the end of the file)
  const tailStart = numHops * hopSamples
  if (numHops > 0 && tailStart < totalSamples) {
    const lastVal = hopValues[numHops - 1]
    for (let i = tailStart; i < totalSamples; i++) out[i] = lastVal
  }
  return out
}

// ─── One-pole IIR envelope follower ──────────────────────────────────────────

function envelopeFollow(target, attackMs, releaseMs, sampleRate) {
  const alpha_a = 1.0 - Math.exp(-1.0 / (attackMs  * 0.001 * sampleRate))
  const alpha_r = 1.0 - Math.exp(-1.0 / (releaseMs * 0.001 * sampleRate))
  const n       = target.length
  const out     = new Float32Array(n)
  let   prev    = 0.0
  for (let i = 0; i < n; i++) {
    prev   += (target[i] > prev ? alpha_a : alpha_r) * (target[i] - prev)
    out[i]  = prev
  }
  return out
}

// ─── Statistics helpers ───────────────────────────────────────────────────────

function computeStdVoiced(curve, hopVoiced) {
  const vals = []
  for (let h = 0; h < curve.length; h++) {
    if (hopVoiced[h] && !Number.isNaN(curve[h])) vals.push(curve[h])
  }
  if (vals.length < 2) return 0
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  return Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
}

// Compute 20*log10(rms(10^(G/20))) over voiced samples only
function rmsGainOverVoiced(G_smoothed, hopVoiced, hopSamples) {
  let sumSq = 0, count = 0
  const numHops = hopVoiced.length
  for (let h = 0; h < numHops; h++) {
    if (!hopVoiced[h]) continue
    const start = h * hopSamples
    const end   = Math.min(start + hopSamples, G_smoothed.length)
    for (let i = start; i < end; i++) {
      const lin = Math.pow(10, G_smoothed[i] / 20.0)
      sumSq += lin * lin
      count++
    }
  }
  if (count === 0) return 0
  return 20 * Math.log10(Math.sqrt(sumSq / count))
}

// ─── Preset config lookup ─────────────────────────────────────────────────────

function getAutoLevelerConfig(presetId) {
  return PRESETS[presetId]?.autoLeveler ?? null
}

// ─── Main API ─────────────────────────────────────────────────────────────────

/**
 * Apply dual-loop VAD-gated gain riding to an audio file.
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

  // Duration check
  const durationS = n / sampleRate
  if (durationS < MIN_FILE_DURATION_S) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'duration_too_short' }
  }

  // 4b-1: VAD conditioning
  const framedVoiced = applyVadHysteresis(frameAnalysis?.frames ?? [], sampleRate)
  const hopSamples   = Math.round(HOP_MS * 0.001 * sampleRate)
  const numHops      = Math.floor(n / hopSamples)

  const frameSamples = frameAnalysis?.frames?.[0]?.lengthSamples
    ?? Math.round(FRAME_MS * 0.001 * sampleRate)
  const framesPerHop = Math.max(1, Math.round(hopSamples / frameSamples))
  const hopVoiced    = frameVoicedToHopVoiced(framedVoiced, framesPerHop, numHops)

  // Voiced duration check
  const voicedHops = hopVoiced.reduce((s, v) => s + v, 0)
  if (voicedHops * HOP_MS * 0.001 < MIN_VOICED_DURATION_S) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'insufficient_voiced_audio' }
  }

  // 4b-2: K-weighted LUFS curves (voiced hops only)
  const kwSamples = applyKWeighting(audio, sampleRate)
  const windowSt  = Math.round(400  * 0.001 * sampleRate)
  const windowMt  = Math.round(1500 * 0.001 * sampleRate)
  const L_st      = computeLufsCurve(kwSamples, hopVoiced, windowSt, hopSamples)
  const L_mt      = computeLufsCurve(kwSamples, hopVoiced, windowMt, hopSamples)

  // Skip check after loudness measurement
  const stdSt = computeStdVoiced(L_st, hopVoiced)
  const stdMt = computeStdVoiced(L_mt, hopVoiced)
  if (stdSt < LEVELED_STD_THRESHOLD && stdMt < LEVELED_STD_THRESHOLD) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, skipped_reason: 'file_already_leveled' }
  }

  // 4b-3: Slow target — moving median over voiced hops
  const windowTargetHops = Math.round(config.target_window_s * 1000 / HOP_MS)
  const L_target         = movingMedianVoiced(L_st, hopVoiced, windowTargetHops)

  // Noise floor caps — headroom is positive only when the measured noise floor is
  // already below the target; if it is at or above the target, upward gain is 0.
  const noiseFloorDbfs   = frameAnalysis?.noiseFloorDbfs ?? -60
  const nfHeadroom       = Math.max(0, (config.noise_floor_target_dbfs - noiseFloorDbfs) - 3)
  const maxAUpEff        = Math.min(config.loop_a.max_up_db, nfHeadroom)
  const maxBUpEff        = Math.min(config.loop_b.max_up_db, Math.max(0, nfHeadroom - maxAUpEff))
  const nfCapActive      = maxAUpEff < config.loop_a.max_up_db || maxBUpEff < config.loop_b.max_up_db

  // 4b-4a: Loop A correction shaping (drift)
  const L_st_filled = fillUnvoiced(L_st)
  const G_A_hops    = new Float64Array(numHops)
  for (let h = 0; h < numHops; h++) {
    G_A_hops[h] = shapeDrift(
      L_target[h] - L_st_filled[h],
      config.loop_a.deadband_db,
      config.loop_a.knee_db,
      maxAUpEff,
      config.loop_a.max_down_db,
    )
  }

  // 4b-4b: Loop B correction shaping (performance compression)
  const L_mt_filled = fillUnvoiced(L_mt)
  const G_B_hops    = new Float64Array(numHops)
  for (let h = 0; h < numHops; h++) {
    G_B_hops[h] = shapeCompression(
      L_target[h] - L_mt_filled[h],
      config.loop_b.deadband_up_db,
      config.loop_b.deadband_down_db,
      config.loop_b.ratio_up,
      config.loop_b.ratio_down,
      maxBUpEff,
      config.loop_b.max_down_db,
    )
  }

  // 4b-5: Interpolate to sample rate and apply envelope followers
  const G_A_sr       = linearInterpolateToSamples(G_A_hops, hopSamples, n)
  const G_B_sr       = linearInterpolateToSamples(G_B_hops, hopSamples, n)
  const G_A_smoothed = envelopeFollow(G_A_sr, config.loop_a.attack_ms, config.loop_a.release_ms, sampleRate)
  const G_B_smoothed = envelopeFollow(G_B_sr, config.loop_b.attack_ms, config.loop_b.release_ms, sampleRate)

  // 4b-6: Sum, cap, apply
  const maxUp   = config.total_max_up_db
  const maxDown = config.total_max_down_db

  const processedChannels = channels.map(ch => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const G = Math.max(-maxDown, Math.min(maxUp, G_A_smoothed[i] + G_B_smoothed[i]))
      out[i] = ch[i] * Math.pow(10, G / 20.0)
    }
    return out
  })

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  // Post-processing measurements for logging
  const kwOut    = applyKWeighting(processedChannels[0], sampleRate)
  const L_st_out = computeLufsCurve(kwOut, hopVoiced, windowSt, hopSamples)
  const L_mt_out = computeLufsCurve(kwOut, hopVoiced, windowMt, hopSamples)
  const outStdSt = computeStdVoiced(L_st_out, hopVoiced)
  const outStdMt = computeStdVoiced(L_mt_out, hopVoiced)

  // Gain stats
  let aMaxUp = -Infinity, aMaxDown = Infinity
  let bMaxUp = -Infinity, bMaxDown = Infinity
  let tMaxUp = -Infinity, tMaxDown = Infinity

  for (let i = 0; i < n; i++) {
    if (G_A_smoothed[i] > aMaxUp)   aMaxUp   = G_A_smoothed[i]
    if (G_A_smoothed[i] < aMaxDown) aMaxDown = G_A_smoothed[i]
    if (G_B_smoothed[i] > bMaxUp)   bMaxUp   = G_B_smoothed[i]
    if (G_B_smoothed[i] < bMaxDown) bMaxDown = G_B_smoothed[i]
    const G = Math.max(-maxDown, Math.min(maxUp, G_A_smoothed[i] + G_B_smoothed[i]))
    if (G > tMaxUp)   tMaxUp   = G
    if (G < tMaxDown) tMaxDown = G
  }

  return {
    applied:       true,
    skipped_reason: null,
    preset_params: {
      total_max_up_db:          maxUp,
      total_max_down_db:        maxDown,
      target_window_s:          config.target_window_s,
      noise_floor_target_dbfs:  config.noise_floor_target_dbfs,
      loop_a: {
        deadband_db:  config.loop_a.deadband_db,
        knee_db:      config.loop_a.knee_db,
        max_up_db:    config.loop_a.max_up_db,
        max_down_db:  config.loop_a.max_down_db,
        attack_ms:    config.loop_a.attack_ms,
        release_ms:   config.loop_a.release_ms,
      },
      loop_b: {
        deadband_up_db:   config.loop_b.deadband_up_db,
        deadband_down_db: config.loop_b.deadband_down_db,
        ratio_up:         config.loop_b.ratio_up,
        ratio_down:       config.loop_b.ratio_down,
        max_up_db:        config.loop_b.max_up_db,
        max_down_db:      config.loop_b.max_down_db,
        attack_ms:        config.loop_b.attack_ms,
        release_ms:       config.loop_b.release_ms,
      },
    },
    measurements: {
      input_loudness_st_std_db:  round2(stdSt),
      input_loudness_mt_std_db:  round2(stdMt),
      output_loudness_st_std_db: round2(outStdSt),
      output_loudness_mt_std_db: round2(outStdMt),
      loop_a_max_gain_up_db:     round2(aMaxUp   === -Infinity ? 0 : aMaxUp),
      loop_a_max_gain_down_db:   round2(aMaxDown ===  Infinity ? 0 : aMaxDown),
      loop_a_rms_gain_db:        round2(rmsGainOverVoiced(G_A_smoothed, hopVoiced, hopSamples)),
      loop_b_max_gain_up_db:     round2(bMaxUp   === -Infinity ? 0 : bMaxUp),
      loop_b_max_gain_down_db:   round2(bMaxDown ===  Infinity ? 0 : bMaxDown),
      loop_b_rms_gain_db:        round2(rmsGainOverVoiced(G_B_smoothed, hopVoiced, hopSamples)),
      total_max_gain_up_db:      round2(tMaxUp   === -Infinity ? 0 : tMaxUp),
      total_max_gain_down_db:    round2(tMaxDown ===  Infinity ? 0 : tMaxDown),
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
