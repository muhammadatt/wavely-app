/**
 * Pipeline stage functions.
 *
 * Each stage receives the shared pipeline context (ctx) and writes its results
 * back into ctx.results. Stages update ctx.currentPath whenever they produce a
 * new audio file. The pipeline runner in index.js calls stages sequentially.
 *
 * Stage signature: async (ctx) => void
 *
 * ctx shape — see createContext() in index.js:
 *   ctx.inputPath, ctx.originalName, ctx.presetId, ctx.outputProfileId
 *   ctx.preset, ctx.outputProfile
 *   ctx.tmp(ext)        — allocates a temp file path and registers it for cleanup
 *   ctx.tmpFiles        — array of all allocated temp paths
 *   ctx.currentPath     — path to the audio file being processed (updated by stages)
 *   ctx.probe           — ffprobe output (set by decode)
 *   ctx.inputSampleRate — (set by decode)
 *   ctx.inputChannels   — (set by decode)
 *   ctx.peaks           — waveform peak data (set by extractPeaks)
 *   ctx.results         — object accumulating per-stage result data
 */

import {
  decodeToFloat32,
  mixdownToMono,
  applyHighPass,
  applyLinearGain,
  applyLoudnormLUFS,
  applyTruePeakLimiter,
  applyParametricEQ,
  encodeOutput,
  probeFile,
} from '../lib/ffmpeg.js'
import { runFfmpeg } from '../lib/exec-ffmpeg.js'
import { applyNoiseReduction } from './noiseReduce.js'
import { measureAudio, measureVoicedRms, checkAcxCertification } from './measure.js'
import { extractPeaks as extractPeaksFromFile } from './peaks.js'
import { analyzeAudioFrames } from './silenceAnalysis.js'
import { analyzeSpectrum } from './enhancementEQ.js'
import { applyRoomTonePadding } from './roomTone.js'
import { generateQualityAdvisory } from './riskAssessment.js'
import { analyzeAndDeEss } from './deEsser.js'
import { applyCompression } from './compression.js'

// ── Stage: Decode ─────────────────────────────────────────────────────────────

export async function decode(ctx) {
  ctx.probe = await probeFile(ctx.inputPath)
  const audioStream = ctx.probe.streams.find(s => s.codec_type === 'audio')
  ctx.inputSampleRate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : null
  ctx.inputChannels   = audioStream?.channels || 1

  if (ctx.inputChannels > 2) {
    throw new Error(
      `Unsupported channel count: ${ctx.inputChannels}. Only mono and stereo files are supported.`
    )
  }

  const decodedPath = ctx.tmp('.wav')
  await decodeToFloat32(ctx.inputPath, decodedPath)
  ctx.currentPath = decodedPath
}

// ── Stage: Mono mixdown ───────────────────────────────────────────────────────

export async function monoMixdown(ctx) {
  if (ctx.preset.channelOutput === 'mono' && ctx.inputChannels > 1) {
    const monoPath = ctx.tmp('.wav')
    await mixdownToMono(ctx.currentPath, monoPath)
    ctx.currentPath = monoPath
    ctx.results.stereoToMono = true
  } else {
    ctx.results.stereoToMono = false
  }
}

// ── Stage: Measure before ─────────────────────────────────────────────────────

export async function measureBefore(ctx) {
  ctx.results.beforeMeasurements = await measureAudio(ctx.currentPath)
}

// ── Stage: Silence analysis (pre-HPF) ────────────────────────────────────────
// Provides the raw noise floor for 60 Hz hum detection.

export async function silenceAnalysisRaw(ctx) {
  const sa = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.silenceRaw     = sa
  ctx.results.rawNoiseFloor  = sa.noiseFloorDbfs
  logSilence('pre-HPF', sa)
}

// ── Stage: High-pass filter ───────────────────────────────────────────────────

export async function hpf(ctx) {
  const notch60Hz = detect60HzHum(ctx.results.rawNoiseFloor)
  const hpfPath   = ctx.tmp('.wav')
  await applyHighPass(ctx.currentPath, hpfPath, { notch60Hz })
  ctx.currentPath     = hpfPath
  ctx.results.notch60Hz = notch60Hz
  await logLevel('after HPF', ctx.currentPath, { notch60Hz })
}

// ── Stage: Noise reduction ────────────────────────────────────────────────────

export async function noiseReduce(ctx) {
  const nrPath    = ctx.tmp('.wav')
  const nrCeiling = ceilingTierFromMaxDb(ctx.preset.noiseReductionCeiling)
  const nrResult  = await applyNoiseReduction(ctx.currentPath, nrPath, {
    ceilingTier:    nrCeiling,
    noiseFloorDbfs: ctx.results.beforeMeasurements.noiseFloorDbfs,
  })
  ctx.currentPath          = nrPath
  ctx.results.noiseReduction = nrResult
  await logLevel('after NR', ctx.currentPath, {
    tier:          nrResult.tier,
    attenLim:      nrResult.atten_lim_db !== null ? `${nrResult.atten_lim_db}dB` : 'none',
    preNoiseFloor: `${nrResult.pre_noise_floor_dbfs}dBFS`,
  })
}

