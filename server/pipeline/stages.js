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
  applyTruePeakLimiter,
  applyParametricEQ,
  encodeOutput,
  probeFile,
} from '../lib/ffmpeg.js'
import { runFfmpeg } from '../lib/exec-ffmpeg.js'
import { applyNoiseReduction } from './noiseReduce.js'
import { measureAudio, measureVoicedRms, measureVoicedLufs, checkAcxCertification } from './measure.js'
import { extractPeaks as extractPeaksFromFile } from './peaks.js'
import { analyzeAudioFrames, remeasureAudioFrames } from './silenceAnalysis.js'
import { analyzeSpectrum } from './enhancementEQ.js'
import { applyRoomTonePadding } from './roomTone.js'
import { generateQualityAdvisory } from './riskAssessment.js'
import { analyzeAndDeEss } from './deEsser.js'
import { applyCompression } from './compression.js'
import { runRnnoise, runSeparation, runVoiceFixer, runHarmonicExciter, runClearerVoice, runDereverb, runApBwe } from './separation.js'
import { validateSeparation } from './separationValidation.js'
import { applyAutoLeveler } from './autoLeveler.js'
import { applyParallelCompression } from './parallelCompression.js'
import { analyzeHum } from './humEQ.js'

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
//
// Runs before peakNormalize and silenceAnalysisRaw, so there is no pre-existing
// silence analysis to borrow a noise floor from. We run one inline — it's the
// same work silenceAnalysisRaw would do later, but on the pre-peak-normalize
// audio, which is what beforeMeasurements is meant to capture. The cost is a
// single extra analyzeAudioFrames pass per job.

export async function measureBefore(ctx) {
  const audio = await measureAudio(ctx.currentPath)
  const silenceAnalysis = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.beforeMeasurements = {
    ...audio,
    noiseFloorDbfs: silenceAnalysis.noiseFloorDbfs,
  }
}

// ── Stage: Peak normalize (pre-processing) ───────────────────────────────────
// Brings the true peak to -1 dBFS before any processing begins.
// Ensures a consistent working level for NR, EQ, and compression regardless
// of how quiet or loud the original recording is.
// Runs after measureBefore so the report captures the original input level.

export async function peakNormalize(ctx) {
  const TARGET_PEAK_DBFS = -1.0
  const m      = await measureAudio(ctx.currentPath)
  const peak   = m.truePeakDbfs
  const gainDb = TARGET_PEAK_DBFS - peak

  if (Math.abs(gainDb) < 0.1) {
    ctx.log(`[peak-norm] Peak already at ${peak.toFixed(1)} dBFS — skipped`)
    ctx.results.peakNormalize = { applied: false, inputPeakDbfs: peak }
    return
  }

  const outPath = ctx.tmp('.wav')
  await applyLinearGain(ctx.currentPath, outPath, gainDb)
  ctx.currentPath = outPath
  ctx.results.peakNormalize = { applied: true, inputPeakDbfs: peak, gainDb }
  ctx.log(`[peak-norm] ${peak.toFixed(1)} dBFS → ${TARGET_PEAK_DBFS} dBFS (${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB)`)
}

// ── Stage: Silence analysis (pre-HPF) ────────────────────────────────────────
// Provides the raw noise floor for 60 Hz hum detection.

export async function silenceAnalysisRaw(ctx) {
  const sa = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.silenceRaw     = sa
  ctx.results.rawNoiseFloor  = sa.noiseFloorDbfs
}

// ── Stage: Hum detection and conditional EQ ───────────────────────────────────
//
// Runs before HPF (Stage 1) so the 80 Hz Butterworth filter only does its
// intended job (rumble removal) rather than fighting hum harmonics at 120 Hz+.
// The HPF provides approximately −10.8 dB at 60 Hz but only −0.2 dB at 120 Hz
// and essentially 0 dB at 180 Hz+, so hum removal must precede it.
//
// When triggered, the stage allocates a temp file and applies narrow notch
// filters (Q=30, −18 dB) at each flagged harmonic. When not triggered the
// current path is left unchanged (no temp file is created).

