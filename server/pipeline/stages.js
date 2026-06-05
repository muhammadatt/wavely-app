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
import {
  measureAudio,
  measureRmsDbfs,
  measureRmsAndPeak,
  measureVoicedLufs,
  checkAcxCertification,
} from './measure.js'
import { extractPeaks as extractPeaksFromFile } from './peaks.js'
import { analyzeFrames, remeasureFrames, measureNoiseFloorOnly } from './frameAnalysis.js'
import { analyzeCorrectiveEQ, bandsToFfmpegFilters } from './correctiveEQ.js'
import {
  measureNoiseFloorPsd,
  pinkPsdFallback,
  serializePsd,
  solveAcxLfBoostReductionDb,
} from './eqNoiseFloorModel.js'
import { applyRoomTonePadding } from './roomTone.js'
import { generateQualityAdvisory } from './riskAssessment.js'
import { analyzeAndDeEss } from './deEsser.js'
import { applyClipGainDeEsser } from './clipGainDeEsser.js'
import { applyCompression } from './compression.js'
import { runSeparation, runClearerVoice } from './separation.js'
import { writeFile, rm } from 'fs/promises'
import { runHarmonicExciter, runVocalSaturation, runDereverb, runApBwe, runLavaSR, runClickRemover, runThroatClickAttenuator, applyResonanceSuppression, applyBreathReduction, runSpectralSubtraction, runRoomPresence } from './enhancement.js'
import { validateSeparation } from './separationValidation.js'
import { analyzeAutoLeveler, renderAutoLeveler } from './autoLeveler.js'
import { applyParallelCompression } from './parallelCompression.js'
import { applyVocalExpander } from './vocalExpander.js'
import { applyVadGate }       from './vadGate.js'
import { analyzeHum } from './humEQ.js'
import { computeAirBoostParams, applyAirBoostBands, applyAirBoostMask } from './airBoost.js'
import { getReferenceCurvePath, runReferenceEQPass } from './referenceEQ.js'
import { getF0Contour } from './f0Analysis.js'
import { analyzeSibilanceEvents } from './sibilanceEvents.js'
import { applyBassEnhance } from './bassEnhance.js'

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
  const isAcx = ctx.outputProfileId === 'acx'

  // ACX: RMS + true peak only — LUFS is not part of the ACX 6-point check
  // and no downstream processing stage reads it.
  // Podcast/broadcast: full measureAudio — LUFS is the primary loudness
  // metric and belongs in the report's "before" section for context.
  const audio = isAcx
    ? await measureRmsAndPeak(ctx.currentPath)
    : await measureAudio(ctx.currentPath)

  // Merge into the shared metrics objects rather than replacing them — when
  // measureBefore runs inside a parallel group alongside analyzeFramesRaw,
  // either stage may land first and the other must not clobber its fields.
  // The `??=` initialisers are atomic at the JS statement level (no await
  // between them), so the two forks cannot both create a fresh object.
  ctx.results.metrics ??= {}
  Object.assign(ctx.results.metrics, {
    rmsDbfs:        audio.rmsDbfs,
    truePeakDbfs:   audio.truePeakDbfs,
    lufsIntegrated: audio.lufsIntegrated ?? null,
  })
  ctx.results.beforeMeasurements ??= {}
  Object.assign(ctx.results.beforeMeasurements, {
    rmsDbfs:        audio.rmsDbfs,
    truePeakDbfs:   audio.truePeakDbfs,
    lufsIntegrated: audio.lufsIntegrated ?? null,
  })
}

// ── Stage: Peak normalize (pre-processing) ───────────────────────────────────
// Brings the true peak to -1 dBFS before any processing begins.
// Ensures a consistent working level for NR, EQ, and compression regardless
// of how quiet or loud the original recording is.
// Runs after measureBefore so the report captures the original input level.
//
// Reuses the truePeak measured by measureBefore when available — the audio
// between measureBefore and this stage is unchanged (monoMixdown, when it
// runs, precedes measureBefore), so a second measurement pass would produce
// the same value at the cost of another full-file FFmpeg+libebur128 read.

// Analyze pair (peakNormalizeAnalyze / peakNormalizeApply):
//   Analyze measures the input peak and computes the gain needed to hit the
//   target; Apply runs a single linear-gain FFmpeg call with that gain. The
//   split lets a chunked orchestrator measure peak once on the whole file
//   and apply the same gain in parallel across chunks.

const PEAK_NORMALIZE_TARGET_DBFS = -1.0

export async function peakNormalizeAnalyze(ctx) {
  const cachedPeak = ctx.results.metrics?.truePeakDbfs
  const peak = cachedPeak != null
    ? cachedPeak
    : (await measureAudio(ctx.currentPath)).truePeakDbfs
  const gainDb = PEAK_NORMALIZE_TARGET_DBFS - peak

  if (Math.abs(gainDb) < 0.1) {
    ctx.log(`[peak-norm] Peak already at ${peak.toFixed(1)} dBFS — skipped`)
    ctx.globalParams.peakNormalize = { applied: false, inputPeakDbfs: peak }
    ctx.results.peakNormalize = { applied: false, inputPeakDbfs: peak }
    return
  }

  ctx.globalParams.peakNormalize = { applied: true, inputPeakDbfs: peak, gainDb }
}

export async function peakNormalizeApply(ctx) {
  const params = ctx.globalParams.peakNormalize
  if (!params || !params.applied) {
    // analyze decided no gain change is needed — leave the report entry as-is
    if (!ctx.results.peakNormalize) {
      ctx.results.peakNormalize = { applied: false, inputPeakDbfs: params?.inputPeakDbfs ?? null }
    }
    return
  }

  const outPath = ctx.tmp('.wav')
  await applyLinearGain(ctx.currentPath, outPath, params.gainDb)
  ctx.currentPath = outPath
  ctx.results.peakNormalize = { applied: true, inputPeakDbfs: params.inputPeakDbfs, gainDb: params.gainDb }
  ctx.log(`[peak-norm] ${params.inputPeakDbfs.toFixed(1)} dBFS → ${PEAK_NORMALIZE_TARGET_DBFS} dBFS (${params.gainDb > 0 ? '+' : ''}${params.gainDb.toFixed(1)} dB)`)
}

// Wrapper that pairs analyze + apply for presets. The split versions stay
// exported so a chunked orchestrator can dispatch them independently.
export async function peakNormalize(ctx) {
  await peakNormalizeAnalyze(ctx)
  await peakNormalizeApply(ctx)
  // params are scalar — no cleanup needed.
}

// ── Stage: Frame analysis (pre-HPF) ──────────────────────────────────────────
// Classifies voiced/silence frames, measures noise floor and loudness metrics.
// May run either before peakNormalize (e.g. as a parallel fork alongside
// measureBefore) or after it. When peakNormalize has already run, the gain
// it applied is subtracted from the measured noise floor to recover the
// original pre-processing value for the beforeMeasurements snapshot. When
// peakNormalize has not yet run, gainDb is 0 and metrics.noiseFloorDbfs and
// beforeMeasurements.noiseFloorDbfs both receive the original measured value.

export async function analyzeFramesRaw(ctx) {
  const fa = await analyzeFrames(ctx.currentPath)

  // `??=` here lets analyzeFramesRaw run as a parallel fork alongside
  // measureBefore without either stage clobbering the other's writes.
  ctx.results.metrics ??= {}
  Object.assign(ctx.results.metrics, fa)

  const gainDb = ctx.results.peakNormalize?.gainDb ?? 0
  const originalNoiseFloor = round2(fa.noiseFloorDbfs - gainDb)
  ctx.results.metrics.noiseFloorDbfs = fa.noiseFloorDbfs
  ctx.results.beforeMeasurements ??= {}
  ctx.results.beforeMeasurements.noiseFloorDbfs = originalNoiseFloor
}

// ── Stage: Click remover  ────────────────────────────────────────────
// Detects and
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

// ── Stage: Throat click attenuator ────────────────────────────────────────────
// Detects and attenuates short resonant throat/palate clicks (10–25 ms,
// 1–4 kHz) embedded in voiced speech — distinct from the transient clicks
// click_remover handles. These become audible only after compression and
// normalisation raise quiet detail, so this stage runs late in the chain.
//
// Detection uses LPC prediction error: an AR model fitted on pre-event voiced
// context cannot predict an aperiodic click, producing a normalised error
// spike that survives even when the click is buried in loud speech. The stage
// is VAD-gated — only voiced spans (built from the Silero frame labels in
// ctx.results.metrics.frames) are searched, because the LPC detector needs
// voiced context to fit a meaningful model.

