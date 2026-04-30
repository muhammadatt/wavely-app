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
import { applyNoiseReduction, runRnnoise, runDtln } from './noiseReduce.js'
import { measureAudio, measureVoicedRms, measureVoicedLufs, checkAcxCertification } from './measure.js'
import { extractPeaks as extractPeaksFromFile } from './peaks.js'
import { analyzeFrames, remeasureFrames } from './frameAnalysis.js'
import { analyzeSpectrum } from './enhancementEQ.js'
import { applyRoomTonePadding } from './roomTone.js'
import { generateQualityAdvisory } from './riskAssessment.js'
import { analyzeAndDeEss } from './deEsser.js'
import { applyCompression } from './compression.js'
import { runSeparation, runClearerVoice } from './separation.js'
import { readFile } from 'fs/promises'
import { runHarmonicExciter, runVocalSaturation, runDereverb, runApBwe, runLavaSR, runClickRemover, applyResonanceSuppression, applySibilanceSuppression } from './enhancement.js'
import { validateSeparation } from './separationValidation.js'
import { applyAutoLeveler } from './autoLeveler.js'
import { applyParallelCompression } from './parallelCompression.js'
import { applyVocalExpander } from './vocalExpander.js'
import { analyzeHum } from './humEQ.js'
import { applyAirBoost } from './airBoost.js'

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

// ── Audio metrics ─────────────────────────────────────────────────────────────
//
// ctx.results.metrics is the single canonical audio metrics object. It is
// initialised by measureBefore and updated at each designated measurement stage:
//
//   measureBefore       – rms, truePeak, lufs from the original file
//   analyzeFramesRaw    – merges in noiseFloor, frames, voicedRms (pre-HPF/NR)
//   remeasureFramesPostNr – updates frame fields after noise reduction
//   separationValidation  – updates frame fields with post-separation analysis
//   measureAfter        – replaces all fields with final processed values
//
// Downstream processing stages (EQ, compression, etc.) always read from
// ctx.results.metrics — never from stage-specific keys like framesPostNr.
//
// Two point-in-time snapshots are kept for reporting only:
//   beforeMeasurements  – { rmsDbfs, truePeakDbfs, lufsIntegrated, noiseFloorDbfs }
//                         captured at measureBefore; noiseFloorDbfs back-filled by
//                         analyzeFramesRaw. Used by qualityAdvisory (preNrNoiseFloor)
//                         and the report's before section.
//   afterMeasurements   – same four fields captured at measureAfter. Used by ACX
//                         certification and the report's after section.

/**
 * @typedef {Object} AudioMetrics
 * @property {number|null} rmsDbfs
 * @property {number|null} truePeakDbfs
 * @property {number|null} lufsIntegrated
 * @property {number|null} noiseFloorDbfs
 * @property {number|null} silenceThresholdDbfs
 * @property {import('./frameAnalysis.js').FrameInfo[]|null} frames
 * @property {number|null} voicedRmsDbfs
 * @property {number|null} averageVoicedRmsDbfs
 * @property {{ offsetSamples: number, lengthSamples: number }|null} quietestSilenceSegment
 */

// ── Stage: Measure before ─────────────────────────────────────────────────────
//
// Runs before peakNormalize. Initialises ctx.results.metrics with the audio
// level measurements from the original file. Frame analysis fields are null
// until analyzeFramesRaw runs. Takes the beforeMeasurements snapshot for the
// report's before section and for qualityAdvisory's preNrNoiseFloor.

