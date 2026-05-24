/**
 * Stage 4a-PC / NE-PC — Parallel Compression.
 *
 * Splits the signal into a dry passthrough and a heavily-compressed wet
 * branch, then mixes them at a preset-specific wet/dry ratio.
 *
 * Wet branch processing chain:
 *   high-ratio compressor → makeup gain → clip-gain sibilant envelope → VAD gate
 *
 * Key design choices:
 *   - Adaptive threshold: voiced_rms_dbfs − 12 dB (floor: −50 dBFS)
 *   - Crest factor guard: scales wet mix down when pre-PC crest factor
 *     falls below the preset guard threshold, preventing over-compression.
 *   - VAD gate: mutes wet branch during silence to avoid lifting noise floor.
 *   - Sibilant control: reuses the per-event gain decisions made by the
 *     clip-gain de-esser stage (ctx.results.clipGainDeEsser.treatedEvents)
 *     and re-renders the same cosine-fade envelope onto the wet branch.
 *     No separate sidechain detector — when the clip-gain stage didn't run
 *     or produced no events, the wet branch passes through unattenuated.
 *
 * Reference: Instant Polish Parallel Compression Stage Specification, April 2026.
 */

import { readWavAllChannels }    from './wavReader.js'
import { writeWavChannels }      from './wavWriter.js'
import { buildClipGainEnvelope } from './clipGainEnvelope.js'


// Parallel threshold derivation (spec §Adaptive Threshold)
const PARALLEL_THRESHOLD_OFFSET_DB = 12
const PARALLEL_THRESHOLD_FLOOR_DB  = -50

// Compressor soft-knee width (same as Stage 4a, spec consistency)
const KNEE_WIDTH_DB = 4

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Apply parallel compression to an audio file.
 *
 * @param {string} inputPath
 * @param {string} outputPath  - 32-bit float WAV output
 * @param {string} presetId
 * @param {import('./stages.js').AudioMetrics} frameAnalysis
 *   From ctx.results.metrics. Provides voicedRmsDbfs, frames.
 * @param {object|null} clipGainResult
 *   From ctx.results.clipGainDeEsser. When present and applied, its
 *   treatedEvents (per-event {startSample, endSample, gainDb, eventType})
 *   are re-rendered as a cosine-fade gain envelope onto the wet branch.
 *   Pass null (or an unapplied result) when unavailable — the wet branch
 *   then runs without any sibilant attenuation.
 * @returns {ParallelCompressionResult}
 *
 * @typedef {Object} ParallelCompressionResult
 * @property {boolean} applied
 * @property {string|null} reason               - Skip reason when not applied
 * @property {number|null} thresholdDbfs
 * @property {number|null} voicedRmsDbfs
 * @property {number|null} ratio
 * @property {number|null} attackMs
 * @property {number|null} releaseMs
 * @property {number|'auto'|null} makeupGain
 * @property {number|null} makeupGainDb
 * @property {number|null} autoMakeupGainDb
 * @property {number|null} avgGainReductionDb
 * @property {number|null} maxGainReductionDb
 * @property {number|null} wetMixTarget
 * @property {number|null} wetMixEffective
 * @property {boolean} crestFactorGuardActivated
 * @property {number|null} prePcCrestFactorDb
 * @property {boolean} parallelDesserApplied
 * @property {'clip_gain_envelope_reuse'|null} parallelDesserSource
 * @property {number|null} parallelDesserEventCount
 * @property {number|null} parallelDesserGainScale
 * @property {number|null} parallelDesserMakeupCompensationDb
 * @property {number|null} parallelDesserMaxReductionDb
 * @property {boolean} vadGateApplied
 * @property {number|null} vadGateFadeMs
 */
