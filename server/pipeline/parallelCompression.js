/**
 * Stage 4a-PC / NE-PC — Parallel Compression.
 *
 * Splits the signal into a dry passthrough and a heavily-compressed wet
 * branch, then mixes them at a preset-specific wet/dry ratio.
 *
 * Wet branch processing chain:
 *   high-ratio compressor → makeup gain → wet-branch clip-gain envelope → VAD gate
 *
 * Key design choices:
 *   - Adaptive threshold: voiced_rms_dbfs − 12 dB (floor: −50 dBFS)
 *   - Crest factor guard: scales wet mix down when pre-PC crest factor
 *     falls below the preset guard threshold, preventing over-compression.
 *   - VAD gate: mutes wet branch during silence to avoid lifting noise floor.
 *   - Sibilant control: runs a second clip-gain decision pass against the
 *     synthesized wet branch (compressed + makeup-gained) using the same
 *     event boundaries the upstream `clipGainDeEss` stage detected on the
 *     dry signal. The wet-branch de-esser uses its own (more aggressive)
 *     ceiling / ratio / max-reduction settings so the compressed sibilant
 *     in the wet path is heavily attenuated — letting the dry sibilant
 *     character predominate after the mix. Event boundaries are reused
 *     verbatim (no second detection pass); only peak/context measurement is
 *     redone, against the wet signal. When the upstream stage didn't run or
 *     produced no events, or the preset omits `wetBranchDeEsser`, the wet
 *     branch passes through unattenuated.
 *
 * Reference: Instant Polish Parallel Compression Stage Specification, April 2026.
 */

import { readWavAllChannels }    from './wavReader.js'
import { writeWavChannels }      from './wavWriter.js'
import { buildClipGainEnvelope } from './clipGainEnvelope.js'
import { applyClipGainDeEsser }  from './clipGainDeEsser.js'
import { tempPath }              from '../lib/ffmpeg.js'
import { rm }                    from 'fs/promises'


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
 * @param {object} preset
 * @param {import('./stages.js').AudioMetrics} frameAnalysis
 *   From ctx.results.metrics. Provides voicedRmsDbfs, frames.
 * @param {WetBranchDeEsserCtx|null} [wetBranchDeEsserCtx]
 *   When provided, runs a second clip-gain decision pass against the
 *   synthesized wet branch (compressed + makeup-gained), reusing the event
 *   boundaries from the upstream dry-path detection. The returned treated
 *   events are rendered into a cosine-fade envelope and applied to the wet
 *   branch only, before the dry/wet mix. Pass null to disable wet-branch
 *   sibilant attenuation entirely.
 *
 * @typedef {Object} WetBranchDeEsserCtx
 * @property {string} eventsPath        - Path to the events.json written by
 *                                        the upstream sibilance detection
 *                                        pass (typically the `clipGainDeEss`
 *                                        stage). Event boundaries are reused
 *                                        verbatim; per-event peak dBFS is
 *                                        recomputed against the wet signal.
 * @property {import('./clipGainDeEsser.js').ClipGainDeEsserConfig} config
 *                                      - Wet-branch de-esser settings
 *                                        (stridentCeilingDb, nonStridentCeilingDb,
 *                                        reductionRatio, maxReductionDb,
 *                                        contextWindowMs, fades). Independent
 *                                        from the dry-path clipGainDeEss config.
 * @property {Array}  [vadFrames]       - Frame classifications used for
 *                                        context-RMS measurement.
 *
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
 * @property {'wet_branch_decision'|null} parallelDesserSource
 * @property {number|null} parallelDesserEventCount       - Treated event count (kept for back-compat).
 * @property {number|null} parallelDesserTotalEventCount  - Total events the wet pass examined.
 * @property {number|null} parallelDesserSkippedInRange   - Events whose wet peak sat below the class ceiling.
 * @property {number|null} parallelDesserSkippedNoContext - Events with no usable voiced context window.
 * @property {Array|null}  parallelDesserTreatedEvents    - Per-event records (same shape as dry-path treatedEvents).
 * @property {number|null} parallelDesserStridentCeilingDb
 * @property {number|null} parallelDesserNonStridentCeilingDb
 * @property {number|null} parallelDesserReductionRatio
 * @property {number|null} parallelDesserMaxReductionDb
 * @property {boolean} vadGateApplied
 * @property {number|null} vadGateFadeMs
 */