export async function measureBefore(ctx) {
  const audio = await measureAudio(ctx.currentPath)
  ctx.results.metrics = {
    rmsDbfs:               audio.rmsDbfs,
    truePeakDbfs:          audio.truePeakDbfs,
    lufsIntegrated:        audio.lufsIntegrated,
    noiseFloorDbfs:        null,
    silenceThresholdDbfs:  null,
    frames:                null,
    voicedRmsDbfs:         null,
    averageVoicedRmsDbfs:  null,
    quietestSilenceSegment: null,
  }
  // Snapshot: noiseFloorDbfs is null here; back-filled by analyzeFramesRaw.
  ctx.results.beforeMeasurements = {
    rmsDbfs:        audio.rmsDbfs,
    truePeakDbfs:   audio.truePeakDbfs,
    lufsIntegrated: audio.lufsIntegrated,
    noiseFloorDbfs: null,
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

// ── Stage: Frame analysis (pre-HPF) ──────────────────────────────────────────
// Classifies voiced/silence frames, measures noise floor and loudness metrics.
// Also back-fills beforeMeasurements.noiseFloorDbfs: analyzeFramesRaw runs on
// post-peakNormalize audio, so the peakNorm gain is subtracted to recover the
// original pre-processing noise floor. Linear gain shifts the noise floor by
// the same amount as voiced frames, so subtraction is exact.

export async function analyzeFramesRaw(ctx) {
  const fa = await analyzeFrames(ctx.currentPath)
  Object.assign(ctx.results.metrics, fa)

  // Back-fill beforeMeasurements.noiseFloorDbfs: analyzeFramesRaw runs on
  // post-peakNormalize audio, so subtract the peakNorm gain to recover the
  // original pre-processing noise floor. Linear gain shifts the noise floor
  // by the same amount as voiced frames, so this subtraction is exact.
  const gainDb = ctx.results.peakNormalize?.gainDb ?? 0
  const originalNoiseFloor = round2(fa.noiseFloorDbfs - gainDb)
  ctx.results.metrics.noiseFloorDbfs = fa.noiseFloorDbfs
  ctx.results.beforeMeasurements.noiseFloorDbfs = originalNoiseFloor
}

// ── Stage: Click remover (Pre-HPF) ────────────────────────────────────────────
// Runs after frame analysis (Pre-4) and before Stage 1 (HPF). Detects and
// repairs transient clicks and mouth sounds using Hampel filter on the HPF
// residual + Burg AR interpolation. Parameters are per-preset: threshold_sigma
// controls detection aggressiveness (lower = more clicks caught), max_click_ms
// caps the repair window (AR interpolation is unreliable above ~15 ms).

export async function clickRemove(ctx) {
  const config = ctx.preset.clickRemover
  if (!config) {
    ctx.log('[click-remover] No clickRemover config on preset — skipped')
    ctx.results.clickRemover = { applied: false, reason: 'not configured' }
    return
  }

  const outPath = ctx.tmp('.wav')
  const report  = await runClickRemover(ctx.currentPath, outPath, {
    thresholdSigma: config.thresholdSigma,
    maxClickMs:     config.maxClickMs,
  })

  ctx.currentPath = outPath
  ctx.results.clickRemover = {
    applied:               true,
    clicks_detected:       report.clicks_detected       ?? null,
    clicks_repaired:       report.clicks_repaired       ?? null,
    clicks_skipped:        report.clicks_skipped        ?? null,
    total_clicks_repaired: report.total_clicks_repaired ?? null,
    channels:              report.channels              ?? null,
    parameters:            report.channels?.[0]?.channel_0?.parameters ?? null,
  }
  ctx.log(
    `[click-remover] Detected=${report.clicks_detected ?? '?'} ` +
    `repaired=${report.total_clicks_repaired ?? '?'} ` +
    `skipped=${report.clicks_skipped ?? '?'} ` +
    `(threshold=${config.thresholdSigma}σ max=${config.maxClickMs}ms)`
  )
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
  const notch60Hz      = !humHandled60Hz && detect60HzHum(ctx.results.metrics.noiseFloorDbfs)
  const hpfPath        = ctx.tmp('.wav')
  await applyHighPass(ctx.currentPath, hpfPath, { notch60Hz })
  ctx.currentPath       = hpfPath
  ctx.results.notch60Hz = notch60Hz
  await logLevel(ctx, 'after HPF', ctx.currentPath, { notch60Hz })
}

// ── Stage: Noise reduction ────────────────────────────────────────────────────

export async function noiseReduce(ctx) {
  const model         = ctx.preset.noiseModel ?? 'df3'
  const outPath       = ctx.tmp('.wav')
  const preNoiseFloor = ctx.results.metrics.noiseFloorDbfs

  if (model === 'rnnoise') {
    await runRnnoise(ctx.currentPath, outPath)
    ctx.currentPath = outPath
    ctx.results.noiseReduction = {
      applied: true,
      model: 'RNNoise',
      atten_lim_db: null,
      pre_noise_floor_dbfs: preNoiseFloor,
      post_noise_floor_dbfs: null,
    }
  } else if (model === 'dtln') {
    await runDtln(ctx.currentPath, outPath)
    ctx.currentPath = outPath
    ctx.results.noiseReduction = {
      applied: true,
      model: 'DTLN',
      atten_lim_db: null,
      pre_noise_floor_dbfs: preNoiseFloor,
      post_noise_floor_dbfs: null,
    }
  } else {
    // df3 (default) — uncapped; the model adapts per time-frequency bin
    const nrResult = await applyNoiseReduction(ctx.currentPath, outPath)
    nrResult.pre_noise_floor_dbfs = preNoiseFloor
    ctx.currentPath = outPath
    ctx.results.noiseReduction = nrResult
  }

  await logLevel(ctx, `after NR (${model})`, ctx.currentPath, {
    preNoiseFloor: `${preNoiseFloor}dBFS`,
  })
}

// ── Stage: Re-measure frames (post-NR) ───────────────────────────────────────
// Re-derives energy metrics (noise floor, per-frame RMS, voiced RMS) from the
// NR-processed audio. Preserves isSilence labels from ctx.results.metrics —
// Silero VAD classification is stable across pipeline stages since speech
// content doesn't move, only levels change.

export async function remeasureFramesPostNr(ctx) {
  const fa = await remeasureFrames(ctx.currentPath, ctx.results.metrics)
  Object.assign(ctx.results.metrics, fa)
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
  const result     = await applyRoomTonePadding(ctx.currentPath, paddedPath, ctx.results.metrics)
  ctx.currentPath        = paddedPath
  ctx.results.roomTonePad = result
}

// ── Stage: Enhancement EQ ─────────────────────────────────────────────────────

export async function enhancementEQ(ctx) {
  const eqResult = await analyzeSpectrum(
    ctx.currentPath,
    ctx.preset?.eqProfile ?? 'general',
    ctx.results.metrics,
    ctx.results.metrics.noiseFloorDbfs,
    { presetId: ctx.presetId },
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

// ── Stage: Resonance Suppressor ───────────────────────────────────────────────
// Soothe2-inspired dynamic spectral resonance suppressor. Runs after
// enhancementEQ (static tonal corrections already applied) and before normalize.
// Only included in STANDARD_PIPELINE — excluded from noise_eraser and
// clearervoice_eraser by pipeline omission.

export async function resonanceSuppressor(ctx) {
  const outPath = ctx.tmp('.wav')
  const frames  = ctx.results.metrics?.frames ?? null
  const f0 = ctx.results.deEss?.f0Hz ?? 226 // Hardcoded fallback if deEss runs after this stage
  const result  = await applyResonanceSuppression(ctx.currentPath, outPath, ctx.presetId, frames, f0)
  if (result.applied) ctx.currentPath = outPath
  ctx.results.resonanceSuppressor = result
  await logLevel(ctx, 'after resonance suppressor', ctx.currentPath, {
    skipped:       result.applied === false,
    max_red:       result.max_reduction_db != null ? `${result.max_reduction_db}dB` : 'n/a',
    artifact_risk: result.artifact_risk ?? false,
  })
}

// ── Stage: Sibilance Suppressor ───────────────────────────────────────────────

export async function sibilanceSuppressor(ctx) {
  const outPath = ctx.tmp('.wav')
  const frames  = ctx.results.metrics?.frames ?? null
  const f0 = ctx.results.deEss?.f0Hz ?? null

  // Two paths:
  //   - Cache hit  (an upstream stage already populated ctx._sibilanceEvents):
  //     pass --events-json to skip internal detection.
  //   - Cache miss (this stage is the first to need the map):
  //     run internal detection but pass --emit-events so the suppressor's
  //     own STFT pass produces the canonical map for downstream consumers
  //     -- no separate analyzer pass needed.
  let eventsPath, emitPath
  if (ctx._sibilanceEvents) {
    eventsPath = ctx._sibilanceEvents.path
  } else {
    emitPath = ctx.tmp('.json')
  }

  const result = await applySibilanceSuppression(
    ctx.currentPath, outPath, ctx.presetId, frames, f0, eventsPath, emitPath,
  )
  if (result.applied) ctx.currentPath = outPath
  ctx.results.sibilanceSuppressor = result

  // Populate the shared cache from the side-emitted map so subsequent
  // consumers (airBoost, etc.) can hit it without a second STFT pass.
  // Cache only the emitted file path here; parsing the event payload can be
  // deferred to consumers that actually need the map contents.
  if (emitPath && !ctx._sibilanceEvents) {
    try {
      await readFile(emitPath)
      ctx._sibilanceEvents = { path: emitPath }
    } catch (err) {
      // Suppressor may have skipped (noise_eraser, n_frames=0) and emitted
      // nothing -- leave the cache empty so analyzeSibilanceEvents() can
      // still run on demand.
      ctx.log(`[SibilanceSuppressor] No event map emitted: ${err.message}`)
    }
  }

  await logLevel(ctx, 'after sibilance suppressor', ctx.currentPath, {
    skipped:       result.applied === false,
    max_red:       result.max_reduction_db != null ? `${result.max_reduction_db}dB` : 'n/a',
    artifact_risk: result.artifact_risk ?? false,
  })
}


// ── Stage: Air Boost (Stage 3b) ───────────────────────────────────────────────
// Wide high-frequency shelf lift modeled on the Maag EQ4 Air Band (10 kHz
// corner). Skips silently when preset.airBoost.gainDb is 0 or negative.
// For ACX output profiles, a noise floor pre/post check constrains the applied
// gain to preserve the -60 dBFS ACX ceiling.

export async function airBoost(ctx) {
  const gainDb       = ctx.preset?.airBoost?.gainDb ?? 0
  const airBoostPath = ctx.tmp('.wav')
  const result       = await applyAirBoost(
    ctx.currentPath,
    airBoostPath,
    gainDb,
    ctx.outputProfileId,
    ctx.results.metrics,
  )
  if (result.applied) ctx.currentPath = airBoostPath
  ctx.results.airBoost = result
  await logLevel(ctx, 'after air boost', ctx.currentPath, {
    applied: result.applied,
    gainDb:  result.applied_gain_db ?? 'skipped',
    ...(result.skip_reason && { reason: result.skip_reason }),
  })
}

// ── Stage: De-esser ───────────────────────────────────────────────────────────

export async function deEss(ctx) {
  const deEssPath   = ctx.tmp('.wav')
  const deEssResult = await analyzeAndDeEss(
    ctx.currentPath,
    deEssPath,
    ctx.presetId,
    ctx.results.metrics,
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
    ctx.results.metrics,
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
    ctx.results.metrics,
  )
  ctx.currentPath        = compPath
  ctx.results.compression = compressionResult
  await logLevel(ctx, 'after compression', ctx.currentPath, {
    applied:    compressionResult.applied,
    passes:     compressionResult.passes ? compressionResult.passes.length : (compressionResult.applied ? 1 : 0),
    crest_in:   compressionResult.inputCrestFactorDb  !== null ? `${compressionResult.inputCrestFactorDb}dB`  : 'n/a',
    crest_tgt:  compressionResult.targetCrestFactorDb !== null ? `${compressionResult.targetCrestFactorDb}dB` : 'n/a',
    crest_final: compressionResult.finalCrestFactorDb !== null ? `${compressionResult.finalCrestFactorDb}dB` : 'n/a',
    ratio:      compressionResult.derivedRatio        !== null ? `${compressionResult.derivedRatio}:1`        : 'n/a',
    threshold:  compressionResult.thresholdDbfs       !== null ? `${compressionResult.thresholdDbfs}dBFS`    : 'n/a',
    maxRed:     compressionResult.maxGainReductionDb  !== null ? `${compressionResult.maxGainReductionDb}dB`  : 'n/a',
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
    ctx.results.metrics,
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

// ── Stage: Vocal Expander (Stage 4a-E) ────────────────────────────────────────
// Frequency-selective dynamic attenuator targeting residual silence-floor
// noise left elevated by the serial + parallel compressors. Not a gate: uses
// a soft ratio (1.5–2.0:1) calibrated from the file's measured silence P90
// energy plus a headroom offset. Detection path is an 80–800 Hz bandpass;
// attenuation is applied full-depth below 800 Hz and softened (scaled by
// `highFreqDepth`) above 800 Hz to preserve consonant clarity.
//
// Runs after Stage 4a-PC and before Stage 4b so the Auto Leveler sees the
// cleaner silence floor that the expander produces.

export async function vocalExpander(ctx) {
  const outPath = ctx.tmp('.wav')
  const result  = await applyVocalExpander(
    ctx.currentPath,
    outPath,
    ctx.presetId,
    ctx.results.metrics,
  )
  if (result.applied) ctx.currentPath = outPath
  ctx.results.vocalExpander = result

  if (result.applied) {
    ctx.log(
      `[vocal-expander] Applied — threshold=${result.thresholdDb}dB ` +
      `ratio=${result.ratio}:1 avgAtten=${result.avgAttenuationSilenceDb}dB ` +
      `maxAtten=${result.maxAttenuationAppliedDb}dB ` +
      `expanded=${result.pctFramesExpanded}%`
    )
  } else {
    ctx.log(`[vocal-expander] Skipped — ${result.reason}`)
  }
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

// ── Stage: Vocal saturation ───────────────────────────────────────────────────
// Parallel tanh saturation mixed with the dry signal at wet_dry ratio.
// Runs after all compression/leveling and before normalization so the
// loudness pass absorbs any residual energy shift from the blend.

export async function vocalSaturation(ctx) {
  const outPath = ctx.tmp('.wav')
  const sat    = ctx.preset.saturation ?? {}
  const drive  = sat.drive  ?? 2.0
  const wetDry = sat.wetDry ?? 0.3
  const bias   = sat.bias   ?? 0.1
  const fc     = sat.fc     ?? 3000
  const f0     = sat.f0

  await runVocalSaturation(ctx.currentPath, outPath, { drive, wetDry, bias, fc, f0 })
  ctx.currentPath = outPath
  ctx.results.vocalSaturation = { applied: true, drive, wetDry, bias, fc, f0 }
  await logLevel(ctx, 'after vocal saturation', ctx.currentPath, {})
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
  const prNormFrameAnalysis = await analyzeFrames(ctx.currentPath)

  if (outputProfile.measurementMethod === 'RMS') {
    // Use the explicit normalizationTarget from the output profile.
    // Do NOT use the loudnessRange midpoint — for ACX the midpoint is -20.5 dBFS
    // but the spec target is -20 dBFS RMS.
    const targetRms = outputProfile.normalizationTarget
    const voicedRms = await measureVoicedRms(ctx.currentPath, prNormFrameAnalysis)
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
    const voicedLufs = await measureVoicedLufs(ctx.currentPath, prNormFrameAnalysis)
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
// not a histogram-derived proxy. The final frame analysis is merged into the
// canonical ctx.results.metrics object for downstream reuse (qualityAdvisory).

export async function measureAfter(ctx) {
  const audio = await measureAudio(ctx.currentPath)
  const fa    = await analyzeFrames(ctx.currentPath)

  // Update canonical metrics with the final post-processing values.
  Object.assign(ctx.results.metrics, fa, {
    rmsDbfs:        audio.rmsDbfs,
    truePeakDbfs:   audio.truePeakDbfs,
    lufsIntegrated: audio.lufsIntegrated,
  })

  // Snapshot for ACX certification and the report's after section.
  ctx.results.afterMeasurements = {
    rmsDbfs:        audio.rmsDbfs,
    truePeakDbfs:   audio.truePeakDbfs,
    lufsIntegrated: audio.lufsIntegrated,
    noiseFloorDbfs: fa.noiseFloorDbfs,
  }
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
  // Reuse cached frame analysis only when the post-processing measurement stage
  // ran and produced the final measurements for the current output. Otherwise,
  // analyze the current file directly to avoid reusing stale pre-final frames.
  const hasFinalMeasurements = ctx.results.afterMeasurements != null
  const frameAnalysis = (hasFinalMeasurements && ctx.results.metrics?.frames != null)
    ? ctx.results.metrics
    : await analyzeFrames(ctx.currentPath)
  const pipelineContext = {
    preNrNoiseFloor:     ctx.results.beforeMeasurements?.noiseFloorDbfs ?? null,
    noiseFloorDbfs:      ctx.results.noiseReduction?.post_noise_floor_dbfs ?? null,
    autoLeveler:         ctx.results.autoLeveler ?? null,
    vocalExpander:       ctx.results.vocalExpander ?? null,
    resonanceSuppressor: ctx.results.resonanceSuppressor ?? null,
  }
  ctx.results.qualityAdvisory = await generateQualityAdvisory(
    ctx.currentPath,
    ctx.presetId,
    ctx.outputProfileId,
    frameAnalysis,
    frameAnalysis.voicedRmsDbfs,
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

// ── NE Stage: Tonal noise pre-treatment (NE-2, conditional) ──────────────────
// Removes strong tonal components (hum, fan resonances) before separation.
// Demucs handles broadband noise well but is weaker on strong tonal noise.

export async function tonalPretreatment(ctx) {
  // humDetect (the pre-HPF spectral analysis stage) supersedes tonal pre-treatment
  // when it has already applied notch filters. Skip NE-2 to avoid double-notching
  // at 60 Hz / 120 Hz. humDetect's narrower Q=30 notch is more precise than the
  // Q=12 notches applied here.
  if (ctx.results.humEQ?.triggered === true) {
    ctx.log('[NE-2] Hum already handled by humDetect — tonal pre-treatment skipped')
    ctx.results.tonalPretreatment = { applied: false, notches: [] }
    return
  }

  const rawNoiseFloor = ctx.results.metrics.noiseFloorDbfs

  // Detect 60 Hz and 120 Hz hum from the pre-processing noise-floor heuristic.
  // Current implementation applies these hum notches only when noise floor is elevated.
  const apply60Hz  = rawNoiseFloor !== null && rawNoiseFloor > -45
  const apply120Hz = apply60Hz
  const notches    = []

  if (apply60Hz || apply120Hz) {
    const outPath = ctx.tmp('.wav')
    // Build notch chain: Q=12, -24 dB at each tonal frequency
    const filters = []
    if (apply60Hz)  { filters.push('equalizer=f=60:width_type=q:w=12:g=-24');  notches.push({ freq_hz: 60,  gain_db: -24 }) }
    if (apply120Hz) { filters.push('equalizer=f=120:width_type=q:w=12:g=-24'); notches.push({ freq_hz: 120, gain_db: -24 }) }
    await applyParametricEQ(ctx.currentPath, outPath, filters)
    ctx.currentPath = outPath
    ctx.log(`[NE-2] Tonal pre-treatment applied: ${notches.map(n => `${n.freq_hz}Hz`).join(', ')}`)
  } else {
    ctx.log('[NE-2] No tonal components detected — NE-2 skipped')
  }

  ctx.results.tonalPretreatment = {
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

  ctx.results.separation = { model, applied: true }
  await logLevel(ctx, 'after NE-3 separation', ctx.currentPath, { model })
}

// ── NE Stage: Post-separation validation (NE-4) ───────────────────────────────
// Spectral flatness artifact detection, sibilance ratio, breath ratio, quality rating.

export async function separationValidation(ctx) {
  const assessment = await validateSeparation(ctx.nePreSeparationPath, ctx.currentPath)

  // Keep the full assessment on ctx.results for report assembly in index.js.
  ctx.results.separationValidation = assessment

  // Merge the post-separation frame analysis into the canonical metrics object
  // so downstream processing stages (residualCleanup, enhancementEQ) always
  // read from ctx.results.metrics rather than from assessment directly.
  if (assessment.postSeparationFrameAnalysis) {
    Object.assign(ctx.results.metrics, assessment.postSeparationFrameAnalysis)
  }

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
  const noiseFloor = ctx.results.metrics.noiseFloorDbfs

  if (noiseFloor === null || noiseFloor === undefined || noiseFloor <= -55) {
    ctx.results.residualCleanup = { applied: false, skippedReason: 'Noise floor already below -55 dBFS' }
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
  ctx.results.residualCleanup = {
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

  // NE-specific skip: skip only when BOTH conditions are met (voice HF is
  // already intact AND the noise floor is already clean).
  // Temporarily disabled — BWE runs unconditionally for all presets.
  // const sibilanceRatio = ctx.results.separationValidation?.sibilanceRatio
  // const noiseFloor     = ctx.results.separationValidation?.postSeparationNoiseFloorDbfs
  // const neSibOk  = sibilanceRatio != null && sibilanceRatio >= 0.8
  // const neNsOk   = noiseFloor    != null && noiseFloor    <= -55
  // if (neSibOk && neNsOk) {
  //   ctx.results.bandwidthExtension = {
  //     applied:       false,
  //     skippedReason: `Sibilance ratio ${sibilanceRatio} ≥ 0.8 and noise floor ${noiseFloor} dBFS ≤ -55 dBFS`,
  //   }
  //   ctx.log(`[NE-6] Bandwidth extension skipped — sibilance ${sibilanceRatio}, noise floor ${noiseFloor} dBFS`)
  //   return
  // }

  const bweModel = ctx.preset.bweModel ?? 'ap_bwe'

  // Both AP-BWE and LavaSR output 48 kHz — decodeToFloat32 resamples to 32-bit float 44.1 kHz
  const bwe48kPath = ctx.tmp('.wav')
  const bwe44kPath = ctx.tmp('.wav')

  if (bweModel === 'lavasr') {
    await runLavaSR(ctx.currentPath, bwe48kPath)
  } else {
    await runApBwe(ctx.currentPath, bwe48kPath)
  }

  await decodeToFloat32(bwe48kPath, bwe44kPath)
  ctx.currentPath = bwe44kPath

  // Post-BWE sibilance EQ: narrow bell cut to tame HF harshness introduced by BWE.
  // Both models synthesise broadband HF content that can skew sibilant; applying a
  // cut here — before enhancement EQ and the de-esser — corrects this at the source.
  // Parameters (freq, q, gainDb) are configurable per preset via bwe.postEq.
  const postEq = ctx.preset.bwe.postEq
  if (postEq?.enabled) {
    const freq   = postEq.freq   ?? 9000
    const q      = postEq.q      ?? 2
    const gainDb = postEq.gainDb
    const filter = `equalizer=f=${freq}:width_type=q:w=${q}:g=${gainDb}`
    const eqPath = ctx.tmp('.wav')
    await applyParametricEQ(ctx.currentPath, eqPath, [filter])
    ctx.currentPath = eqPath
    ctx.log(`[NE-6] Post-BWE EQ: ${filter}`)
  }

  ctx.results.bandwidthExtension = {
    applied: true,
    model: bweModel === 'lavasr' ? 'LavaSR' : 'AP-BWE',
    ...(postEq?.enabled && {
      postEq: { applied: true, freq: postEq.freq ?? 9000, q: postEq.q ?? 2, gainDb: postEq.gainDb },
    }),
  }
  await logLevel(ctx, `after NE-6 bandwidth extension (${bweModel})`, ctx.currentPath, {})
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

  ctx.results.separation = {
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