export async function humDetect(ctx) {
  const detection = await analyzeHum(ctx.currentPath)

  if (!detection.triggered) {
    ctx.results.humEQ = {
      triggered:        false,
      flaggedHarmonics: [],
      notchesApplied:   [],
      detectionDetail:  detection.detectionDetail,
      ffmpegFilter:     null,
    }
    ctx.log('[hum-detect] No hum detected — passing through unmodified')
    return
  }

  // Apply the pre-computed notch filter string
  const outPath = ctx.tmp('.wav')
  await runFfmpeg([
    '-i', ctx.currentPath,
    '-af', detection.ffmpegFilter,
    '-map_metadata', '0',
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outPath,
  ])

  ctx.currentPath = outPath
  ctx.results.humEQ = {
    triggered:        true,
    flaggedHarmonics: detection.flaggedHarmonics,
    notchesApplied:   detection.flaggedHarmonics,
    detectionDetail:  detection.detectionDetail,
    ffmpegFilter:     detection.ffmpegFilter,
  }
  ctx.log(`[hum-detect] Notches applied at ${detection.flaggedHarmonics.join(', ')} Hz`)
}

// ── Stage: High-pass filter ───────────────────────────────────────────────────

export async function hpf(ctx) {
  // If humDetect already applied a 60 Hz spectral notch (Q=30, −18 dB), skip
  // the coarser heuristic notch in the HPF to avoid double-notching at 60 Hz.
  const humHandled60Hz = ctx.results.humEQ?.notchesApplied?.includes(60) === true
  const notch60Hz      = !humHandled60Hz && detect60HzHum(ctx.results.rawNoiseFloor)
  const hpfPath        = ctx.tmp('.wav')
  await applyHighPass(ctx.currentPath, hpfPath, { notch60Hz })
  ctx.currentPath       = hpfPath
  ctx.results.notch60Hz = notch60Hz
  await logLevel(ctx, 'after HPF', ctx.currentPath, { notch60Hz })
}

// ── Stage: Noise reduction ────────────────────────────────────────────────────

export async function noiseReduce(ctx) {
  const nrPath   = ctx.tmp('.wav')
  // Run DF3 uncapped — the model adapts per time-frequency bin and will not
  // aggressively attenuate speech. atten_lim_db is omitted (null = no ceiling).
  const nrResult = await applyNoiseReduction(ctx.currentPath, nrPath)
  nrResult.pre_noise_floor_dbfs = ctx.results.rawNoiseFloor
  ctx.currentPath            = nrPath
  ctx.results.noiseReduction = nrResult
  await logLevel(ctx, 'after NR', ctx.currentPath, {
    preNoiseFloor: `${ctx.results.rawNoiseFloor}dBFS`,
  })
}

// ── Stage: Silence analysis (post-NR) ────────────────────────────────────────
// Re-derives energy metrics (noise floor, per-frame RMS, voiced RMS) from the
// NR-processed audio. Preserves isSilence labels from silenceRaw — Silero VAD
// classification is stable across pipeline stages since speech content doesn't
// move, only levels change.

export async function silenceAnalysisPostNr(ctx) {
  const sa = await remeasureAudioFrames(ctx.currentPath, ctx.results.silenceRaw)
  ctx.results.silencePostNr = sa
}

// ── Stage: Dereverberation ────────────────────────────────────────────────────
// Runs after noise reduction (on the cleanest possible signal) and before EQ
// so tonal shaping operates on the de-reverberated output.
// Skipped entirely when preset.dereverb is absent or preset.dereverb.enabled is false.

export async function dereverb(ctx) {
  const config = ctx.preset.dereverb
  if (!config?.enabled) return

  const strength     = config.strength     ?? 'medium'
  const preserveEarly = config.preserve_early ?? false

  const outPath = ctx.tmp('.wav')
  ctx.log(`[dereverb] Starting dereverberation (strength=${strength} preserve_early=${preserveEarly})`)
  await runDereverb(ctx.currentPath, outPath, strength, preserveEarly)
  ctx.currentPath       = outPath
  ctx.results.dereverb  = { applied: true, strength, preserve_early: preserveEarly }
  await logLevel(ctx, 'after dereverb', ctx.currentPath, { strength })
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
  await logLevel(ctx, 'after EQ', ctx.currentPath, {
    applied: eqResult.applied,
    filters: eqResult.ffmpegFilters.length,
  })
}