// ── Stage: Silence analysis (post-NR) ────────────────────────────────────────
// Definitive silence analysis used by room tone padding and enhancement EQ.

export async function silenceAnalysisPostNr(ctx) {
  const sa = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.silencePostNr = sa
  logSilence('post-NR', sa)
}

// ── Stage: Room tone padding (ACX Audiobook only) ─────────────────────────────

export async function roomTonePad(ctx) {
  const paddedPath = ctx.tmp('.wav')
  const result     = await applyRoomTonePadding(ctx.currentPath, paddedPath, ctx.results.silencePostNr)
  ctx.currentPath        = paddedPath
  ctx.results.roomTonePad = result
}

// ── Stage: Enhancement EQ ─────────────────────────────────────────────────────

export async function enhancementEQ(ctx) {
  const eqResult = await analyzeSpectrum(
    ctx.currentPath,
    ctx.presetId,
    ctx.results.silencePostNr,
    ctx.results.silencePostNr.noiseFloorDbfs,
  )
  const eqPath = ctx.tmp('.wav')
  await applyParametricEQ(ctx.currentPath, eqPath, eqResult.ffmpegFilters)
  ctx.currentPath       = eqPath
  ctx.results.enhancementEQ = eqResult
  await logLevel('after EQ', ctx.currentPath, {
    applied: eqResult.applied,
    filters: eqResult.ffmpegFilters.length,
  })
}

// ── Stage: Silence analysis (pre de-esser) ────────────────────────────────────
// Must run after EQ so frame offsets and levels reflect the current signal.
// Reused by both the de-esser and compression stages.

export async function silenceAnalysisPreDeEss(ctx) {
  ctx.results.silencePreDeEss = await analyzeAudioFrames(ctx.currentPath)
}

// ── Stage: De-esser ───────────────────────────────────────────────────────────

export async function deEss(ctx) {
  const deEssPath   = ctx.tmp('.wav')
  const deEssResult = await analyzeAndDeEss(
    ctx.currentPath,
    deEssPath,
    ctx.presetId,
    ctx.results.silencePreDeEss,
  )
  ctx.currentPath   = deEssPath
  ctx.results.deEss = deEssResult
  await logLevel('after de-esser', ctx.currentPath, {
    applied:   deEssResult.applied,
    voiceType: deEssResult.voiceType        ?? 'n/a',
    f0:        deEssResult.f0Hz        !== null ? `${deEssResult.f0Hz}Hz`           : 'n/a',
    maxRed:    deEssResult.maxReductionDb !== null ? `${deEssResult.maxReductionDb}dB` : 'n/a',
  })
}

// ── Stage: Compression ────────────────────────────────────────────────────────

export async function compress(ctx) {
  const compPath          = ctx.tmp('.wav')
  const compressionResult = await applyCompression(
    ctx.currentPath,
    compPath,
    ctx.presetId,
    ctx.results.silencePreDeEss,
  )
  ctx.currentPath        = compPath
  ctx.results.compression = compressionResult
  await logLevel('after compression', ctx.currentPath, {
    applied: compressionResult.applied,
    crest:   compressionResult.crestFactorDb      !== null ? `${compressionResult.crestFactorDb}dB`      : 'n/a',
    maxRed:  compressionResult.maxGainReductionDb !== null ? `${compressionResult.maxGainReductionDb}dB` : 'n/a',
    avgRed:  compressionResult.avgGainReductionDb !== null ? `${compressionResult.avgGainReductionDb}dB` : 'n/a',
  })
}

// ── Stage: Normalize ──────────────────────────────────────────────────────────