export async function applyParallelCompression(
  inputPath,
  outputPath,
  preset,
  frameAnalysis,
  wetBranchDeEsserCtx = null,
) {
  const config = preset?.parallelCompression
  if (!config) {
    await copyThrough(inputPath, outputPath)
    return notApplied('preset_not_configured')
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  const analysisCh = channels[0]
  const numSamples = analysisCh.length

  // ── 1. Voiced-frame stats (peak, RMS, crest factor) ─────────────────────
  // Measured locally from the input channel + isSilence labels so no upstream
  // remeasureFramesPostNr is required between compression and this stage.
  const { crestFactorDb: prePcCrestFactor, voicedRmsDbfs: voicedRms } =
    measureVoicedStats(analysisCh, frameAnalysis)

  // ── 2. Adaptive threshold ────────────────────────────────────────────────
  const threshold    = Math.max(voicedRms - PARALLEL_THRESHOLD_OFFSET_DB, PARALLEL_THRESHOLD_FLOOR_DB)

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

  // ── 6. Wet-branch de-esser pass ──────────────────────────────────────────
  // Synthesize the wet-branch signal (compressed + makeup-gained, no envelope
  // and no VAD gate yet) on the analysis channel, write it to a temp WAV, and
  // run clip_gain_deesser.py in decision-only mode against it. The script
  // reuses the event boundaries from the upstream dry-path detection and
  // re-measures each event's peak dBFS and surrounding context RMS on the
  // wet signal — so events that only become problematic AFTER compression
  // + makeup (e.g. /f/ events that the dry-path natural-ceiling rejected) are
  // caught here. The returned treatedEvents are rendered into a cosine-fade
  // envelope applied to the wet branch only.
  const makeupLinear = Math.pow(10, finalMakeupGainDb / 20)
  let   wetDesserResult = null
  let   desserEnvelope  = { multiplier: null, eventCount: 0, maxReductionDb: 0 }
  let   desserSkipReason = null

  if (wetBranchDeEsserCtx?.eventsPath && wetBranchDeEsserCtx.config) {
    const wetAnalysisSignal = synthesizeWetAnalysisSignal(analysisCh, compCurve, makeupLinear)
    const wetTempPath = tempPath('.wav')
    try {
      await writeWavChannels([wetAnalysisSignal], sampleRate, wetTempPath)
      wetDesserResult = await applyClipGainDeEsser(
        wetTempPath,
        null,
        wetBranchDeEsserCtx.eventsPath,
        wetBranchDeEsserCtx.config,
        wetBranchDeEsserCtx.vadFrames ?? null,
        { recomputeEventPeaks: true, decisionOnly: true },
      )
      desserEnvelope = buildClipGainEnvelope(
        numSamples,
        sampleRate,
        wetDesserResult?.treatedEvents ?? [],
        wetBranchDeEsserCtx.config.fades ?? preset?.clipGainDeEsser?.fades,
      )
    } finally {
      await rm(wetTempPath, { force: true }).catch(() => {})
    }
  } else {
    desserSkipReason = wetBranchDeEsserCtx?.eventsPath
      ? 'no_wet_branch_config'
      : 'no_upstream_events'
  }

  const desserApplied = !!(wetDesserResult?.applied)
  // Flat envelope when the wet-branch pass didn't run or treated nothing —
  // keeps the per-sample mix loop branch-free below.
  if (!desserEnvelope.multiplier) {
    desserEnvelope = {
      multiplier:     new Float32Array(numSamples).fill(1.0),
      eventCount:     0,
      maxReductionDb: 0,
    }
  }

  const dryWeight    = 1 - effectiveWetMix
  const wetWeight    = effectiveWetMix

  // ── 7. Mix all channels ──────────────────────────────────────────────────
  const processedChannels = channels.map(ch => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) {
      const dry = ch[i]

      // Wet branch: compress → makeup gain → wet-branch envelope → VAD gate
      const compGainLin   = Math.pow(10, -compCurve[i] / 20)
      const desserGainLin = desserEnvelope.multiplier[i]
      const wet = dry * compGainLin * makeupLinear * desserGainLin * vadGateCurve[i]

      out[i] = dry * dryWeight + wet * wetWeight
    }
    return out
  })

  await writeWavChannels(processedChannels, sampleRate, outputPath)

  const wetCfg = wetBranchDeEsserCtx?.config ?? null
  // Surface the class-keyed ceilings the wet-branch pass actually used,
  // falling back to the legacy naturalCeilingDb when a preset hasn't been
  // migrated yet (mirrors the resolution rule inside applyClipGainDeEsser).
  const wetLegacyCeiling = wetCfg?.naturalCeilingDb     ?? null
  const wetStridentCeil  = wetCfg?.stridentCeilingDb    ?? wetLegacyCeiling
  const wetNonStridCeil  = wetCfg?.nonStridentCeilingDb ?? wetLegacyCeiling
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
    parallelDesserApplied:               desserApplied,
    parallelDesserSource:                desserApplied ? 'wet_branch_decision' : null,
    parallelDesserSkipReason:            desserApplied ? null : desserSkipReason,
    parallelDesserEventCount:            desserApplied ? desserEnvelope.eventCount : 0,
    parallelDesserTotalEventCount:       wetDesserResult ? (wetDesserResult.eventCount       ?? null) : null,
    parallelDesserSkippedInRange:        wetDesserResult ? (wetDesserResult.skippedInRange   ?? null) : null,
    parallelDesserSkippedNoContext:      wetDesserResult ? (wetDesserResult.skippedNoContext ?? null) : null,
    parallelDesserTreatedEvents:         wetDesserResult ? (wetDesserResult.treatedEvents    ?? null) : null,
    parallelDesserStridentCeilingDb:     wetStridentCeil,
    parallelDesserNonStridentCeilingDb:  wetNonStridCeil,
    parallelDesserReductionRatio:        wetCfg ? (wetCfg.reductionRatio ?? null) : null,
    parallelDesserMaxReductionDb:        desserApplied ? round2(desserEnvelope.maxReductionDb) : null,
    vadGateApplied:                      !config.bypassVadGate,
    vadGateFadeMs:                       config.bypassVadGate ? null : config.vadFadeMs,
  }
}