// ── Stage: De-esser ───────────────────────────────────────────────────────────

export async function deEss(ctx) {
  const deEssPath   = ctx.tmp('.wav')
  const deEssResult = await analyzeAndDeEss(
    ctx.currentPath,
    deEssPath,
    ctx.presetId,
    ctx.results.silencePostNr,
  )
  ctx.currentPath   = deEssPath
  ctx.results.deEss = deEssResult
  await logLevel(ctx, 'after de-esser', ctx.currentPath, {
    applied:   deEssResult.applied,
    voiceType: deEssResult.voiceType        ?? 'n/a',
    f0:        deEssResult.f0Hz        !== null ? `${deEssResult.f0Hz}Hz`           : 'n/a',
    maxRed:    deEssResult.maxReductionDb !== null ? `${deEssResult.maxReductionDb}dB` : 'n/a',
  })
}

// ── Stage: Auto Leveler (Stage 4b) ────────────────────────────────────────────
// VAD-gated gain riding. Corrects slow within-file level drift before
// compression sees the signal so the compressor processes a consistently-leveled
// input. Only activated when the standard deviation of per-segment RMS across
// VAD speech windows exceeds 3 dB.
//
// Noise Eraser and ClearerVoice Eraser presets are excluded — separation output
// already has a compressed, consistent character. The leveler skips silently
// for those presets (no audio data changed, no result key written).

export async function autoLevel(ctx) {
  const levelerPath = ctx.tmp('.wav')
  const result = await applyAutoLeveler(
    ctx.currentPath,
    levelerPath,
    ctx.presetId,
    ctx.results.silencePostNr,
  )
  ctx.currentPath      = levelerPath
  ctx.results.autoLeveler = result

  if (result.applied) {
    ctx.log(
      `[auto-leveler] Applied — pre σ=${result.pre_leveling_rms_std_db}dB ` +
      `post σ=${result.post_leveling_rms_std_db}dB ` +
      `target=${result.median_target_rms_dbfs}dBFS ` +
      `gain=[${result.min_gain_applied_db}, ${result.max_gain_applied_db}]dB ` +
      `capped=${result.gain_capped_segments} ` +
      `nf_risk=${result.noise_floor_risk}`
    )
  } else {
    ctx.log(`[auto-leveler] Skipped — ${result.reason}${result.pre_leveling_rms_std_db != null ? ` (σ=${result.pre_leveling_rms_std_db}dB)` : ''}`)
  }
}

// ── Stage: Compression ────────────────────────────────────────────────────────

export async function compress(ctx) {
  const compPath          = ctx.tmp('.wav')
  const compressionResult = await applyCompression(
    ctx.currentPath,
    compPath,
    ctx.presetId,
    ctx.results.silencePostNr,
  )
  ctx.currentPath        = compPath
  ctx.results.compression = compressionResult
  await logLevel(ctx, 'after compression', ctx.currentPath, {
    applied: compressionResult.applied,
    crest:   compressionResult.crestFactorDb      !== null ? `${compressionResult.crestFactorDb}dB`      : 'n/a',
    maxRed:  compressionResult.maxGainReductionDb !== null ? `${compressionResult.maxGainReductionDb}dB` : 'n/a',
    avgRed:  compressionResult.avgGainReductionDb !== null ? `${compressionResult.avgGainReductionDb}dB` : 'n/a',
  })
}

// ── Stage: Parallel Compression (Stage 4a-PC / NE-PC) ────────────────────────
// Splits the signal into a dry passthrough and a heavily-compressed wet branch,
// then mixes them at the preset-specific wet/dry ratio. The wet branch also
// receives a parallel de-esser and a VAD gate (to prevent lifting noise floor
// content during silence).
//
// Runs AFTER Stage 4a (serial compression) so both compression stages shape the
// signal before the Auto Leveler sees it — per spec: "The Auto Leveler should
// operate on the signal after parallel compression has set the density character."