export async function applyParallelCompression(inputPath, outputPath, preset, frameAnalysis, clipGainResult) {
  const config = preset?.parallelCompression
  if (!config) {
    await copyThrough(inputPath, outputPath)
    return notApplied('preset_not_configured')
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisCh = channels[0]
  const numSamples = analysisCh.length

  // ── 1. Adaptive threshold ────────────────────────────────────────────────
  const voicedRms    = frameAnalysis.voicedRmsDbfs ?? frameAnalysis.averageVoicedRmsDbfs ?? -24
  const threshold    = Math.max(voicedRms - PARALLEL_THRESHOLD_OFFSET_DB, PARALLEL_THRESHOLD_FLOOR_DB)

  // ── 2. Pre-PC crest factor ───────────────────────────────────────────────
  const prePcCrestFactor = measureCrestFactor(analysisCh, frameAnalysis)

  // ── 3. Crest factor guard ────────────────────────────────────────────────
  const guardThresh = config.crestGuardThresholdDb
  let effectiveWetMix
  let guardActivated = false

  if (prePcCrestFactor < guardThresh) {
    const wetScale      = Math.max(0, Math.min(1, (prePcCrestFactor - 8) / (guardThresh - 8)))
    effectiveWetMix     = config.wetMix * wetScale
    guardActivated      = true
  } else {
    effectiveWetMix = config.wetMix
  }

  // ── 4. Build wet compressor gain curve (from channel 0) ─────────────────
  const compResult = buildCompressorGainCurve(analysisCh, sampleRate, {
    thresholdDb: threshold,
    ratio:       config.ratio,
    attackMs:    config.attackMs,
    releaseMs:   config.releaseMs,
    kneeDb:      KNEE_WIDTH_DB,
  })
  const compCurve = compResult.curve

  // ── 4a. Calculate makeup gain ────────────────────────────────────────────
  // Handle makeup gain: can be a number (fixed dB) or 'auto' (average gain reduction)
  const isAutoMakeup = config.makeupGain === 'auto'
  const autoMakeupGainDb = compResult.avgGainReductionDb
  const finalMakeupGainDb = isAutoMakeup ? autoMakeupGainDb : config.makeupGain

  // ── 5. Build VAD gate curve ──────────────────────────────────────────────
  // bypassVadGate is a debug escape for soloing the wet branch at wetMix near 1.
  // In normal operation the gate keeps the makeup-gained noise floor from
  // leaking through during silence; at wetMix=1 it instead exposes every
  // Silero classification decision as an audible dropout (stop consonant
  // closures, glottal stops, brief unvoiced moments inside words). Setting
  // bypassVadGate skips it entirely — only useful for diagnostic audits.
  const vadGateCurve = config.bypassVadGate
    ? new Float32Array(numSamples).fill(1.0)
    : buildVadGateCurve(numSamples, frameAnalysis, config.vadFadeMs, sampleRate)

  // ── 6. Build wet-branch sibilant envelope (clip-gain reuse) ──────────────
  // Static reuse: take the per-event gainDb values the clip-gain stage already
  // computed on the dry path and re-render the same cosine-fade envelope onto
  // the wet branch. No separate sidechain detector. When the clip-gain stage
  // didn't apply (no preset config, no events, or disabled), the envelope is
  // a flat 1.0 and the wet branch passes through without sibilant attenuation.
  //
  // Per-event gainDb is corrected before rendering:
  //   effective = (ev.gainDb − makeupCompDb) × desserGainScale
  //
  // Semantics of the single knob `desserGainScale`:
  //   0   → de-esser fully off (envelope flat at 1.0)
  //   1   → wet branch's treated sibilants sit at dry-path parity at the output
  //         (makeup-gain boost on sibilants is fully cancelled)
  //   >1  → more aggressive than dry parity
  //   <1  → gentler than dry parity (residual makeup boost remains on sibilants)
  //
  // The compensation scales with the knob, so scale=0 truly disables the
  // de-esser instead of leaving a uniform makeup-shaped dip on every event.
  const treatedEvents   = (clipGainResult?.applied && Array.isArray(clipGainResult.treatedEvents))
    ? clipGainResult.treatedEvents
    : []
  const desserGainScale = config.desserGainScale ?? 1.0
  const makeupCompDb    = finalMakeupGainDb
  const needsCorrection = desserGainScale !== 1.0 || makeupCompDb !== 0
  const eventsForEnvelope = !needsCorrection ? treatedEvents
    : treatedEvents.map(ev => ({
        ...ev,
        gainDb: (ev.gainDb ) * desserGainScale,
      }))
  const desserEnvelope = buildClipGainEnvelope(
    numSamples,
    sampleRate,
    eventsForEnvelope,
    preset?.clipGainDeEsser?.fades,
  )
  const desserApplied = treatedEvents.length > 0

  const makeupLinear = Math.pow(10, finalMakeupGainDb / 20)
  const dryWeight    = 1 - effectiveWetMix
  const wetWeight    = effectiveWetMix

  // ── 7. Mix all channels ──────────────────────────────────────────────────
  const processedChannels = channels.map(ch => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) {
      const dry = ch[i]

      // Wet branch: compress → makeup gain → clip-gain envelope → VAD gate
      const compGainLin   = Math.pow(10, -compCurve[i] / 20)
      const desserGainLin = desserEnvelope.multiplier[i]
      const wet = dry * compGainLin * makeupLinear * desserGainLin * vadGateCurve[i]

      out[i] = dry * dryWeight + wet * wetWeight
    }
    return out
  })

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  return {
    applied:                     true,
    reason:                      null,
    thresholdDbfs:               round2(threshold),
    voicedRmsDbfs:               round2(voicedRms),
    ratio:                       config.ratio,
    attackMs:                    config.attackMs,
    releaseMs:                   config.releaseMs,
    makeupGain:                  config.makeupGain,
    makeupGainDb:                round2(finalMakeupGainDb),
    autoMakeupGainDb:            isAutoMakeup ? round2(autoMakeupGainDb) : null,
    avgGainReductionDb:          round2(compResult.avgGainReductionDb),
    maxGainReductionDb:          round2(compResult.maxGainReductionDb),
    wetMixTarget:                config.wetMix,
    wetMixEffective:             round2(effectiveWetMix),
    crestFactorGuardActivated:   guardActivated,
    prePcCrestFactorDb:          round2(prePcCrestFactor),
    parallelDesserApplied:              desserApplied,
    parallelDesserSource:               desserApplied ? 'clip_gain_envelope_reuse' : null,
    parallelDesserEventCount:           desserApplied ? desserEnvelope.eventCount : 0,
    parallelDesserGainScale:            desserApplied ? desserGainScale : null,
    parallelDesserMakeupCompensationDb: desserApplied ? round2(makeupCompDb) : null,
    parallelDesserMaxReductionDb:       desserApplied ? round2(desserEnvelope.maxReductionDb) : null,
    vadGateApplied:                     !config.bypassVadGate,
    vadGateFadeMs:                      config.bypassVadGate ? null : config.vadFadeMs,
  }
}