// ── Wet-Branch Synthesis ─────────────────────────────────────────────────────

/**
 * Synthesize the wet branch analysis signal (channel 0): compressed + makeup
 * gained, no envelope, no VAD gate. This is the signal the wet-branch
 * de-esser measures peak/context RMS against.
 */
function synthesizeWetAnalysisSignal(analysisCh, compCurve, makeupLinear) {
  const n   = analysisCh.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const compGainLin = Math.pow(10, -compCurve[i] / 20)
    out[i] = analysisCh[i] * compGainLin * makeupLinear
  }
  return out
}

// ── Crest Factor ─────────────────────────────────────────────────────────────

/**
 * Voiced-frame peak / RMS / crest factor measured from the input channel,
 * using the upstream Silero VAD isSilence labels (which are stable across
 * pipeline stages). Returning both values lets the caller use them for the
 * adaptive threshold AND the crest-factor guard from one pass over the audio,
 * without depending on a preceding remeasureFramesPostNr to refresh
 * frameAnalysis.voicedRmsDbfs.
 */
function measureVoicedStats(samples, frameAnalysis) {
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

  // Safe defaults — guard won't activate, threshold falls back to floor.
  if (count === 0 || peak === 0) return { crestFactorDb: 20, voicedRmsDbfs: -24 }

  const voicedRms    = Math.sqrt(sumSq / count)
  const peakDb       = 20 * Math.log10(peak)
  const voicedRmsDbfs = voicedRms > 0 ? 20 * Math.log10(voicedRms) : -120

  return { crestFactorDb: peakDb - voicedRmsDbfs, voicedRmsDbfs }
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
    parallelDesserApplied:               false,
    parallelDesserSource:                null,
    parallelDesserSkipReason:            null,
    parallelDesserEventCount:            null,
    parallelDesserTotalEventCount:       null,
    parallelDesserSkippedInRange:        null,
    parallelDesserSkippedNoContext:      null,
    parallelDesserTreatedEvents:         null,
    parallelDesserStridentCeilingDb:     null,
    parallelDesserNonStridentCeilingDb:  null,
    parallelDesserReductionRatio:        null,
    parallelDesserMaxReductionDb:        null,
    vadGateApplied:                    false,
    vadGateFadeMs:                     null,
  }
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}