export async function parallelCompress(ctx) {
  const pcPath = ctx.tmp('.wav')
  const result = await applyParallelCompression(
    ctx.currentPath,
    pcPath,
    ctx.presetId,
    ctx.results.silencePostNr,
    ctx.results.deEss ?? null,
  )
  ctx.currentPath = pcPath
  ctx.results.parallelCompression = result
  await logLevel(ctx, 'after parallel compression', ctx.currentPath, {
    applied: result.applied,
    wet:     result.applied ? `${Math.round(result.wetMixEffective * 100)}%` : 'n/a',
    guard:   result.applied ? result.crestFactorGuardActivated               : 'n/a',
  })
}

// ── Stage: Harmonic exciter ───────────────────────────────────────────────────
// Adds subtle harmonic content in the presence/air region (above 3 kHz).
// Runs after compression so the compressor's gain riding doesn't undo the
// harmonic blend, and before normalization so the output level pass absorbs
// any residual energy change.

export async function harmonicExciter(ctx) {
  const outPath = ctx.tmp('.wav')
  await runHarmonicExciter(ctx.currentPath, outPath)
  ctx.currentPath = outPath
  ctx.results.harmonicExciter = { applied: true }
  await logLevel(ctx, 'after harmonic exciter', ctx.currentPath, {})
}

// ── Stage: Normalize ──────────────────────────────────────────────────────────