// ── Crest Factor ─────────────────────────────────────────────────────────────

/**
 * Voiced-frame crest factor: peak_dBFS − voiced_RMS_dBFS.
 * Same algorithm as compression.js (inlined — not exported from that module).
 */
function measureCrestFactor(samples, frameAnalysis) {
  let sumSq = 0
  let count = 0
  let peak  = 0

  for (const frame of frameAnalysis.frames) {
    if (frame.isSilence) continue
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, samples.length)
    for (let i = start; i < end; i++) {
      const abs = Math.abs(samples[i])
      sumSq += samples[i] * samples[i]
      if (abs > peak) peak = abs
      count++
    }
  }

  if (count === 0 || peak === 0) return 20  // safe default — guard won't activate

  const voicedRms = Math.sqrt(sumSq / count)
  const peakDb    = 20 * Math.log10(peak)
  const rmsDb     = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120

  return peakDb - rmsDb
}

// ── Compressor Gain Curve ────────────────────────────────────────────────────

/**
 * Feed-forward RMS compressor — builds a per-sample gain reduction curve.
 * Same algorithm as Stage 4a (compression.js), parameterised for high-ratio
 * parallel compression. Gain curve is derived from channel 0; applied to all.
 *
 * @returns {{ curve: Float32Array, avgGainReductionDb: number, maxGainReductionDb: number }}
 */
