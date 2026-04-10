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
import { runRnnoise, runSeparation, runAudioSR, runResembleEnhance, runVoiceFixer, runHarmonicExciter, runClearerVoice } from './separation.js'
import { validateSeparation } from './separationValidation.js'

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
  logSilence(ctx, 'pre-HPF', sa)
}

// ── Stage: High-pass filter ───────────────────────────────────────────────────

export async function hpf(ctx) {
  const notch60Hz = detect60HzHum(ctx.results.rawNoiseFloor)
  const hpfPath   = ctx.tmp('.wav')
  await applyHighPass(ctx.currentPath, hpfPath, { notch60Hz })
  ctx.currentPath     = hpfPath
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
// Definitive silence analysis used by room tone padding and enhancement EQ.

export async function silenceAnalysisPostNr(ctx) {
  const sa = await analyzeAudioFrames(ctx.currentPath)
  ctx.results.silencePostNr = sa
  logSilence(ctx, 'post-NR', sa)
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
  await logLevel(ctx, 'after de-esser', ctx.currentPath, {
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
  await logLevel(ctx, 'after compression', ctx.currentPath, {
    applied: compressionResult.applied,
    crest:   compressionResult.crestFactorDb      !== null ? `${compressionResult.crestFactorDb}dB`      : 'n/a',
    maxRed:  compressionResult.maxGainReductionDb !== null ? `${compressionResult.maxGainReductionDb}dB` : 'n/a',
    avgRed:  compressionResult.avgGainReductionDb !== null ? `${compressionResult.avgGainReductionDb}dB` : 'n/a',
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

  if (outputProfile.measurementMethod === 'RMS') {
    // Use the explicit normalizationTarget from the output profile.
    // Do NOT use the loudnessRange midpoint — for ACX the midpoint is -20.5 dBFS
    // but the spec target is -20 dBFS RMS.
    const targetRms             = outputProfile.normalizationTarget
    const prNormSilenceAnalysis = await analyzeAudioFrames(ctx.currentPath)
    const voicedRms             = await measureVoicedRms(ctx.currentPath, prNormSilenceAnalysis)
    const gainDb                = targetRms - voicedRms

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
    preNrNoiseFloor: ctx.results.rawNoiseFloor ?? null,
    noiseFloorDbfs:  ctx.results.noiseReduction?.post_noise_floor_dbfs ?? null,
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
// Restores HF voice content attenuated during source separation.
// Skipped if sibilance ratio ≥ 0.8 AND post-separation noise floor < -55 dBFS.

export async function bandwidthExtension(ctx) {
  ctx.results.separationPipeline = ctx.results.separationPipeline ?? {}
  const validation   = ctx.results.separationPipeline.validation
  const sibilance    = validation?.sibilanceRatio ?? 0
  const noiseFloor   = validation?.postSeparationNoiseFloorDbfs ?? 0

  //const skip = sibilance >= 0.8 && noiseFloor <= -55
  const skip = false
  if (skip) {
    ctx.results.separationPipeline.bandwidthExtension = {
      applied: false, skippedReason: 'Sibilance well-preserved and noise floor clean — BWE not needed',
    }
    ctx.log('[NE-6] Bandwidth extension skipped — sibilance preserved, noise floor clean')
    return
  }

  const bwePath = ctx.tmp('.wav')
  try {
    await runAudioSR(ctx.currentPath, bwePath, 3.5)
    ctx.currentPath = bwePath
    ctx.results.separationPipeline.bandwidthExtension = {
      applied:            true,
      model:              'AudioSR',
      hf_energy_delta_db: null,
    }
    await logLevel(ctx, 'after NE-6 bandwidth extension', ctx.currentPath, {})
  } catch (err) {
    // AudioSR requires ~4 GB RAM — skip gracefully on low-memory servers
    // rather than failing the entire pipeline.
    ctx.log(`[NE-6] AudioSR skipped — ${err.message.split('\n')[0]}`)
    ctx.results.separationPipeline.bandwidthExtension = {
      applied: false,
      skippedReason: 'AudioSR unavailable or out of memory — bandwidth extension skipped',
    }
  }
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

// ── RE Stage: Resemble Enhance denoising/enhancement (RE-1) ──────────────────
// Single-stage replacement for the NE-1 through NE-7 block.
// Denoise mode: UNet denoiser only — conservative, voice-transparent.
// Enhance mode: Denoise + CFM diffusion enhancer — adds bandwidth extension
//               and perceptual improvement (analogous to NR + AudioSR in one pass).
// Mono mixdown happens AFTER processing to preserve model quality on stereo inputs.

export async function resembleEnhance(ctx) {
  const mode   = ctx.preset.resembleMode   ?? 'enhance'
  const params = {
    nfe:          ctx.preset.resembleNfe          ?? 64,
    solver:       ctx.preset.resembleSolver       ?? 'midpoint',
    lambd:        ctx.preset.resembleLambd        ?? 0.1,
    tau:          ctx.preset.resembleTau          ?? 0.5,
    chunkSeconds: ctx.preset.resembleChunkSeconds ?? null,  // null → script picks device-aware default
  }

  const outPath = ctx.tmp('.wav')
  ctx.log(`[RE-1] Starting Resemble Enhance (${mode}) — this may take several minutes`)
  await runResembleEnhance(ctx.currentPath, outPath, mode, params)
  ctx.currentPath = outPath

  // resemble-enhance processes mono internally; apply mixdown if preset requires it.
  if (ctx.preset.channelOutput === 'mono' && ctx.inputChannels > 1) {
    const monoPath = ctx.tmp('.wav')
    await mixdownToMono(ctx.currentPath, monoPath)
    ctx.currentPath = monoPath
    ctx.results.stereoToMono = true
  } else {
    ctx.results.stereoToMono = false
  }

  ctx.results.enhancementPipeline = {
    model:  'ResembleEnhance',
    mode,
    ...(mode === 'enhance' && {
      nfe:    params.nfe,
      solver: params.solver,
      lambd:  params.lambd,
      tau:    params.tau,
    }),
  }
  await logLevel(ctx, `after RE-1 Resemble Enhance (${mode})`, ctx.currentPath, { mode })
}

// ── VF Stage: VoiceFixer speech restoration (VF-1) ───────────────────────────
// Single-stage replacement for the NE-1 through NE-7 block.
// Handles noise, reverb, low resolution, and clipping in one model pass.
// Output is vocoder-resynthesized — effective for severe degradation but
// voice character may differ from input (not a transparent NR tool).

export async function voiceFixerRestore(ctx) {
  const mode    = ctx.preset.voiceFixerMode ?? 0
  const outPath = ctx.tmp('.wav')

  ctx.log(`[VF-1] Starting VoiceFixer mode ${mode} — this may take several minutes`)
  await runVoiceFixer(ctx.currentPath, outPath, mode)
  ctx.currentPath = outPath

  // VoiceFixer outputs mono regardless of input channel count.
  ctx.results.stereoToMono = ctx.inputChannels > 1

  ctx.results.enhancementPipeline = {
    model: 'VoiceFixer',
    mode,
  }
  await logLevel(ctx, `after VF-1 VoiceFixer (mode ${mode})`, ctx.currentPath, { mode })
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

function logSilence(ctx, label, sa) {
  const voiced = sa.frames.filter(f => !f.isSilence).length
  const total  = sa.frames.length
  ctx.log(
    `[silence] ${label}: noiseFloor=${sa.noiseFloorDbfs}dBFS  ` +
    `threshold=${sa.silenceThresholdDbfs}dBFS  ` +
    `voicedRms=${sa.voicedRmsDbfs}dBFS  ` +
    `voiced=${voiced}/${total} frames`
  )
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