export async function normalize(ctx) {
  const { outputProfile } = ctx
  const normPath          = ctx.tmp('.wav')
  let normExtras          = {}

  // Both RMS and LUFS paths share the same three-step architecture:
  //   1. Fresh silence analysis on the current (post-compression, post-exciter)
  //      audio so the voiced/silence classification matches the signal we're
  //      about to measure.
  //   2. Silence-excluded loudness measurement (spec §5b: noise_floor + 6 dB).
  //   3. Linear gain = target - measured, applied via FFmpeg `volume`.
  //
  // True peak ceiling is enforced by the subsequent truePeakLimit stage — do
  // not apply it here.
  const prNormSilenceAnalysis = await analyzeAudioFrames(ctx.currentPath)

  if (outputProfile.measurementMethod === 'RMS') {
    // Use the explicit normalizationTarget from the output profile.
    // Do NOT use the loudnessRange midpoint — for ACX the midpoint is -20.5 dBFS
    // but the spec target is -20 dBFS RMS.
    const targetRms = outputProfile.normalizationTarget
    const voicedRms = await measureVoicedRms(ctx.currentPath, prNormSilenceAnalysis)
    const gainDb    = targetRms - voicedRms

    if (gainDb > 18) {
      ctx.log(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
    }

    await applyLinearGain(ctx.currentPath, normPath, gainDb)
    normExtras = {
      method:      'RMS',
      target:      `${targetRms}dBFS`,
      voicedRms:   `${round2(voicedRms)}dBFS`,
      gainApplied: `${round2(gainDb)}dB`,
    }
  } else {
    const targetLufs = outputProfile.normalizationTarget
    const voicedLufs = await measureVoicedLufs(ctx.currentPath, prNormSilenceAnalysis)
    const gainDb     = targetLufs - voicedLufs

    if (gainDb > 18) {
      ctx.log(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
    }

    await applyLinearGain(ctx.currentPath, normPath, gainDb)
    normExtras = {
      method:      'LUFS',
      target:      `${targetLufs}LUFS`,
      voicedLufs:  `${round2(voicedLufs)}LUFS`,
      gainApplied: `${round2(gainDb)}dB`,
    }
  }

  ctx.currentPath = normPath
  await logLevel(ctx, 'after normalization', ctx.currentPath, normExtras)
}

// ── Stage: True peak limiter ──────────────────────────────────────────────────

export async function truePeakLimit(ctx) {
  const limitedPath = ctx.tmp('.wav')
  await applyTruePeakLimiter(ctx.currentPath, limitedPath, {
    peakCeiling: ctx.outputProfile.truePeakCeiling,
  })
  ctx.currentPath = limitedPath
  await logLevel(ctx, 'after limiting', ctx.currentPath, { tp: `${ctx.outputProfile.truePeakCeiling}dBTP` })
}

// ── Stage: Measure after ──────────────────────────────────────────────────────
//
// Populates afterMeasurements including the noise floor from a fresh silence
// analysis on the fully processed audio. The ACX noise-floor check runs off
// this value, so it must reflect the actual silence floor (frame-based) and
// not a histogram-derived proxy. The silence analysis is stashed on ctx for
// qualityAdvisory to reuse — avoids a second analyzeAudioFrames pass.

export async function measureAfter(ctx) {
  const audio = await measureAudio(ctx.currentPath)
  const silenceAnalysis = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.afterMeasurements = {
    ...audio,
    noiseFloorDbfs: silenceAnalysis.noiseFloorDbfs,
  }
  ctx.results.afterSilenceAnalysis = silenceAnalysis
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
  // Reuse the silence analysis produced by measureAfter when available —
  // it was computed on the same audio and is otherwise identical work.
  const postProcessSilenceAnalysis =
    ctx.results.afterSilenceAnalysis ?? await analyzeAudioFrames(ctx.currentPath)
  const pipelineContext = {
    preNrNoiseFloor: ctx.results.rawNoiseFloor ?? null,
    noiseFloorDbfs:  ctx.results.noiseReduction?.post_noise_floor_dbfs ?? null,
    autoLeveler:     ctx.results.autoLeveler ?? null,
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

// ── NE Stage: RNNoise pre-separation pass (NE-1) ──────────────────────────────
// Reduces stationary broadband noise before handing off to Demucs/ConvTasNet.
// Applied unconditionally to all noise_eraser files.

export async function rnnoisePrePass(ctx) {
  const preNoiseFloor = ctx.results.rawNoiseFloor ?? ctx.results.beforeMeasurements?.noiseFloorDbfs
  const outPath = ctx.tmp('.wav')
  await runRnnoise(ctx.currentPath, outPath)
  ctx.currentPath = outPath
  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  ctx.results.separationPipeline.rnnoisePrePass = {
    applied:                true,
    pre_noise_floor_dbfs:   round2(preNoiseFloor ?? null),
    post_noise_floor_dbfs:  null,  // measured in NE-4 validation
  }
  await logLevel(ctx, 'after NE-1 RNNoise', ctx.currentPath, {})
}

// ── NE Stage: Tonal noise pre-treatment (NE-2, conditional) ──────────────────
// Removes strong tonal components (hum, fan resonances) before separation.
// Demucs handles broadband noise well but is weaker on strong tonal noise.

export async function tonalPretreatment(ctx) {
  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}

  // humDetect (the pre-HPF spectral analysis stage) supersedes tonal pre-treatment
  // when it has already applied notch filters. Skip NE-2 to avoid double-notching
  // at 60 Hz / 120 Hz. humDetect's narrower Q=30 notch is more precise than the
  // Q=12 notches applied here.
  if (ctx.results.humEQ?.triggered === true) {
    ctx.log('[NE-2] Hum already handled by humDetect — tonal pre-treatment skipped')
    ctx.results.separationPipeline.tonalPretreatment = { applied: false, notches: [] }
    return
  }

  const rawNoiseFloor = ctx.results.rawNoiseFloor

  // Detect 60 Hz and 120 Hz hum from the pre-processing noise floor.
  // Full spectral tonal scan (Sprint NE-2) uses the silenceRaw power spectrum.
  // Current implementation applies hum notches when noise floor is elevated.
  const apply60Hz  = rawNoiseFloor !== null && rawNoiseFloor > -45
  const apply120Hz = apply60Hz
  const notches    = []

  if (apply60Hz || apply120Hz) {
    const outPath = ctx.tmp('.wav')
    // Build notch chain: Q=12, -24 dB at each tonal frequency
    const filters = []
    if (apply60Hz)  { filters.push('equalizer=f=60:t=q:w=12:g=-24');  notches.push({ freq_hz: 60,  gain_db: -24 }) }
    if (apply120Hz) { filters.push('equalizer=f=120:t=q:w=12:g=-24'); notches.push({ freq_hz: 120, gain_db: -24 }) }
    await applyParametricEQ(ctx.currentPath, outPath, filters)
    ctx.currentPath = outPath
    ctx.log(`[NE-2] Tonal pre-treatment applied: ${notches.map(n => `${n.freq_hz}Hz`).join(', ')}`)
  } else {
    ctx.log('[NE-2] No tonal components detected — NE-2 skipped')
  }

  ctx.results.separationPipeline.tonalPretreatment = {
    applied: notches.length > 0,
    notches,
  }
}

// ── NE Stage: Vocal source separation (NE-3) ─────────────────────────────────
// Extracts the voice signal, discarding all non-voice content.
// Uses Demucs htdemucs_ft (default) or ConvTasNet (fast mode).
// Mono mixdown happens AFTER separation to preserve separation quality.

export async function separateVocals(ctx) {
  // Save the pre-separation path for NE-4 validation comparison
  ctx.nePreSeparationPath = ctx.currentPath

  const model    = ctx.preset.separationModel ?? 'demucs'
  const outPath  = ctx.tmp('.wav')

  ctx.log(`[NE-3] Starting vocal separation with ${model} — this may take several minutes`)
  await runSeparation(ctx.currentPath, outPath, model)
  ctx.currentPath = outPath

  // After separation: apply mono mixdown if preset requires it.
  // Demucs outputs stereo from stereo input; ConvTasNet outputs mono.
  // Converting to mono after separation preserves more separation quality
  // than pre-converting to mono before separation.
  if (ctx.preset.channelOutput === 'mono' && ctx.inputChannels > 1 && model === 'demucs') {
    const monoPath = ctx.tmp('.wav')
    await mixdownToMono(ctx.currentPath, monoPath)
    ctx.currentPath = monoPath
    ctx.results.stereoToMono = true
  } else {
    ctx.results.stereoToMono = ctx.results.stereoToMono ?? false
  }

  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  ctx.results.separationPipeline.separation = {
    model,
    applied: true,
  }
  await logLevel(ctx, 'after NE-3 separation', ctx.currentPath, { model })
}

// ── NE Stage: Post-separation validation (NE-4) ───────────────────────────────
// Spectral flatness artifact detection, sibilance ratio, breath ratio, quality rating.

export async function separationValidation(ctx) {
  const assessment = await validateSeparation(ctx.nePreSeparationPath, ctx.currentPath)

  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  ctx.results.separationPipeline.validation = assessment

  // Update rnnoisePrePass post noise floor from NE-4 measurement
  if (ctx.results.separationPipeline.rnnoisePrePass) {
    ctx.results.separationPipeline.rnnoisePrePass.post_noise_floor_dbfs =
      assessment.postSeparationNoiseFloorDbfs
  }
  ctx.results.separationPipeline.separation.post_separation_noise_floor_dbfs =
    assessment.postSeparationNoiseFloorDbfs
  ctx.results.separationPipeline.separation.sibilance_ratio  = assessment.sibilanceRatio
  ctx.results.separationPipeline.separation.breath_ratio     = assessment.breathRatio
  ctx.results.separationPipeline.separation.artifact_flags   = assessment.artifactFlags
  ctx.results.separationPipeline.separation_quality          = assessment.separationQuality

  // Store postSeparationSilenceAnalysis for normalize stage (silence exclusion threshold)
  ctx.results.postSeparationSilenceAnalysis = assessment.postSeparationSilenceAnalysis

  assessment.artifactFlags.forEach(flag => ctx.log(`[NE-4] ${flag}`))
  ctx.log(
    `[NE-4] Separation quality: ${assessment.separationQuality} | ` +
    `noise floor: ${assessment.postSeparationNoiseFloorDbfs}dBFS | ` +
    `sibilance: ${assessment.sibilanceRatio} | breath: ${assessment.breathRatio}`
  )
}

// ── NE Stage: Residual cleanup (NE-5, conditional) ───────────────────────────
// Light DF3 pass to mop up separation bleed. Skipped if noise floor < -55 dBFS.

export async function residualCleanup(ctx) {
  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  const noiseFloor = ctx.results.separationPipeline.validation?.postSeparationNoiseFloorDbfs

  if (noiseFloor === null || noiseFloor === undefined || noiseFloor <= -55) {
    ctx.results.separationPipeline.residualCleanup = { applied: false, skippedReason: 'Noise floor already below -55 dBFS' }
    ctx.log(`[NE-5] Residual cleanup skipped — noise floor ${noiseFloor}dBFS ≤ -55 dBFS`)
    return
  }

  // 6 dB ceiling: intentionally conservative post-separation cleanup pass.
  // Separation output already has a compressed character; uncapped DF3 risks
  // over-processing the separated voice stem.
  const nrPath = ctx.tmp('.wav')
  const { applyNoiseReduction: applyNR } = await import('./noiseReduce.js')
  const nrResult = await applyNR(ctx.currentPath, nrPath, { attenLimDb: 6 })
  ctx.currentPath = nrPath
  ctx.results.separationPipeline.residualCleanup = {
    applied:                     true,
    tier:                        2,
    pre_noise_floor_dbfs:        round2(noiseFloor),
    post_cleanup_noise_floor_dbfs: null,  // measured in Stage 7
  }
  await logLevel(ctx, 'after NE-5 residual cleanup', ctx.currentPath, { tier: nrResult.tier })
}

// ── NE Stage: Bandwidth extension (NE-6, conditional) ────────────────────────
// Restores high-frequency voice content attenuated during source separation.
// Separation models tend to suppress presence/air/sibilance because broadband
// noise and voice HF content share spectral space; the output voice can sound
// dull without this stage.
//
// Also available for standard presets (off by default) to recover any HF
// attenuated by DeepFilterNet3 at aggressive tiers.
//
// Primary gate: ctx.preset.bwe.enabled must be true.
// Secondary skip (NE context only): if NE-4 shows sibilance ratio ≥ 0.8 AND
// post-separation noise floor ≤ -55 dBFS, HF content is already intact — skip
// to save processing time.

export async function bandwidthExtension(ctx) {
  if (!ctx.preset.bwe?.enabled) {
    ctx.log('[NE-6] Bandwidth extension skipped — not enabled for this preset')
    return
  }

  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}

  // NE-specific skip: skip only when BOTH conditions are met (voice HF is
  // already intact AND the noise floor is already clean).
  // Temporarily disabled — BWE runs unconditionally for all presets.
  // const sibilanceRatio = ctx.results.separationPipeline.separation?.sibilance_ratio
  // const noiseFloor     = ctx.results.separationPipeline.validation?.postSeparationNoiseFloorDbfs
  // const neSibOk  = sibilanceRatio != null && sibilanceRatio >= 0.8
  // const neNsOk   = noiseFloor    != null && noiseFloor    <= -55
  // if (neSibOk && neNsOk) {
  //   ctx.results.separationPipeline.bandwidthExtension = {
  //     applied:       false,
  //     skippedReason: `Sibilance ratio ${sibilanceRatio} ≥ 0.8 and noise floor ${noiseFloor} dBFS ≤ -55 dBFS`,
  //   }
  //   ctx.log(`[NE-6] Bandwidth extension skipped — sibilance ${sibilanceRatio}, noise floor ${noiseFloor} dBFS`)
  //   return
  // }

  // AP-BWE outputs 48 kHz — decodeToFloat32 resamples to 32-bit float 44.1 kHz
  const bwe48kPath = ctx.tmp('.wav')
  const bwe44kPath = ctx.tmp('.wav')
  await runApBwe(ctx.currentPath, bwe48kPath)
  await decodeToFloat32(bwe48kPath, bwe44kPath)
  ctx.currentPath = bwe44kPath

  // Post-BWE sibilance EQ: narrow bell cut to tame HF harshness introduced by BWE.
  // AP-BWE synthesises broadband HF content that can skew sibilant; applying a cut
  // here — before enhancement EQ and the de-esser — corrects this at the source.
  // Parameters (freq, q, gainDb) are configurable per preset via bwe.postEq.
  const postEq = ctx.preset.bwe.postEq
  if (postEq?.enabled) {
    const freq   = postEq.freq   ?? 9000
    const q      = postEq.q      ?? 2
    const gainDb = postEq.gainDb
    const filter = `equalizer=f=${freq}:t=q:w=${q}:g=${gainDb}`
    const eqPath = ctx.tmp('.wav')
    await applyParametricEQ(ctx.currentPath, eqPath, [filter])
    ctx.currentPath = eqPath
    ctx.log(`[NE-6] Post-BWE EQ: ${filter}`)
  }

  ctx.results.separationPipeline.bandwidthExtension = {
    applied: true,
    ...(postEq?.enabled && {
      postEq: { applied: true, freq: postEq.freq ?? 9000, q: postEq.q ?? 2, gainDb: postEq.gainDb },
    }),
  }
  await logLevel(ctx, 'after NE-6 bandwidth extension', ctx.currentPath, {})
}

// ── NE Stage: Post-separation enhancement EQ (NE-7) ──────────────────────────
// Corrects tonal imbalances from separation + BWE using a separation-specific
// reference profile. Max gain ±4 dB (tighter than standard ±5 dB).

export async function separationEQ(ctx) {
  // Use the post-separation silence analysis from NE-4 as the silence context.
  // This ensures voiced frame detection reflects the separated signal character,
  // not the pre-processing signal (which may have had a very different noise floor).
  const silenceAnalysis = ctx.results.postSeparationSilenceAnalysis
    ?? ctx.results.separationPipeline?.validation?.postSeparationSilenceAnalysis

  const noiseFloor = ctx.results.separationPipeline?.validation?.postSeparationNoiseFloorDbfs ?? -60

  const eqResult = await analyzeSpectrum(ctx.currentPath, 'noise_eraser', silenceAnalysis, noiseFloor)
  const eqPath   = ctx.tmp('.wav')
  await applyParametricEQ(ctx.currentPath, eqPath, eqResult.ffmpegFilters)
  ctx.currentPath      = eqPath
  ctx.results.separationEQ = eqResult
  await logLevel(ctx, 'after NE-7 separation EQ', ctx.currentPath, {
    applied: eqResult.applied,
    filters: eqResult.ffmpegFilters.length,
  })
}


// ── CE Stage: ClearerVoice speech enhancement (CE-3) ─────────────────────────
// Single-model replacement for Demucs/ConvTasNet vocal separation (NE-3).
// ClearerVoice SE models operate on mono audio; stereo inputs are mixed to mono
// inside the Python script, so no explicit monoMixdown stage is needed before
// or after this stage.

export async function clearerVoiceEnhance(ctx) {
  // Save the pre-enhancement path for NE-4 validation comparison.
  ctx.nePreSeparationPath = ctx.currentPath

  const model   = ctx.preset.clearervoiceModel ?? 'mossformer2_48k'
  const outPath = ctx.tmp('.wav')

  ctx.log(`[CE-3] Starting ClearerVoice enhancement (${model}) — this may take several minutes`)
  await runClearerVoice(ctx.currentPath, outPath, model)
  ctx.currentPath = outPath

  // ClearerVoice outputs mono regardless of input channel count.
  ctx.results.stereoToMono = ctx.inputChannels > 1

  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  ctx.results.separationPipeline.separation = {
    model:   `clearervoice_${model}`,
    applied: true,
  }
  await logLevel(ctx, 'after CE-3 ClearerVoice', ctx.currentPath, { model })
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

async function logLevel(ctx, label, filePath, extras = {}) {
  try {
    const { stderr } = await runFfmpeg([
      '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
    ])
    const peak   = stderr.match(/max_volume:\s*([-\d.inf]+)\s*dB/)?.[1]  ?? '?'
    const mean   = stderr.match(/mean_volume:\s*([-\d.inf]+)\s*dB/)?.[1] ?? '?'
    const extStr = Object.entries(extras).map(([k, v]) => `${k}=${v}`).join('  ')
    ctx.log(`[level] ${label}: peak=${peak}dBFS  mean=${mean}dBFS${extStr ? '  ' + extStr : ''}`)
  } catch (e) {
    ctx.log(`[level] ${label}: measurement failed — ${e.message}`)
  }
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