function buildCompressorGainCurve(samples, sampleRate, params) {
  const { thresholdDb, ratio, attackMs, releaseMs, kneeDb } = params
  const n             = samples.length
  const attackCoeff   = Math.exp(-1 / (sampleRate * attackMs  / 1000))
  const releaseCoeff  = Math.exp(-1 / (sampleRate * releaseMs / 1000))

  const curve = new Float32Array(n)
  let powerEnv = 0
  let maxGainReductionDb = 0
  let totalGainReductionDb = 0
  let activeFrames = 0

  for (let i = 0; i < n; i++) {
    const xPow = samples[i] * samples[i]
    powerEnv = xPow > powerEnv
      ? attackCoeff  * powerEnv + (1 - attackCoeff)  * xPow
      : releaseCoeff * powerEnv + (1 - releaseCoeff) * xPow

    const levelDb = powerEnv > 1e-14 ? 10 * Math.log10(powerEnv) : -120
    const gainReductionDb = computeGainReduction(levelDb, thresholdDb, ratio, kneeDb)

    curve[i] = gainReductionDb

    // Track statistics for auto makeup gain
    if (gainReductionDb > 0) {
      if (gainReductionDb > maxGainReductionDb) maxGainReductionDb = gainReductionDb
      totalGainReductionDb += gainReductionDb
      activeFrames++
    }
  }

  const avgGainReductionDb = activeFrames > 0 ? totalGainReductionDb / activeFrames : 0

  return { curve, avgGainReductionDb, maxGainReductionDb }
}

/**
 * Soft-knee gain computer. Returns gain reduction in dB (positive = cut).
 */
function computeGainReduction(levelDb, thresholdDb, ratio, kneeDb) {
  const halfKnee = kneeDb / 2
  const x = levelDb - thresholdDb

  if (x < -halfKnee) return 0

  if (x <= halfKnee) {
    const t = x + halfKnee
    return (1 - 1 / ratio) * (t * t) / (2 * kneeDb)
  }

  const cornerReduction = (1 - 1 / ratio) * halfKnee
  return cornerReduction + (1 - 1 / ratio) * (x - halfKnee)
}

// ── VAD Gate Curve ───────────────────────────────────────────────────────────

/**
 * Build a per-sample gate multiplier (0.0–1.0) from VAD frame classifications.
 *
 * Gate is 1.0 during voiced frames and 0.0 during silence. Transitions use
 * a linear fade over fadeSamples to prevent audible pumping.
 */
function buildVadGateCurve(numSamples, frameAnalysis, vadFadeMs, sampleRate) {
  const curve       = new Float32Array(numSamples)
  const fadeSamples = Math.max(1, Math.round(sampleRate * vadFadeMs / 1000))

  // First pass: hard gate from frame classifications
  for (const frame of frameAnalysis.frames) {
    const start = frame.offsetSamples
    const end   = Math.min(start + frame.lengthSamples, numSamples)
    const value = frame.isSilence ? 0.0 : 1.0
    for (let i = start; i < end; i++) {
      curve[i] = value
    }
  }

  // Fill any samples beyond the last frame (treat as silence)
  // (already 0.0 from Float32Array initialisation)

  // Second pass: apply linear fade ramps at transitions
  let prevValue = curve[0]
  for (let i = 1; i < numSamples; i++) {
    const curr = curve[i]
    if (curr !== prevValue) {
      // Transition detected — apply symmetric fade centred on the transition
      const halfFade  = Math.floor(fadeSamples / 2)
      const fadeStart = Math.max(0, i - halfFade)
      const fadeEnd   = Math.min(numSamples, i + halfFade + 1)
      const from      = prevValue
      const to        = curr
      const totalSteps = fadeEnd - fadeStart
      for (let j = fadeStart; j < fadeEnd; j++) {
        const t = (j - fadeStart) / Math.max(1, totalSteps - 1)
        curve[j] = from + (to - from) * t
      }
      i = fadeEnd - 1  // skip the fade region on next iteration
    }
    prevValue = curve[Math.min(i, numSamples - 1)]
  }

  return curve
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

function notApplied(reason) {
  return {
    applied:                     false,
    reason,
    thresholdDbfs:               null,
    voicedRmsDbfs:               null,
    ratio:                       null,
    attackMs:                    null,
    releaseMs:                   null,
    makeupGain:                  null,
    makeupGainDb:                null,
    autoMakeupGainDb:            null,
    avgGainReductionDb:          null,
    maxGainReductionDb:          null,
    wetMixTarget:                null,
    wetMixEffective:             null,
    crestFactorGuardActivated:   false,
    prePcCrestFactorDb:          null,
    parallelDesserApplied:              false,
    parallelDesserSource:               null,
    parallelDesserEventCount:           null,
    parallelDesserGainScale:            null,
    parallelDesserMakeupCompensationDb: null,
    parallelDesserMaxReductionDb:       null,
    vadGateApplied:                     false,
    vadGateFadeMs:                      null,
  }
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