export async function throatClickAttenuate(ctx) {
  const config = ctx.preset.throatClickAttenuator
  if (!config) {
    ctx.log('[throat-click] No throatClickAttenuator config on preset — skipped')
    ctx.results.throatClickAttenuator = { applied: false, reason: 'not configured' }
    return
  }

  // Build voiced spans from contiguous non-silence Silero VAD frames.
  const frames = ctx.results.metrics?.frames
  if (!frames?.length) {
    ctx.log('[throat-click] No VAD frames available — skipped')
    ctx.results.throatClickAttenuator = { applied: false, reason: 'no vad frames' }
    return
  }

  const spans = []
  let runStart = null
  let runEnd   = null
  for (const f of frames) {
    if (!f.isSilence) {
      if (runStart === null) runStart = f.offsetSamples
      runEnd = f.offsetSamples + f.lengthSamples
    } else if (runStart !== null) {
      spans.push([runStart, runEnd])
      runStart = null
    }
  }
  if (runStart !== null) spans.push([runStart, runEnd])

  if (spans.length === 0) {
    ctx.log('[throat-click] No voiced spans — skipped')
    ctx.results.throatClickAttenuator = { applied: false, reason: 'no voiced spans' }
    return
  }

  const spansPath = ctx.tmp('.json')
  await writeFile(spansPath, JSON.stringify(spans))

  const outPath = ctx.tmp('.wav')
  const report  = await runThroatClickAttenuator(ctx.currentPath, outPath, spansPath, {
    sensitivityDb: config.sensitivityDb,
    minEventMs:    config.minEventMs,
    maxEventMs:    config.maxEventMs,
    contextMs:     config.contextMs,
    arOrder:       config.arOrder,
    nrmsThreshold: config.nrmsThreshold,
    envWindowMs:   config.envWindowMs,
    floorWindowMs: config.floorWindowMs,
    attenuationDb: config.attenuationDb,
    attackMs:      config.attackMs,
    releaseMs:     config.releaseMs,
    padMs:         config.padMs,
  })

  ctx.currentPath = outPath
  ctx.results.throatClickAttenuator = {
    applied:           true,
    clicks_detected:   report.clicks_detected   ?? null,
    clicks_attenuated: report.clicks_attenuated ?? null,
    channels:          report.channels          ?? null,
  }
  ctx.log(
    `[throat-click] detected=${report.clicks_detected ?? '?'} ` +
    `attenuated=${report.clicks_attenuated ?? '?'} ` +
    `(voiced spans=${spans.length})`
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
// The 4th-order Butterworth + optional 60 Hz notch is an IIR filter; its
// transient response can overshoot when the input contains strong sub-80 Hz
// energy (rumble, HVAC, DC offset, low plosives). On files arriving near full
// scale — whether from peakNormalize or as-uploaded — the overshoot can push
// the post-HPF peak above 0 dBFS and clip on integer encode downstream. After
// applying the filter we read back the peak from the post-HPF level
// measurement (which already runs for logging) and clamp back to the
// working-level ceiling if it exceeded it. The clamp only fires on the subset
// of files that would otherwise clip; most files pass through unchanged.

const HPF_PEAK_CEILING_DBFS = -1.0

export async function hpf(ctx) {
  // If humDetect already applied a 60 Hz spectral notch (Q=30, −18 dB), skip
  // the coarser heuristic notch in the HPF to avoid double-notching at 60 Hz.
  const humHandled60Hz = ctx.results.humEQ?.notchesApplied?.includes(60) === true
  const notch60Hz      = !humHandled60Hz && detect60HzHum(ctx.results.metrics.noiseFloorDbfs)
  const hpfPath        = ctx.tmp('.wav')
  await applyHighPass(ctx.currentPath, hpfPath, { notch60Hz })
  ctx.currentPath       = hpfPath
  ctx.results.notch60Hz = notch60Hz
  const postPeakDbfs = await measurePeakDbfs(ctx.currentPath)

  if (postPeakDbfs != null && postPeakDbfs > HPF_PEAK_CEILING_DBFS) {
    const gainDb      = HPF_PEAK_CEILING_DBFS - postPeakDbfs
    const clampedPath = ctx.tmp('.wav')
    await applyLinearGain(ctx.currentPath, clampedPath, gainDb)
    ctx.currentPath      = clampedPath
    ctx.results.hpfClamp = {
      applied:      true,
      postPeakDbfs: round2(postPeakDbfs),
      gainDb:       round2(gainDb),
    }
    ctx.log(`[hpf-clamp] post-HPF peak ${postPeakDbfs.toFixed(2)} dBFS → ${HPF_PEAK_CEILING_DBFS.toFixed(1)} dBFS (${gainDb.toFixed(2)} dB)`)
  } else {
    ctx.results.hpfClamp = {
      applied:      false,
      postPeakDbfs: postPeakDbfs != null ? round2(postPeakDbfs) : null,
    }
  }
}

// ── Stage: Spectral Subtraction Pre-Pass ─────────────────────────────────────
// MMSE decision-directed Wiener gain + optional transient shaper. Runs after
// HPF and before the main ML noise reduction (DF3, RNNoise, DTLN) to reduce
// diffuse noise and reverb energy, lowering the problem complexity the ML
// model receives. Skipped when preset.spectralSubtraction is absent or
// preset.spectralSubtraction.enabled is false.

export async function spectralSubtraction(ctx) {
  const config = ctx.preset.spectralSubtraction
  if (!config?.enabled) return

  const params = {
    alphaDd:              config.alphaDd              ?? 0.98,
    beta:                 config.beta                 ?? 0.15,
    strength:             config.strength             ?? 1.0,
    transientShaper:      config.transientShaper      ?? false,
    transientMaxReductionDb: config.transientMaxReductionDb ?? 6.0,
  }

  // Pass Silero VAD frame labels computed by analyzeFramesRaw (which always
  // runs before this stage) to the Python script.  The script maps each STFT
  // frame to the corresponding 25 ms pipeline frame and uses the Silero
  // isSilence label instead of its own energy-based VAD, giving a far more
  // accurate voiced/silence classification with zero re-processing cost.
  let vadLabelsPath = null
  const frames = ctx.results.metrics?.frames
  if (frames?.length > 0) {
    vadLabelsPath = ctx.tmp('.json')
    await writeFile(vadLabelsPath, JSON.stringify(frames.map(f => f.isSilence)))
  }

  const outPath = ctx.tmp('.wav')
  ctx.log(
    `[spectral-sub] Starting: alpha_dd=${params.alphaDd} beta=${params.beta} ` +
    `strength=${params.strength} transient_shaper=${params.transientShaper} ` +
    `vad=${vadLabelsPath ? 'silero' : 'internal'}`
  )
  await runSpectralSubtraction(ctx.currentPath, outPath, params, vadLabelsPath)
  ctx.currentPath = outPath
  ctx.results.spectralSubtraction = { applied: true, ...params }
}

// ── Stage: Noise reduction ────────────────────────────────────────────────────

// Minimum peak drop (in dB) before post-NR peak re-normalization kicks in.
// Below this the drop is within measurement noise and not worth a gain pass.
const NR_MAKEUP_THRESHOLD_DB = 0.3

export async function noiseReduce(ctx) {
  const model         = ctx.preset.noiseReduce?.model ?? 'df3'
  const skipBelowDb   = ctx.preset.noiseReduce?.skipBelowDb ?? null
  const outPath       = ctx.tmp('.wav')
  const preNoiseFloor = ctx.results.metrics.noiseFloorDbfs

  // Per-pass skip: if skipBelowDb is configured and the current noise floor
  // (refreshed by any preceding remeasureFramesPostNr) is already below it,
  // leave the audio untouched. Applies to whichever pass this is — first,
  // second, third, etc. If skipBelowDb is absent, the pass always runs.
  if (
    skipBelowDb !== null
    && preNoiseFloor !== null
    && preNoiseFloor < skipBelowDb
  ) {
    const skipInfo = {
      skipped:           true,
      skipReason:        `noise floor ${preNoiseFloor} dBFS < threshold ${skipBelowDb} dBFS`,
      skipFloorDbfs:     preNoiseFloor,
      skipThresholdDbfs: skipBelowDb,
    }
    ctx.results.noiseReduction = ctx.results.noiseReduction
      ? { ...ctx.results.noiseReduction, ...skipInfo }
      : {
          applied:               false,
          model,
          pre_noise_floor_dbfs:  preNoiseFloor,
          post_noise_floor_dbfs: null,
          ...skipInfo,
        }
    ctx.log(
      `[NR] Pass skipped — noise floor ${preNoiseFloor} dBFS already below ` +
      `${skipBelowDb} dBFS threshold`
    )
    return
  }

  const tNr = Date.now()

  let runMs           = 0
  let pythonTimingMs  = null   // {load, resample_in, denoise, vad_gate, resample_out, write, sidecar, total} when present

  if (model === 'rnnoise') {
    // Pass the pipeline's Silero VAD labels through to the RNNoise script so
    // its diagnostic dump can verify the 25 ms → 10 ms alignment and so the
    // VAD-disagreement gate (opt-in via preset config) can override RNNoise's
    // internal VAD on fricative onsets it misclassifies as noise.
    const sileroFrames = ctx.results.metrics?.frames ?? null
    const vadGate      = ctx.preset.noiseReduce?.vadGate ?? null
    const tRun = Date.now()
    const rnnInfo = await runRnnoise(ctx.currentPath, outPath, {
      sileroFrames,
      vadGate,
    })
    runMs = Date.now() - tRun
    pythonTimingMs = rnnInfo?.timingMs ?? null
    ctx.currentPath = outPath
    ctx.results.noiseReduction = {
      applied: true,
      model: 'RNNoise',
      atten_lim_db: null,
      pre_noise_floor_dbfs: preNoiseFloor,
      post_noise_floor_dbfs: null,
    }
    if (rnnInfo?.vadGate) {
      ctx.results.noiseReduction.vad_gate = rnnInfo.vadGate
    }
    if (rnnInfo?.speechProbOut) {
      ctx.log(`[NR] RNNoise speech_prob sidecar → ${rnnInfo.speechProbOut}`)
    }
  } else if (model === 'dtln') {
    const tRun = Date.now()
    await runDtln(ctx.currentPath, outPath)
    runMs = Date.now() - tRun
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
    const tRun = Date.now()
    const nrResult = await applyNoiseReduction(ctx.currentPath, outPath)
    runMs = Date.now() - tRun
    pythonTimingMs = nrResult?.timingMs ?? null
    nrResult.pre_noise_floor_dbfs = preNoiseFloor
    ctx.currentPath = outPath
    ctx.results.noiseReduction = nrResult
  }

  // ── Peak re-normalization: restore level lost to spectral masking ──────────
  // Replaces the former voiced-RMS makeup gain (2 × remeasureFrames file reads).
  // peakNormalize already ran before the NR block so the incoming peak is at
  // PEAK_NORMALIZE_TARGET_DBFS; any drop after NR is collateral spectral masking
  // attenuation. Restoring the peak is cheaper and adequate for the common case
  // where the loudest post-NR sample is voiced speech.
  let appliedGainDb = 0
  let peakMeasureMs = 0
  let gainApplyMs   = 0

  const tPeak    = Date.now()
  const postPeak = await measurePeakDbfs(ctx.currentPath)
  peakMeasureMs  = Date.now() - tPeak

  if (postPeak !== null) {
    const gainDb = PEAK_NORMALIZE_TARGET_DBFS - postPeak
    if (gainDb > NR_MAKEUP_THRESHOLD_DB) {
      const gainedPath = ctx.tmp('.wav')
      const tGain = Date.now()
      await applyLinearGain(ctx.currentPath, gainedPath, gainDb)
      gainApplyMs     = Date.now() - tGain
      ctx.currentPath = gainedPath
      appliedGainDb   = gainDb
      ctx.results.noiseReduction.makeupGainDb = round2(gainDb)
      ctx.log(
        `[NR] Peak re-norm: +${gainDb.toFixed(2)} dB ` +
        `(post-NR peak ${postPeak.toFixed(1)} → ${PEAK_NORMALIZE_TARGET_DBFS} dBFS)`
      )
    } else {
      ctx.results.noiseReduction.makeupGainDb = 0
      ctx.log(
        `[NR] Peak re-norm skipped — post-NR peak ${postPeak.toFixed(1)} dBFS, ` +
        `drop ${(PEAK_NORMALIZE_TARGET_DBFS - postPeak).toFixed(2)} dB ≤ ${NR_MAKEUP_THRESHOLD_DB} dB threshold`
      )
    }
  }

  // Propagate the post-NR noise floor into ctx.results.metrics so any
  // downstream skipBelowDb check on a subsequent NR pass reads a current value.
  // DF3 reports post_noise_floor_dbfs from the Python script; adjust it for the
  // re-norm gain and promote it. RNNoise/DTLN don't report a floor — the metrics
  // value stays at the pre-NR reading; remeasureFramesPostNr (placed in the
  // preset stages array after the full NR block) will refresh all metrics from
  // the actual audio.
  if (model === 'df3') {
    const reportedFloor = ctx.results.noiseReduction?.post_noise_floor_dbfs ?? null
    if (reportedFloor !== null) {
      const adjustedFloor = round2(reportedFloor + appliedGainDb)
      ctx.results.metrics.noiseFloorDbfs = adjustedFloor
      ctx.results.noiseReduction.post_noise_floor_dbfs = adjustedFloor
    }
  }

  // Sub-stage timing breakdown. JS-side buckets tell us whether the codec
  // call (run) or the harness (peak measure + optional gain apply) dominates;
  // the Python-side bucket array (when present) breaks the run bucket down
  // further into load / resample / denoise / vad_gate / resample_out / write.
  // harnessMs is the sum of the JS-only passes around the codec call.
  const totalMs   = Date.now() - tNr
  const harnessMs = peakMeasureMs + gainApplyMs
  let timingLine =
    `[NR-timing] model=${model} total=${totalMs}ms ` +
    `run=${runMs}ms harness=${harnessMs}ms ` +
    `(peakMeasure=${peakMeasureMs}ms gainApply=${gainApplyMs}ms)`
  if (pythonTimingMs && typeof pythonTimingMs === 'object') {
    const py = pythonTimingMs
    // Only surface buckets that fired; vad_gate/sidecar are conditional.
    const parts = []
    for (const key of ['load','resample_in','denoise','vad_gate','resample_out','write','sidecar']) {
      const v = py[key]
      if (typeof v === 'number' && v > 0) parts.push(`${key}=${Math.round(v)}ms`)
    }
    const pyTotal = typeof py.total === 'number' ? `${Math.round(py.total)}ms` : '?'
    timingLine += `  py=${pyTotal} {${parts.join(' ')}}`
  }
  ctx.log(timingLine)
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
}

// ── Stage: Room tone padding (ACX Audiobook only) ─────────────────────────────

export async function roomTonePad(ctx) {
  const paddedPath = ctx.tmp('.wav')
  const result     = await applyRoomTonePadding(ctx.currentPath, paddedPath, ctx.results.metrics)
  ctx.currentPath        = paddedPath
  ctx.results.roomTonePad = result
}

// ── Stage: Corrective EQ (Stage 3a) ───────────────────────────────────────────
// Replaces the v3.1 Enhancement EQ. Detects localised spectral anomalies in the
// whole-file average voiced-frame envelope and applies adaptive parametric EQ
// with measured center frequencies, Q, and severity-proportional gains.
// Does not run for noise_eraser — source separation alters the spectral
// structure, so the cepstral detection thresholds are not valid on its output.

// Analyze pair (correctiveEQAnalyze / correctiveEQApply):
//   Analyze produces the final EQ band list. For acx output profile it runs
//   the noise-floor backoff analytically — predicting the post-EQ lift from
//   the band cascade response and the silence-frame noise PSD — so analyze
//   does no audio I/O. Apply then runs a single parametric EQ pass with the
//   converged bands. analyze=bands, apply=EQ filter.

export async function correctiveEQAnalyze(ctx) {
  if (ctx.presetId === 'noise_eraser') {
    const skip = {
      applied: false,
      skipped: true,
      reason:  'noise_eraser preset — Stage 3a does not run on separated audio',
    }
    ctx.globalParams.correctiveEQ = skip
    ctx.results.correctiveEQ = skip
    return
  }

  const result = await analyzeCorrectiveEQ(ctx)
  let bands = result.bands ?? []

  // ACX noise floor constraint: a low-frequency boost (body_warmth) can lift
  // the measured noise floor above the -60 dBFS ACX ceiling. Predict the lift
  // analytically from the band cascade's digital-biquad response weighted by
  // the silence-frame noise PSD (pink-1/f fallback when too few silence frames
  // are available), then solve once for the smallest uniform reduction across
  // LF boost bands that keeps the predicted post-EQ floor inside the ceiling.
  // The apply pass moves entirely to correctiveEQApply.
  const isLowFreqBoost = b => b.gain_db > 0 && b.freq_hz <= 400
  if (ctx.outputProfileId === 'acx' && bands.some(isLowFreqBoost)) {
    const targetDb      = ctx.outputProfile?.noiseFloorCeiling ?? -60
    // Measure scalar floor + PSD off the current audio in one pass so the
    // headroom math (target - pre) and the lift prediction describe the same
    // silence-frame population. The ctx scalar (potentially several stages
    // stale) is only the fallback when the local measurement is unavailable.
    const measured      = await measureNoiseFloorPsd(ctx.currentPath, ctx.results.metrics?.frames)
    const psd           = measured ?? pinkPsdFallback()
    const noiseFloorPre = measured?.noiseFloorDbfs ?? ctx.results.metrics?.noiseFloorDbfs
    if (noiseFloorPre != null) {
      const solve = solveAcxLfBoostReductionDb(
        bands, noiseFloorPre, targetDb, psd, isLowFreqBoost,
      )
      bands = solve.bands.map(b => ({ ...b, gain_db: round2(b.gain_db) }))
      result.acx_lift_predicted_db = round2(solve.predictedLiftDb)
      result.acx_psd_source        = psd.source
      if (solve.reductionDb > 0) {
        result.acxNoiseFloorReductionDb = round2(solve.reductionDb)
      }
      if (solve.exhausted) {
        result.acx_unresolved = true
        ctx.log(
          `[correctiveEQ] ACX backoff exhausted — predicted lift ` +
          `${solve.predictedLiftDb.toFixed(2)} dB still exceeds headroom ` +
          `(pre ${noiseFloorPre} dBFS, target ${targetDb} dBFS, psd=${psd.source})`,
        )
      } else if (solve.reductionDb > 0) {
        ctx.log(
          `[correctiveEQ] ACX backoff: LF boosts reduced by ` +
          `${solve.reductionDb.toFixed(2)} dB ` +
          `(predicted lift ${solve.predictedLiftDb.toFixed(2)} dB, ` +
          `pre ${noiseFloorPre} dBFS, target ${targetDb} dBFS, psd=${psd.source})`,
        )
      }
    }
  }

  result.bands        = bands
  result.applied      = bands.length > 0
  result.ffmpegFilter = bandsToFfmpegFilters(bands).join(',') || null
  ctx.globalParams.correctiveEQ = { bands, applied: result.applied }
  ctx.results.correctiveEQ = result
}

export async function correctiveEQApply(ctx) {
  const params = ctx.globalParams.correctiveEQ
  if (!params || !params.applied || !params.bands?.length) {
    return
  }
  const eqPath = ctx.tmp('.wav')
  await applyParametricEQ(ctx.currentPath, eqPath, bandsToFfmpegFilters(params.bands))
  ctx.currentPath = eqPath
}

export async function correctiveEQ(ctx) {
  await correctiveEQAnalyze(ctx)
  await correctiveEQApply(ctx)
  // bands array is small (~handful of objects) — no cleanup needed.
}

// ── Stage: referenceEQ ────────────────────────────────────────────────────────
// Corpus-reference broad tonal correction. Runs after the final correctiveEQ:
// 3a fixes localised anomalies, referenceEQ fixes broad tonal imbalance via a
// smooth linear-phase FIR matched toward a per-preset corpus curve.
//
// Skips for noise_eraser (source separation invalidates corpus comparison) and
// skips cleanly when no reference curve file exists for the preset, so the
// stage is safe to wire in before the corpus is sourced.
//
// ACX: a sub-500 Hz boost can lift the noise floor above the -60 dBFS ceiling.
// The Python side runs an analytic LF-cap solve (bisection over the predicted
// lift against the silence-frame noise PSD) so the FIR is built exactly once.

const REFERENCE_EQ_LF_CAP_START_DB = 2.0

export async function referenceEQ(ctx) {
  if (ctx.presetId === 'noise_eraser') {
    ctx.results.referenceEQ = {
      applied: false,
      skipped: true,
      reason:  'noise_eraser preset — referenceEQ does not run on separated audio',
    }
    return
  }

  const curvePath = await getReferenceCurvePath(ctx.presetId)
  if (!curvePath) {
    ctx.log(`[referenceEQ] no reference curve for preset "${ctx.presetId}" — skipped`)
    ctx.results.referenceEQ = {
      applied: false,
      skipped: true,
      reason:  'no reference curve available for preset',
    }
    return
  }

  // For ACX, supply the Python solver with the current silence-frame noise PSD
  // and the post-EQ ceiling. The script bisects the sub-500 Hz boost cap
  // analytically — no JS-side apply+remeasure retries. The local scalar floor
  // co-measured with the PSD is passed via --noise-floor so the script's
  // headroom math sees the same silence population as the lift prediction;
  // the ctx scalar is only the fallback when the local measurement is missing.
  const passOpts = {}
  let psdPath = null
  if (ctx.outputProfileId === 'acx') {
    const targetDb = ctx.outputProfile?.noiseFloorCeiling ?? -60
    const measured = await measureNoiseFloorPsd(ctx.currentPath, ctx.results.metrics?.frames)
    const psd      = measured ?? pinkPsdFallback()
    psdPath = ctx.tmp('.json')
    await writeFile(psdPath, JSON.stringify(serializePsd(psd)))
    passOpts.noisePsdPath          = psdPath
    passOpts.acxTargetNoiseFloorDb = targetDb
    if (measured?.noiseFloorDbfs != null) {
      passOpts.noiseFloorDb = measured.noiseFloorDbfs
    }
  }

  let result, outputPath
  try {
    ({ result, outputPath } = await runReferenceEQPass(
      ctx, curvePath, REFERENCE_EQ_LF_CAP_START_DB, passOpts,
    ))
  } finally {
    if (psdPath) await rm(psdPath, { force: true })
  }

  // Surface the analytic backoff as acxNoiseFloorReductionDb for parity with
  // the correctiveEQ result key the UI / report consumers already read.
  const backoff = result.acx_backoff
  if (backoff) {
    const reductionDb = backoff.requested_lf_max_boost_db - backoff.applied_lf_max_boost_db
    if (reductionDb > 0) result.acxNoiseFloorReductionDb = round2(reductionDb)
    if (backoff.exhausted) result.acx_unresolved = true
    ctx.log(
      `[referenceEQ] ACX backoff: LF cap ${backoff.requested_lf_max_boost_db} → ` +
      `${backoff.applied_lf_max_boost_db} dB ` +
      `(predicted lift ${backoff.predicted_lift_db} dB, headroom ${backoff.headroom_db} dB, ` +
      `psd=${backoff.psd_source}${backoff.exhausted ? ', exhausted' : ''})`,
    )
  }

  if (result.applied && outputPath) ctx.currentPath = outputPath
  ctx.results.referenceEQ = result
}

// ── Stage: Resonance Suppressor ───────────────────────────────────────────────
// Soothe2-inspired dynamic spectral resonance suppressor. In STANDARD_PIPELINE
// it runs immediately before correctiveEQ (and before normalize). Only included
// in STANDARD_PIPELINE — excluded from noise_eraser and clearervoice_eraser by
// pipeline omission.

export async function resonanceSuppressor(ctx) {
  const outPath = ctx.tmp('.wav')
  const frames  = ctx.results.metrics?.frames ?? null

  // Per-frame F0 contour. getF0Contour() defaults to a fresh analysis on every
  // call so that each suppressor pass works against the actual signal at that
  // point in the chain. The result is cached on ctx._f0Contour and reused
  // below when analyzing sibilance events — no second autocorrelation pass.
  const f0Contour = await getF0Contour(ctx)

  // Sibilance event map — only needed when at least one resonanceSuppressor
  // pass is configured with sibilant_only: true. Each sibilant_only pass
  // owns its own detection parameters via `pass.sibilanceDetection`. The
  // Python suppressor accepts a single --events-json shared across all
  // passes, so if multiple sibilant_only passes are configured they must
  // agree on their detection params — otherwise the later passes would be
  // gated using a map generated for the wrong thresholds.
  const passConfigs = Array.isArray(ctx.preset?.resonanceSuppressor)
    ? ctx.preset.resonanceSuppressor
    : (ctx.preset?.resonanceSuppressor ? [ctx.preset.resonanceSuppressor] : [])
  const sibilantPasses = passConfigs.filter(p => p?.sibilant_only)
  let eventsPath = null

  if (sibilantPasses.length === 0) {
    ctx.log('[resonanceSuppressor] No sibilant_only passes configured — skipping sibilance detection')
  } else {
    if (sibilantPasses.length > 1) {
      const first = JSON.stringify(sibilantPasses[0].sibilanceDetection ?? null)
      for (let i = 1; i < sibilantPasses.length; i++) {
        const other = JSON.stringify(sibilantPasses[i].sibilanceDetection ?? null)
        if (other !== first) {
          throw new Error(
            `[resonanceSuppressor] preset=${ctx.presetId}: multiple sibilant_only ` +
            `passes have differing sibilanceDetection params (pass 0 vs pass ${i}). ` +
            `All sibilant_only passes in a single resonanceSuppressor block must ` +
            `share identical detection params — the Python script only accepts a ` +
            `single --events-json, so differing params would mis-gate later passes.`,
          )
        }
      }
    }

    // Fast mode: when no custom sibilanceDetection params are set, reuse the
    // event windows already produced by clipGainDeEsser rather than spawning
    // a fresh detection pass. Consistency is enforced above, so checking
    // pass 0 is sufficient to determine whether all passes use defaults.
    const hasCustomParams    = sibilantPasses[0].sibilanceDetection != null
    const upstreamEventsPath = !hasCustomParams && ctx.results.clipGainDeEsser?.applied
      ? (ctx.results.clipGainDeEsser.eventsPath ?? null)
      : null

    if (upstreamEventsPath) {
      eventsPath = upstreamEventsPath
      ctx.log(`[resonanceSuppressor] Fast mode: reusing clipGainDeEsser events (${upstreamEventsPath})`)
    } else {
      const sibResult = await analyzeSibilanceEvents(ctx, {
        params:    sibilantPasses[0].sibilanceDetection,
        f0Contour,
      })
      eventsPath = sibResult?.path ?? null
    }
  }

  const result = await applyResonanceSuppression(ctx.currentPath, outPath, ctx.preset, frames, f0Contour, eventsPath)
  if (result.applied) ctx.currentPath = outPath
  ctx.results.resonanceSuppressor = result
}


// ── Stage: Breath Reducer (Stage 4c) ──────────────────────────────────────────
// Detects breath events in unvoiced regions (moderate RMS, high ZCR, high
// spectral flatness) and applies a smooth wideband gain reduction envelope.
// Runs after secondary NR so the signal is as clean as possible for detection;
// runs before parallelCompress so the parallel compressor does not pump on
// breath transients. Skips silently when preset.breathReducer is absent.

export async function breathReduce(ctx) {
  const config = ctx.preset?.breathReducer
  if (!config) {
    ctx.results.breathReducer = { applied: false, reason: 'not configured' }
    return
  }

  const outPath = ctx.tmp('.wav')
  const frames  = ctx.results.metrics?.frames ?? null
  const result  = await applyBreathReduction(ctx.currentPath, outPath, ctx.preset, frames)
  if (result.applied) ctx.currentPath = outPath
  ctx.results.breathReducer = result
  ctx.log(
    result.applied
      ? `[BreathReducer] ${result.breath_events} event(s) reduced by up to ${result.max_reduction_db}dB`
      : '[BreathReducer] no breath events detected — skipped'
  )
}


// ── Stage: Air Boost (Stage 3b) ───────────────────────────────────────────────
// Wide high-frequency shelf lift modeled on the Maag EQ4 Air Band (10 kHz
// corner). Skips silently when preset.airBoost.gainDb is 0 or negative.
// For ACX output profiles, a noise floor pre/post check constrains the applied
// gain to preserve the -60 dBFS ACX ceiling.
//
// Sibilant masking: when sibilantGainFloor < 1.0, the boost is blended back
// toward the original signal on sibilant frames. Event boundaries are reused
// from an upstream clipGainDeEsser result (ctx.results.clipGainDeEsser.eventsPath)
// when available — the same pattern used by parallelCompress's wet-branch
// de-esser. De novo detection runs only as a fallback. air_boost_masked.py reads
// sibilantFrameIndices, which are frame-domain and stable across a pitch-neutral
// EQ transformation.
//
// Analyze/Apply split: airBoostAnalyze determines filter parameters (including
// the ACX compliance loop) and resolves sibilant events; airBoostApply applies
// the already-written EQ output and runs the mask blend. The combined airBoost
// wrapper handles the sequential case with no extra FFmpeg pass.

// STFT hop length used by air_boost_masked.py (and the upstream sibilance
// detector that writes the events JSON consumed here). Kept in sync with
// HOP_LENGTH in server/scripts/air_boost_masked.py — if either side changes,
// update both.
const AIR_BOOST_MASK_HOP = 512

export async function airBoostAnalyze(ctx) {
  // Config may live under either key:
  //   - `airBoostAnalyze` when the preset uses the split analyze/apply form
  //     (analyze runs whole-file before a chunked block containing apply).
  //   - `airBoost` when the preset uses the combined stage entry, or when
  //     invoked from the combined `airBoost(ctx)` wrapper below.
  // Inline-config dispatch patches ctx.preset[configKey] for the duration of
  // the stage call, so whichever form the preset declares lands here.
  const airBoostConfig    = ctx.preset?.airBoostAnalyze ?? ctx.preset?.airBoost ?? {}
  const gainDb            = airBoostConfig.gainDb            ?? 0
  const sibilantGainFloor = airBoostConfig.sibilantGainFloor ?? 1.0
  const attackMs          = airBoostConfig.sibilantAttackMs  ?? 5.0
  const releaseMs         = airBoostConfig.sibilantReleaseMs ?? 20.0
  // Frequency-selective mask. 4500 Hz default sits at the Maag shelf's -3 dB
  // knee so the 600/1200/2400/4800 Hz bells stay active on sibilant frames
  // and only the 9.6 kHz bell + 14 kHz shelf attenuate. 1.0-octave taper
  // keeps the transition smooth on the log axis. Both are surfaced through
  // the preset config so a preset can widen/narrow the masked band if
  // needed; defaults are sensible enough that no current preset overrides
  // them.
  const maskCutoffHz      = airBoostConfig.maskCutoffHz      ?? 4500.0
  const maskTransitionOct = airBoostConfig.maskTransitionOct ?? 1.0

  const originalPath  = ctx.currentPath
  const resolvedOutputPath = ctx.tmp('.wav')

  const params = await computeAirBoostParams(
    originalPath,
    resolvedOutputPath,
    gainDb,
    ctx.outputProfileId,
    ctx.results.metrics,
    { presetId: ctx.presetId, precutConfig: airBoostConfig.precut },
  )

  // Resolve sibilant event boundaries. clipGainDeEsser runs before airBoost in
  // every active preset that enables masking, so its eventsPath is the primary
  // source. air_boost_masked.py reads sibilantFrameIndices — frame-domain data
  // that is stable across the pitch-neutral EQ transformation — so the
  // pre-boost boundaries are correct. Fall back to de novo detection only when
  // no upstream events exist (e.g. clipGainDeEsser found no events or was
  // absent from the preset).
  let eventsPath   = null
  let eventsSource = null

  if (params.applied && sibilantGainFloor < 1.0) {
    // Reuse clipGainDeEsser's sibilance event map whenever it DETECTED events,
    // regardless of whether it went on to apply any gain reduction. The mask
    // only needs to know WHERE the sibilants are; that is independent of
    // whether the de-esser's reduction ceiling was exceeded. clipGainDeEsserApply
    // sets ctx.results.clipGainDeEsser.eventsPath whenever detection found
    // events, even when its own `applied` flag is false (events all sat below
    // the reduction ceiling — common for clean narrators).
    //
    // Gating on `.applied` here was a bug: on a file with detectable but
    // sub-ceiling sibilance, the de-esser reports applied=false, the upstream
    // map was discarded, and airBoost fell through to de novo detection —
    // exactly the fallback this block is meant to avoid (see comment above).
    const upstreamEventsPath = ctx.results.clipGainDeEsser?.eventsPath ?? null
    const upstreamEventCount = ctx.results.clipGainDeEsser?.eventCount ?? null

    if (upstreamEventsPath) {
      eventsPath   = upstreamEventsPath
      eventsSource = 'upstream'
      console.log(
        `[AirBoost] mask enabled (floor=${sibilantGainFloor.toFixed(2)} ` +
        `attack=${attackMs}ms release=${releaseMs}ms ` +
        `cutoff=${maskCutoffHz.toFixed(0)}Hz transition=${maskTransitionOct.toFixed(2)}oct) ` +
        `— reusing upstream clipGainDeEsser events ` +
        `(events=${upstreamEventCount ?? '?'}, path=${upstreamEventsPath})`
      )
    } else {
      // Fallback: de novo detection on the PRE-boost signal. ctx.currentPath is
      // still originalPath here, which is exactly what we detect on.
      //
      // Detection MUST run on the pre-boost audio, not on resolvedOutputPath.
      // The air boost adds a high-frequency shelf inside the 2.5–12 kHz band
      // that the sibilance detector measures, so detecting on the boosted
      // output lets the boost inflate its own detection input — borderline
      // frames cross the p95 trigger and spawn phantom sibilant events that do
      // not exist in the source. With sibilantGainFloor < 1.0 the mask then
      // strips the boost off those falsely-flagged frames, so the air shelf
      // disappears from the continuous (non-sibilant) signal path and survives
      // only on genuinely sibilant frames. The effect scales with gainDb.
      //
      // Sibilant frame POSITIONS are identical pre/post boost (the EQ is
      // time-invariant and pitch-neutral), so pre-boost detection yields the
      // correct mask targets. This also matches the upstream clipGainDeEsser
      // path above, whose pre-boost boundaries are documented as correct.
      console.log(
        `[AirBoost] mask enabled (floor=${sibilantGainFloor.toFixed(2)} ` +
        `attack=${attackMs}ms release=${releaseMs}ms ` +
        `cutoff=${maskCutoffHz.toFixed(0)}Hz transition=${maskTransitionOct.toFixed(2)}oct) ` +
        `— no upstream events available, running de novo sibilance detection`
      )
      const f0Contour = await getF0Contour(ctx, { useCache: true })
      const sibResult = await analyzeSibilanceEvents(ctx, {
        params:    airBoostConfig.sibilanceDetection,
        f0Contour,
      })
      eventsPath   = sibResult?.path ?? null
      eventsSource = 'denovo'
    }
  } else if (params.applied) {
    console.log(
      `[AirBoost] mask disabled (sibilantGainFloor=${sibilantGainFloor.toFixed(2)}) — ` +
      `applying ${params.applied_gain_db ?? params.requested_gain_db ?? gainDb} dB ` +
      `boost on the continuous signal path`
    )
  }

  ctx.globalParams.airBoost = {
    params,
    resolvedOutputPath,
    originalPath,
    eventsPath,
    eventsSource,
    sibilantGainFloor,
    attackMs,
    releaseMs,
    maskCutoffHz,
    maskTransitionOct,
  }
}

export async function airBoostApply(ctx) {
  const gp = ctx.globalParams.airBoost
  if (!gp) return

  const { params, resolvedOutputPath, originalPath, eventsPath, eventsSource,
          sibilantGainFloor, attackMs, releaseMs,
          maskCutoffHz, maskTransitionOct } = gp

  if (!params.applied) {
    ctx.results.airBoost = params
    return
  }

  // Surface the post-compliance EQ params so logs identify the exact filter
  // FFmpeg was instructed to apply. Lets a spectrum-curve check on
  // boostedPath be reconciled against the requested band gains without
  // grepping the report JSON. Compact one-liner — the bands array is small
  // (5 bells + 1 shelf, optional precut).
  const bandSummary = (params.bands ?? []).map(b => {
    const w = b.type === 'bell' ? `Q=${b.q}` : `${b.width_oct}oct`
    return `${b.f_hz}Hz/${b.type}/${w}/${b.gain_db.toFixed(2)}dB`
  }).join(' ')
  const precutSummary = params.pre_attenuation
    ? ` | precut=${params.pre_attenuation.f_hz}Hz/Q=${params.pre_attenuation.q}/${params.pre_attenuation.gain_db.toFixed(2)}dB`
    : ''
  console.log(
    `[AirBoost] applied_gain_db=${params.applied_gain_db} ` +
    `requested=${params.requested_gain_db} ` +
    `acx_constrained=${params.acx_constrained === true}` +
    precutSummary +
    ` | bands: ${bandSummary}`
  )

  // Two dispatch modes for the EQ application:
  //   Sequential — analyze ran whole-file and computeAirBoostParams already
  //     wrote the boosted whole-file output to resolvedOutputPath. Reuse it.
  //   Chunked    — analyze ran whole-file (in a separate preset entry above
  //     the chunked block) and resolvedOutputPath is the whole-file EQ output
  //     which doesn't match this chunk's carved input. Re-apply the analyze's
  //     final band params to the chunk's pre-boost audio via applyAirBoostBands
  //     so every chunk inherits the file-level compliance loop's decisions.
  // The subContext field chunkCarveStartSamples doubles as the chunked-mode
  // signal: createSubContext sets it on every chunked subCtx, parents leave it
  // undefined.
  const inChunked = ctx.chunkCarveStartSamples !== undefined
  let chunkInputPath
  let boostedPath
  if (inChunked) {
    chunkInputPath = ctx.currentPath
    boostedPath    = ctx.tmp('.wav')
    await applyAirBoostBands(chunkInputPath, boostedPath, params)
  } else {
    chunkInputPath = originalPath
    boostedPath    = resolvedOutputPath
  }
  ctx.currentPath = boostedPath

  if (eventsPath && sibilantGainFloor < 1.0) {
    // Chunked mode: shift whole-file sibilance frame indices into chunk-local
    // coordinates so the per-frame envelope built by air_boost_masked.py
    // aligns with this chunk's STFT frames. Sequential mode leaves the
    // sub-ctx field undefined → frameOffset = 0 → no-op shift.
    const carveStartSamples = ctx.chunkCarveStartSamples ?? 0
    const frameOffset       = Math.floor(carveStartSamples / AIR_BOOST_MASK_HOP)

    const maskedPath = ctx.tmp('.wav')
    await applyAirBoostMask(
      chunkInputPath, boostedPath, eventsPath, maskedPath,
      sibilantGainFloor, attackMs, releaseMs, frameOffset,
      maskCutoffHz, maskTransitionOct,
    )
    ctx.currentPath = maskedPath
    params.sibilantMask = {
      applied: true, gainFloor: sibilantGainFloor, attackMs, releaseMs,
      maskCutoffHz, maskTransitionOct,
      eventsSource, eventsPath, frameOffset,
    }
  } else {
    // Surface the mask state even when it didn't run, so the per-stage report
    // records WHY. `disabled` = preset has sibilantGainFloor >= 1.0 (the
    // mask is a no-op by design). `no_events_available` = mask was requested
    // but neither upstream nor de novo detection produced an events file
    // (e.g. detection returned zero events). Either way the boost on the
    // continuous signal path is unmasked, which is the same code path the
    // disabled-mask preset runs and matches the EQ shape in the bands report.
    const reason = sibilantGainFloor >= 1.0 ? 'disabled' : 'no_events_available'
    params.sibilantMask = { applied: false, reason, gainFloor: sibilantGainFloor }
  }

  ctx.results.airBoost = params
}

export async function airBoost(ctx) {
  await airBoostAnalyze(ctx)
  await airBoostApply(ctx)
  ctx.globalParams.airBoost = null
}

// ── Stage: De-esser ───────────────────────────────────────────────────────────

export async function deEss(ctx) {
  // The de-esser owns its own F0 estimation and sibilance analysis. It does
  // not consume the shared sibilance event map — its detection runs on the
  // current (post-EQ) audio and its frequency targets are derived per call.
  const deEssPath   = ctx.tmp('.wav')
  const deEssResult = await analyzeAndDeEss(
    ctx.currentPath,
    deEssPath,
    ctx.preset,
    ctx.results.metrics,
    null,
  )
  ctx.currentPath   = deEssPath
  ctx.results.deEss = deEssResult
}

// ── Stage: Clip-Gain De-esser ─────────────────────────────────────────────────
// Alternative to the compressor-based de-esser. Two passes:
//   1. Sibilance detection with min_duration_ms set so brief consonant stops
//      and click residuals are filtered out before any gain is calculated.
//   2. Per-event gain reduction relative to the surrounding voiced RMS,
//      rendered as a cosine fade envelope and applied in a single vectorised
//      multiply.
//
// Skips silently when preset.clipGainDeEsser is absent or .enabled is false,
// or when the detector returns no events that survive the duration filter.

// Analyze pair (clipGainDeEsserAnalyze / clipGainDeEsserApply):
//   Analyze runs sibilance detection and writes an events.json file path
//   plus the config + frame labels into globalParams. Apply consumes them
//   to render the cosine-fade gain envelope. Both halves were already
//   separable in the underlying modules — this just exposes the seam at
//   the registry level so chunked workers can run apply per chunk while
//   detection runs once on the whole file.

export async function clipGainDeEsserAnalyze(ctx) {
  // Config may live under either key:
  //   - `clipGainDeEsserAnalyze` when the preset uses the split analyze/apply
  //     form (config on the analyze entry, apply as a bare string).
  //   - `clipGainDeEsser` when the preset uses the combined stage entry, or
  //     when invoked from the combined `clipGainDeEsser(ctx)` wrapper below.
  // Inline-config dispatch patches ctx.preset[configKey] for the duration of
  // the stage call, so whichever form the preset declares lands here.
  const config = ctx.preset?.clipGainDeEsserAnalyze ?? ctx.preset?.clipGainDeEsser
  if (!config || config.enabled === false) {
    const skip = { applied: false, reason: 'preset_not_configured' }
    ctx.globalParams.clipGainDeEsser = skip
    ctx.results.clipGainDeEsser = skip
    return
  }

  const minDurationMs = config.minDurationMs ?? 25

  // Detection runs on the pre-compression signal — per the spec, this stage
  // sits before the pre-compression remeasurement. Stages that further shape
  // sibilants (airBoost, correctiveEQ) come AFTER this point in
  // STANDARD_PIPELINE, so any HF lift they apply does not feed back into
  // the gain calculation here; the de-essed result still passes through them
  // downstream.
  //
  // F0 contour: we don't call getF0Contour() here. The sibilance analyzer
  // computes F0 internally on its already-loaded audio array (one WAV read
  // + one IPC trip saved vs. running estimate_f0_contour.py separately).
  // The returned event map exposes that raw per-frame contour as
  // `events.inputF0Contour`, which we stash on ctx._f0Contour below —
  // that's the cache airBoost's `getF0Contour(ctx, { useCache: true })`
  // hit relied on previously. (Not `events.f0` — that's the detector's
  // rolling band-median values, see the seeding block for details.)

  // Merge the preset's sibilance detection block (if any) with the
  // min_duration_ms override the clip-gain stage requires.
  const detectionParams = {
    ...(config.sibilanceDetection ?? {}),
    min_duration_ms: minDurationMs,
  }

  const { events, path: eventsPath } = await analyzeSibilanceEvents(ctx, {
    params: detectionParams,
  })

  // Seed the F0 cache from the events output so downstream stages that opt
  // into the cache (airBoost) hit without spawning estimate_f0_contour.py.
  // We use `events.inputF0Contour` — the raw per-frame contour the analyzer
  // computed before passing into the detector — rather than `events.f0`,
  // because the latter contains the detector's band-median values (rolling,
  // slow-moving) which are a different quantity than the per-frame
  // estimates getF0Contour() normally yields. Shape matches getF0Contour() —
  // see f0Analysis.js docstring.
  if (events?.inputF0Contour) {
    ctx._f0Contour = events.inputF0Contour
  }

  if (!events?.events?.length) {
    const skip = { applied: false, reason: 'no_events', eventCount: 0 }
    ctx.globalParams.clipGainDeEsser = skip
    ctx.results.clipGainDeEsser = skip
    ctx.log(`[clip-gain-deess] No events ≥ ${minDurationMs}ms detected — skipped`)
    return
  }

  // Snapshot everything apply needs. The frame labels carry through here so
  // apply doesn't have to reach into ctx.results.metrics — keeps the contract
  // explicit and chunking-friendly.
  ctx.globalParams.clipGainDeEsser = {
    applied: true,
    eventsPath,
    config,
    frames:  ctx.results.metrics?.frames ?? null,
  }
}

export async function clipGainDeEsserApply(ctx) {
  const params = ctx.globalParams.clipGainDeEsser
  if (!params || !params.applied) {
    return
  }

  const outPath = ctx.tmp('.wav')
  const result  = await applyClipGainDeEsser(
    ctx.currentPath,
    outPath,
    params.eventsPath,
    params.config,
    params.frames,
  )

  if (result.applied) ctx.currentPath = outPath
  // Surface eventsPath on the report so downstream stages (parallelCompress's
  // wet-branch de-esser pass) can reuse the same event boundaries without
  // re-running detection.
  ctx.results.clipGainDeEsser = { ...result, eventsPath: params.eventsPath }

  // Drop the analyze-stage bundle now that apply has consumed it. The frames
  // array is the heavy field (~one entry per 25 ms frame, ~144k entries/hour);
  // releasing it here means the split-form preset path matches the combined
  // wrapper's lifetime guarantee without relying on the wrapper. eventsPath
  // is already preserved on ctx.results.clipGainDeEsser for the only
  // downstream consumer (parallelCompression's wet-branch de-esser pass).
  ctx.globalParams.clipGainDeEsser = null
}

export async function clipGainDeEsser(ctx) {
  await clipGainDeEsserAnalyze(ctx)
  await clipGainDeEsserApply(ctx)
}

// ── Stage: Auto Leveler (Stage 4b) ────────────────────────────────────────────
// M Leveller-style clip automation. Segments voiced audio into clips (VAD
// voiced runs plus sub-phrase splits at sustained internal level drops) and
// applies a single flat gain offset per clip. Within each clip the dynamics
// pass through unchanged; gain transitions happen via short cosine crossfades
// at the lowest-energy point near each boundary. Runs pre-compression so the
// compressor sees a level-stable input.
//
// Noise Eraser is excluded — separation output already has a consistent
// character. The leveler skips silently for that preset.

// Analyze pair (autoLevelerAnalyze / autoLevelerApply):
//   Analyze decodes the input, runs VAD conditioning, clip segmentation,
//   per-clip LUFS / target / gain computation, and builds the per-sample
//   gain curve. Channels + gain curve are passed in-memory through
//   ctx.globalParams.autoLeveler so apply doesn't have to re-read the
//   input WAV. Apply multiplies channels by the gain curve, writes the
//   output, and computes the post-leveler measurements.
//
//   Skipped cases (no preset config, file too short, too few voiced
//   clips, already-leveled) short-circuit at analyze with applied=false
//   and an empty params bundle. Apply is then a no-op — ctx.currentPath
//   stays at the original input, saving the gratuitous file copy that
//   the legacy combined stage performed.

export async function autoLevelerAnalyze(ctx) {
  const analyzed = await analyzeAutoLeveler(ctx.currentPath, ctx.preset, ctx.results.metrics)
  ctx.globalParams.autoLeveler = analyzed
  if (!analyzed.applied) {
    ctx.results.autoLeveler = { applied: false, skipped_reason: analyzed.skipped_reason }
    ctx.log(`[auto-leveler] Skipped — ${analyzed.skipped_reason}`)
  }
}

export async function autoLevelerApply(ctx) {
  const analyzed = ctx.globalParams.autoLeveler
  if (!analyzed || !analyzed.applied) return

  const levelerPath = ctx.tmp('.wav')
  const result = await renderAutoLeveler(levelerPath, analyzed)
  ctx.currentPath         = levelerPath
  ctx.results.autoLeveler = result

  const m = result.measurements
  ctx.log(
    `[auto-leveler] Applied — in σ(clip)=${m.input_clip_lufs_std_db}dB ` +
    `out σ(clip)=${m.output_clip_lufs_std_db}dB ` +
    `clips=${m.clip_count_after_merge} (splits=${m.subphrase_splits_count}, merges=${m.merges_count}) ` +
    `G=[${m.gain_max_down_db}, ${m.gain_max_up_db}]dB ` +
    `nf_cap=${m.noise_floor_cap_active}`
  )
}

export async function autoLeveler(ctx) {
  await autoLevelerAnalyze(ctx)
  await autoLevelerApply(ctx)
  // analyze stashed the full decoded channels + per-sample gain curve on
  // globalParams.autoLeveler so apply could consume them in-memory. For a
  // 1-hour stereo 48 kHz file that's ~1.4 GB of float32 data. Drop the
  // reference now that apply has written its output — the remaining
  // pipeline (airBoost, normalize, truePeakLimit, encode, …) has no use
  // for it, and ctx.results.autoLeveler already carries the small summary
  // the report builder reads.
  ctx.globalParams.autoLeveler = null
}

// ── Stage: Compression ────────────────────────────────────────────────────────

export async function compress(ctx) {
  const compPath          = ctx.tmp('.wav')
  const compressionResult = await applyCompression(
    ctx.currentPath,
    compPath,
    ctx.preset,
    ctx.results.metrics,
  )
  ctx.currentPath        = compPath
  ctx.results.compression = compressionResult
}

// ── Stage: Parallel Compression (Stage 4a-PC / NE-PC) ────────────────────────
// Splits the signal into a dry passthrough and a heavily-compressed wet branch,
// then mixes them at the preset-specific wet/dry ratio. The wet branch receives
// a VAD gate (to prevent lifting noise floor content during silence) and, when
// the preset defines `parallelCompression.wetBranchDeEsser`, a second clip-gain
// decision pass runs against the synthesized wet signal. That pass reuses the
// event boundaries the upstream `clipGainDeEss` stage detected on the dry path
// (so it does no extra STFT/VAD work) but re-measures peak/context RMS on the
// wet branch — letting it catch events (e.g. /f/) that only become problematic
// after compression + makeup, and apply aggressive attenuation specifically to
// the wet branch so the dry sibilant character predominates after the mix.
//
// Runs AFTER Stage 4a (serial compression) so both compression stages shape the
// signal before the Auto Leveler sees it — per spec: "The Auto Leveler should
// operate on the signal after parallel compression has set the density character."

export async function parallelCompress(ctx) {
  const pcPath          = ctx.tmp('.wav')
  const wetBranchConfig = ctx.preset?.parallelCompression?.wetBranchDeEsser
  const upstreamEvents  = ctx.results.clipGainDeEsser?.eventsPath ?? null

  const wetBranchEnabled    = wetBranchConfig?.enabled !== false
  const wetBranchDeEsserCtx = (wetBranchConfig && wetBranchEnabled && upstreamEvents)
    ? {
        eventsPath: upstreamEvents,
        config:     wetBranchConfig,
        vadFrames:  ctx.results.metrics?.frames ?? null,
      }
    : null

  const result = await applyParallelCompression(
    ctx.currentPath,
    pcPath,
    ctx.preset,
    ctx.results.metrics,
    wetBranchDeEsserCtx,
  )
  ctx.currentPath = pcPath
  ctx.results.parallelCompression = result
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
    ctx.preset,
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

// ── Stage: VAD Gate ───────────────────────────────────────────────────────────
// Smoothly attenuates non-voiced frames using Silero VAD labels. Converts the
// binary VAD mask into a per-sample gain envelope shaped by lookahead (catches
// word onsets that begin mid-frame), hold (catches word tails that decay past
// the voiced label), and asymmetric attack/release smoothing (prevents clicks
// at transitions). Floors at preset.vadGate.floorDb so silence retains a
// faint room tone rather than collapsing to digital silence.
//
// Skips silently when preset.vadGate is absent or vadGate.enabled is false.
// Runs after vocalExpander (the soft silence-floor attenuator) and before
// normalize so the final loudness pass sees the gated silence floor.

export async function vadGate(ctx) {
  const config = ctx.preset?.vadGate
  if (!config?.enabled) {
    ctx.results.vadGate = { applied: false, reason: 'preset_not_configured' }
    return
  }

  const outPath = ctx.tmp('.wav')
  const result  = await applyVadGate(ctx.currentPath, outPath, config, ctx.results.metrics)
  if (result.applied) ctx.currentPath = outPath
  ctx.results.vadGate = result

  if (result.applied) {
    ctx.log(
      `[vad-gate] Applied — segments=${result.openSegments} ` +
      `floor=${result.floorDb}dB lookahead=${result.lookaheadMs}ms ` +
      `hold=${result.holdMs}ms attack=${result.attackMs}ms release=${result.releaseMs}ms ` +
      `energyOverridden=${result.energyOverriddenFrames} ` +
      `gapFill=${result.minSilenceMs}ms minVoiced=${result.minVoicedMs}ms ` +
      `atFloor=${result.pctSamplesAtFloor}%`
    )
  } else {
    ctx.log(`[vad-gate] Skipped — ${result.reason}`)
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
}

// ── Stage: Vocal saturation ───────────────────────────────────────────────────
// Parallel tanh saturation mixed with the dry signal at wet_dry ratio.
// Runs after all compression/leveling and before normalization so the
// loudness pass absorbs any residual energy shift from the blend.

export async function vocalSaturation(ctx) {
  const outPath       = ctx.tmp('.wav')
  const sat           = ctx.preset.vocalSaturation ?? {}
  const drive         = sat.drive         ?? 2.0
  const wetDry        = sat.wetDry        ?? 0.3
  const bias          = sat.bias          ?? 0.5
  const lowCrossover  = sat.lowCrossover  ?? 500
  const midCrossover  = sat.midCrossover  ?? 3500
  const softness      = sat.softness      ?? 0.3
  const lowDriveMult  = sat.lowDriveMult  ?? 5.0
  const midDriveMult  = sat.midDriveMult  ?? 0.1
  const highDriveMult = sat.highDriveMult ?? 0.1

  await runVocalSaturation(ctx.currentPath, outPath, {
    drive, wetDry, bias, lowCrossover, midCrossover, softness,
    lowDriveMult, midDriveMult, highDriveMult,
  })
  ctx.currentPath = outPath
  ctx.results.vocalSaturation = {
    applied: true, drive, wetDry, bias, lowCrossover, midCrossover, softness,
    lowDriveMult, midDriveMult, highDriveMult,
  }
}

// ── Stage: Bass Enhance ───────────────────────────────────────────────────────
// Psychoacoustic bass synthesis (MaxxBass-style). Generates harmonic overtones
// of the fundamental and blends them additively into the dry signal — the ear
// infers the missing fundamental from its overtones, producing perceived
// sub-bass without adding sub-bass energy that would overload the limiter.
//
// Consumes upstream VAD frames (ctx.results.metrics.frames) and the cached F0
// contour (getF0Contour). With neither available the stage still runs but
// uses a fixed fallback crossover; quality is best when both are present.
//
// Skipped (no audio change) when preset.bassEnhance.enabled === false.
// Skipped at the script level when VAD coverage falls below
// preset.bassEnhance.skipIfVoicedRatioBelow.

export async function bassEnhance(ctx) {
  const cfg = ctx.preset?.bassEnhance ?? {}
  if (cfg.enabled === false) {
    ctx.results.bassEnhance = { applied: false, reason: 'disabled by preset' }
    ctx.log('[bass-enhance] disabled — skipped')
    return
  }

  const frames     = ctx.results.metrics?.frames ?? null
  const f0Contour  = await getF0Contour(ctx, { useCache: true })
  const outPath    = ctx.tmp('.wav')

  const info = await applyBassEnhance(ctx.currentPath, outPath, cfg, frames, f0Contour)

  if (info?.applied === false) {
    ctx.results.bassEnhance = info
    ctx.log(`[bass-enhance] skipped — ${info.skip_reason ?? 'unknown'}`)
    return
  }

  ctx.currentPath = outPath
  ctx.results.bassEnhance = info
  const peakNote = info.scale_limited_by === 'peak' ? ' (peak-capped)' : ''
  ctx.log(
    `[bass-enhance] applied segments=${info.n_segments} ` +
    `f0=${info.f0_range_hz?.join('–')}Hz ` +
    `mode=${info.normalize_mode} mix=${info.mix_effective} ` +
    `scale=${info.applied_scale}${peakNote} ` +
    `low_band_gain=${info.low_band_gain_db}dB ` +
    `vad_coverage=${info.vad_coverage_pct}%`,
  )
}

// ── Stage: Room Presence (Stage 4c) ──────────────────────────────────────────
// Convolution reverb with a synthetic IR. Placed after all corrective and
// tonal processing so the reverb tail doesn't amplify residual noise, and
// before loudness normalization so the tail doesn't trigger unexpected limiting.
//
// Skipped (no audio change) when preset.roomPresence.enabled is false.

export async function roomPresence(ctx) {
  const cfg = ctx.preset?.roomPresence ?? {}
  if (cfg.enabled === false) {
    ctx.results.roomPresence = { applied: false, reason: 'disabled by preset' }
    ctx.log('[room-presence] disabled — skipped')
    return
  }

  const wet              = cfg.wet               ?? 0.08
  const rt60Ms           = cfg.rt60Ms            ?? 80
  const preDelayMs       = cfg.preDelayMs        ?? 1.5
  const earlyReflections = cfg.early_reflections ?? 2
  const diffusion        = cfg.diffusion         ?? 0.7
  const irPath           = cfg.ir_path           ?? null

  const outPath    = ctx.tmp('.wav')
  const irResult   = await runRoomPresence(ctx.currentPath, outPath, { irPath, wet, rt60Ms, preDelayMs, earlyReflections, diffusion })
  const irSource   = irResult.irSource ?? (irPath ? 'file' : 'synthetic')
  const irFile     = irResult.irFile   ?? null
  ctx.currentPath          = outPath
  ctx.results.roomPresence = { applied: true, irSource, irFile, irPath, wet, rt60Ms, preDelayMs, earlyReflections, diffusion }

  // Mirror what room_presence.py logs to stdout so the pipeline log is self-contained.
  if (irSource === 'synthetic_fallback') {
    ctx.log(`[room-presence] IR: file load failed — falling back to synthetic`)
    ctx.log(`[room-presence] IR: synthetic fallback (rt60=${rt60Ms}ms, diffusion=${diffusion})`)
  } else if (irSource === 'synthetic') {
    ctx.log(`[room-presence] IR: synthetic (rt60=${rt60Ms}ms, diffusion=${diffusion})`)
  } else {
    ctx.log(`[room-presence] IR: ${irFile ?? irPath}`)
  }
  ctx.log(`[room-presence] applied wet=${wet} rt60=${rt60Ms}ms pre_delay=${preDelayMs}ms early_reflections=${earlyReflections} diffusion=${diffusion} ir_source=${irSource}`)
}

// ── Stage: Normalize ──────────────────────────────────────────────────────────

export async function normalize(ctx) {
  const { outputProfile } = ctx
  const normPath          = ctx.tmp('.wav')

  // RMS path (ACX): ungated full-file RMS via FFmpeg volumedetect. ACX measures
  // every sample in the file — silences, breaths, room tone — and the target
  // must match that measurement or normalization will systematically undershoot.
  //
  // LUFS path (podcast/broadcast): silence-excluded integrated loudness via
  // libebur128, using the pipeline's frame-level silence analysis. R128's
  // built-in gating is not file-specific enough on recordings with elevated
  // room tone, so we exclude pipeline-flagged silence frames explicitly.
  //
  // True peak ceiling is enforced by the subsequent truePeakLimit stage — do
  // not apply it here.

  if (outputProfile.measurementMethod === 'RMS') {
    // Use the explicit normalizationTarget from the output profile.
    // Do NOT use the loudnessRange midpoint — for ACX the midpoint is -20.5 dBFS
    // but the spec target is -20 dBFS RMS.
    const targetRms = outputProfile.normalizationTarget
    const rmsDbfs   = await measureRmsDbfs(ctx.currentPath)

    if (rmsDbfs == null || !Number.isFinite(rmsDbfs)) {
      throw new Error(
        `normalize: failed to measure full-file RMS for ${ctx.currentPath} ` +
        `(volumedetect returned ${rmsDbfs}). Cannot compute normalization gain.`
      )
    }

    const gainDb = targetRms - rmsDbfs

    if (gainDb > 18) {
      ctx.log(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
    }

    await applyLinearGain(ctx.currentPath, normPath, gainDb)
  } else {
    const prNormFrameAnalysis = await analyzeFrames(ctx.currentPath)
    const targetLufs          = outputProfile.normalizationTarget
    const voicedLufs          = await measureVoicedLufs(ctx.currentPath, prNormFrameAnalysis)
    const gainDb              = targetLufs - voicedLufs

    if (gainDb > 18) {
      ctx.log(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
    }

    await applyLinearGain(ctx.currentPath, normPath, gainDb)
  }

  ctx.currentPath = normPath
}

// ── Stage: True peak limiter ──────────────────────────────────────────────────

export async function truePeakLimit(ctx) {
  const ceilingDb   = ctx.outputProfile.truePeakCeiling
  const limitedPath = ctx.tmp('.wav')

  await applyTruePeakLimiter(ctx.currentPath, limitedPath, {
    peakCeiling: ceilingDb,
  })
  ctx.currentPath = limitedPath

  ctx.results.truePeakLimit = { ceilingDbfs: ceilingDb }
  ctx.log(`[level] after limiting: ceiling=${ceilingDb}dBFS`)
}

// ── Stage: Measure after ──────────────────────────────────────────────────────
//
// Measurement scope adapts to what downstream stages actually consume:
//
// ACX output profile:
//   - RMS + true peak (measureRmsAndPeak) — needed by acxCertification
//   - Noise floor — needed by acxCertification
//   - ACX audiobook preset: full remeasureFrames (breath/plosive detection in
//     qualityAdvisory needs per-frame data and voicedRmsDbfs)
//   - Other presets: measureNoiseFloorOnly (lightweight — no frame array)
//   - Integrated LUFS: skipped (not in the ACX 6-point check)
//
// Non-ACX output profiles (podcast/broadcast):
//   - Full measureAudio (RMS + true peak + integrated LUFS) — LUFS is the
//     primary loudness metric for these profiles and must reflect the actual
//     post-limiter level, not a pre-limiter estimate
//   - Noise floor + frame analysis: skipped (no compliance check, and
//     qualityAdvisory does not use frames for non-acx_audiobook presets)

export async function measureAfter(ctx) {
  const isAcx          = ctx.outputProfileId === 'acx'
  const isAcxAudiobook = ctx.presetId === 'acx_audiobook'
  const reference      = ctx.results.metrics
  const hasReference   = reference && Array.isArray(reference.frames) && reference.frames.length > 0

  if (isAcx) {
    // ACX certification needs rmsDbfs, truePeakDbfs, noiseFloorDbfs.
    // Integrated LUFS is not part of the ACX 6-point check — skip it.
    const frameTask = isAcxAudiobook
      ? (hasReference ? remeasureFrames(ctx.currentPath, reference) : analyzeFrames(ctx.currentPath))
      : measureNoiseFloorOnly(ctx.currentPath)

    const [audio, frameResult] = await Promise.all([
      measureRmsAndPeak(ctx.currentPath),
      frameTask,
    ])

    // measureNoiseFloorOnly returns a bare number; remeasureFrames returns an object
    const isFullFrameResult = typeof frameResult !== 'number'
    const noiseFloorDbfs    = isFullFrameResult ? frameResult.noiseFloorDbfs : frameResult

    if (isFullFrameResult) {
      Object.assign(ctx.results.metrics, frameResult, {
        rmsDbfs:        audio.rmsDbfs,
        truePeakDbfs:   audio.truePeakDbfs,
        lufsIntegrated: null,
      })
    } else {
      ctx.results.metrics.rmsDbfs        = audio.rmsDbfs
      ctx.results.metrics.truePeakDbfs   = audio.truePeakDbfs
      ctx.results.metrics.noiseFloorDbfs = noiseFloorDbfs
      ctx.results.metrics.lufsIntegrated = null
    }

    ctx.results.afterMeasurements = {
      rmsDbfs:        audio.rmsDbfs,
      truePeakDbfs:   audio.truePeakDbfs,
      lufsIntegrated: null,
      noiseFloorDbfs,
    }
  } else {
    // Non-ACX profiles (podcast/broadcast): full measureAudio for the
    // post-limiter integrated LUFS, plus lightweight noise floor so the
    // report's after section is fully populated. Frame re-analysis is still
    // skipped (no compliance check, and qualityAdvisory does not use frames
    // for non-acx_audiobook presets).
    const [audio, noiseFloorDbfs] = await Promise.all([
      measureAudio(ctx.currentPath),
      measureNoiseFloorOnly(ctx.currentPath),
    ])

    ctx.results.metrics.rmsDbfs        = audio.rmsDbfs
    ctx.results.metrics.truePeakDbfs   = audio.truePeakDbfs
    ctx.results.metrics.lufsIntegrated = audio.lufsIntegrated
    ctx.results.metrics.noiseFloorDbfs = noiseFloorDbfs

    ctx.results.afterMeasurements = {
      rmsDbfs:        audio.rmsDbfs,
      truePeakDbfs:   audio.truePeakDbfs,
      lufsIntegrated: audio.lufsIntegrated,
      noiseFloorDbfs,
    }
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
    bassEnhance:         ctx.results.bassEnhance ?? null,
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

  const model    = ctx.preset.separateVocals?.model ?? 'demucs'
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
}

// ── NE Stage: Post-separation validation (NE-4) ───────────────────────────────
// Spectral flatness artifact detection, sibilance ratio, breath ratio, quality rating.

export async function separationValidation(ctx) {
  const assessment = await validateSeparation(ctx.nePreSeparationPath, ctx.currentPath)

  // Keep the full assessment on ctx.results for report assembly in index.js.
  ctx.results.separationValidation = assessment

  // Merge the post-separation frame analysis into the canonical metrics object
  // so downstream processing stages (residualCleanup, correctiveEQ) always
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
  await applyNR(ctx.currentPath, nrPath, { attenLimDb: 6 })
  ctx.currentPath = nrPath
  ctx.results.residualCleanup = {
    applied:                     true,
    tier:                        2,
    pre_noise_floor_dbfs:        round2(noiseFloor),
    post_cleanup_noise_floor_dbfs: null,  // measured in Stage 7
  }
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
// Primary gate: ctx.preset.bandwidthExtension.enabled must be true.
// Secondary skip (NE context only): if NE-4 shows sibilance ratio ≥ 0.8 AND
// post-separation noise floor ≤ -55 dBFS, HF content is already intact — skip
// to save processing time.

export async function bandwidthExtension(ctx) {
  if (!ctx.preset.bandwidthExtension?.enabled) {
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

  const bweModel = ctx.preset.bandwidthExtension?.model ?? 'ap-bwe'

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
  const postEq = ctx.preset.bandwidthExtension.postEq
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
}

// ── CE Stage: ClearerVoice speech enhancement (CE-3) ─────────────────────────
// Single-model replacement for Demucs/ConvTasNet vocal separation (NE-3).
// ClearerVoice SE models operate on mono audio; stereo inputs are mixed to mono
// inside the Python script, so no explicit monoMixdown stage is needed before
// or after this stage.

export async function clearerVoiceEnhance(ctx) {
  // Save the pre-enhancement path for NE-4 validation comparison.
  ctx.nePreSeparationPath = ctx.currentPath

  const model   = ctx.preset.clearerVoiceEnhance?.model ?? 'mossformer2_48k'
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

// astats is used in preference to volumedetect because volumedetect only
// accepts AV_SAMPLE_FMT_S16 input — FFmpeg auto-inserts a float→int16
// converter that clips samples with |x| > 1.0 to int16 full-scale, so the
// reported max_volume saturates at 0 dBFS regardless of how far the actual
// float peak exceeded that. astats supports float and double natively and
// reports the true sample peak, including values above 0 dBFS, which the
// hpf clamp needs to compute the correct attenuation.
//
// astats is invoked without measure_perchannel / measure_overall options
// because those were added in FFmpeg 4.2 (Aug 2019) and the bundled
// @ffmpeg-installer build (Dec 2018) rejects them at filter-init time. The
// default astats output emits both a per-channel section and an "Overall"
// section; we parse the Overall section, which contains the global peak
// (max across channels) — identical to the per-channel value for mono input,
// the correct file-level summary for stereo.
async function measurePeakDbfs(filePath) {
  try {
    const { stderr } = await runFfmpeg([
      '-i', filePath,
      '-af', 'astats',
      '-f', 'null', '-',
    ])
    const overallIdx = stderr.lastIndexOf('Overall')
    const scope      = overallIdx >= 0 ? stderr.slice(overallIdx) : stderr
    const peakStr    = scope.match(/Peak level dB:\s*([-\d.inf]+)/)?.[1] ?? '?'
    const peakNum    = parseFloat(peakStr)
    return Number.isFinite(peakNum) ? peakNum : null
  } catch {
    return null
  }
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