export async function normalize(ctx) {
  const { outputProfile } = ctx
  const normPath          = ctx.tmp('.wav')
  let normExtras          = {}

  if (outputProfile.measurementMethod === 'RMS') {
    const targetRms             = (outputProfile.loudnessRange[0] + outputProfile.loudnessRange[1]) / 2
    const prNormSilenceAnalysis = await analyzeAudioFrames(ctx.currentPath)
    const voicedRms             = await measureVoicedRms(ctx.currentPath, prNormSilenceAnalysis)
    const gainDb                = targetRms - voicedRms

    if (gainDb > 18) {
      console.warn(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
    }

    await applyLinearGain(ctx.currentPath, normPath, gainDb)
    normExtras = {
      method:      'RMS',
      target:      `${targetRms}dBFS`,
      voicedRms:   `${round2(voicedRms)}dBFS`,
      gainApplied: `${round2(gainDb)}dB`,
    }
  } else {
    const targetLufs = (outputProfile.loudnessRange[0] + outputProfile.loudnessRange[1]) / 2
    await applyLoudnormLUFS(ctx.currentPath, normPath, {
      targetLUFS:  targetLufs,
      peakCeiling: outputProfile.truePeakCeiling,
    })
    normExtras = {
      method: 'LUFS',
      target: `${targetLufs}LUFS`,
      tp:     `${outputProfile.truePeakCeiling}dBTP`,
    }
  }

  ctx.currentPath = normPath
  await logLevel('after normalization', ctx.currentPath, normExtras)
}

// ── Stage: True peak limiter ──────────────────────────────────────────────────

export async function truePeakLimit(ctx) {
  const limitedPath = ctx.tmp('.wav')
  await applyTruePeakLimiter(ctx.currentPath, limitedPath, {
    peakCeiling: ctx.outputProfile.truePeakCeiling,
  })
  ctx.currentPath = limitedPath
  await logLevel('after limiting', ctx.currentPath, { tp: `${ctx.outputProfile.truePeakCeiling}dBTP` })
}

// ── Stage: Measure after ──────────────────────────────────────────────────────

export async function measureAfter(ctx) {
  ctx.results.afterMeasurements = await measureAudio(ctx.currentPath)
}

// ── Stage: ACX Certification ──────────────────────────────────────────────────
// Only runs for acx output profile. For other profiles the key is absent from
// the report (not null) — per compliance model v2 spec.

export async function acxCertification(ctx) {
  if (ctx.outputProfileId !== 'acx') return
  // sampleRate and bitDepth reflect the final encoded output format for ACX,
  // not the intermediate 32-bit float WAV the pipeline uses during processing.
  // The encode stage always produces 16-bit PCM WAV at 44.1 kHz for ACX output.
  const fileMetadata = {
    sampleRate: 44100,
    bitDepth:   '16-bit PCM',
    channels:   ctx.preset.channelOutput === 'mono' ? 1 : (ctx.inputChannels ?? 1),
  }
  ctx.results.acxCertification = checkAcxCertification(ctx.results.afterMeasurements, fileMetadata)
}

// ── Stage: Quality advisory ───────────────────────────────────────────────────

export async function qualityAdvisory(ctx) {
  const postProcessSilenceAnalysis = await analyzeAudioFrames(ctx.currentPath)
  const pipelineContext = {
    nrTier:         ctx.results.noiseReduction?.tier    ?? null,
    noiseFloorDbfs: ctx.results.noiseReduction?.post_noise_floor_dbfs ?? null,
  }
  ctx.results.qualityAdvisory = await generateQualityAdvisory(
    ctx.currentPath,
    ctx.presetId,
    ctx.outputProfileId,
    postProcessSilenceAnalysis,
    postProcessSilenceAnalysis.voicedRmsDbfs,
    pipelineContext,
  )
}

// ── Stage: Encode output ──────────────────────────────────────────────────────

export async function encode(ctx) {
  const outputPath     = ctx.tmp('.wav')
  const outputChannels = ctx.preset.channelOutput === 'mono' ? 1 : undefined
  await encodeOutput(ctx.currentPath, outputPath, {
    format:   'wav',
    channels: outputChannels,
  })
  ctx.currentPath = outputPath
}

// ── Stage: Extract waveform peaks ─────────────────────────────────────────────

export async function extractPeaks(ctx) {
  ctx.peaks = await extractPeaksFromFile(ctx.currentPath)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Simplified 60 Hz hum heuristic.
 * A proper implementation would do spectral analysis on silence frames.
 * We use the raw noise floor as a proxy — if > -55 dBFS, there's likely a
 * noise source present and the 60 Hz notch is worth applying.
 * Sprint 2 note: Full spectral tonal detection is deferred.
 */
function detect60HzHum(rawNoiseFloor) {
  return rawNoiseFloor > -55
}

/**
 * Map a preset's noiseReductionCeiling (max dB) to a DeepFilterNet3 tier.
 * Tier → atten_lim_db: 1→3, 2→6, 3→9, 4→12, 5→uncapped
 */
function ceilingTierFromMaxDb(maxDb) {
  if (maxDb <= 3)  return 1
  if (maxDb <= 6)  return 2
  if (maxDb <= 9)  return 3
  if (maxDb <= 12) return 4
  return 5
}

async function logLevel(label, filePath, extras = {}) {
  try {
    const { stderr } = await runFfmpeg([
      '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
    ])
    const peak   = stderr.match(/max_volume:\s*([-\d.inf]+)\s*dB/)?.[1]  ?? '?'
    const mean   = stderr.match(/mean_volume:\s*([-\d.inf]+)\s*dB/)?.[1] ?? '?'
    const extStr = Object.entries(extras).map(([k, v]) => `${k}=${v}`).join('  ')
    console.log(`[level] ${label}: peak=${peak}dBFS  mean=${mean}dBFS${extStr ? '  ' + extStr : ''}`)
  } catch (e) {
    console.log(`[level] ${label}: measurement failed — ${e.message}`)
  }
}

function logSilence(label, sa) {
  const voiced = sa.frames.filter(f => !f.isSilence).length
  const total  = sa.frames.length
  console.log(
    `[silence] ${label}: noiseFloor=${sa.noiseFloorDbfs}dBFS  ` +
    `threshold=${sa.silenceThresholdDbfs}dBFS  ` +
    `voicedRms=${sa.voicedRmsDbfs}dBFS  ` +
    `voiced=${voiced}/${total} frames`
  )
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
