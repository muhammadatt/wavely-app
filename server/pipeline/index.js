/**
 * Processing Pipeline Orchestrator.
 *
 * Dispatches to the pipeline declared for the incoming presetId (see
 * pipelines.js) and runs each stage function in order against a shared
 * pipeline context (see createContext). Adding a new preset or changing its
 * stage sequence requires no changes here — only in pipelines.js and
 * stages.js.
 *
 * Stage results accumulate in ctx.results. buildReport() reads only what is
 * present, so stages that are absent from a pipeline produce no orphaned keys
 * in the report JSON.
 */

import { PRESETS, OUTPUT_PROFILES } from '../presets.js'
import { tempPath, removeTmp } from '../lib/ffmpeg.js'
import { PIPELINES } from './pipelines.js'
import { createLogger } from './logger.js'

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Process an audio file through the preset chain.
 *
 * @param {string} inputPath       - Path to the uploaded audio file
 * @param {string} originalName    - Original filename
 * @param {string} presetId        - Preset ID (e.g. 'acx_audiobook')
 * @param {string} outputProfileId - Output profile ID (e.g. 'acx')
 * @param {object} [presetOverrides] - Per-request preset field overrides (e.g. { separationModel: 'convtasnet' })
 * @returns {{ outputPath: string, report: object, peaks: object[] }}
 */
export async function processAudio(inputPath, originalName, presetId, outputProfileId, presetOverrides = {}) {
  const basePreset = PRESETS[presetId]
  if (!basePreset) throw new Error(`Unknown preset: ${presetId}`)
  // Shallow-merge overrides so the shared PRESETS object is never mutated
  const preset = Object.keys(presetOverrides).length ? { ...basePreset, ...presetOverrides } : basePreset

  const outputProfile = OUTPUT_PROFILES[outputProfileId]
  if (!outputProfile) throw new Error(`Unknown output profile: ${outputProfileId}`)

  const pipeline = PIPELINES[presetId]
  if (!pipeline) throw new Error(`No pipeline defined for preset: ${presetId}`)

  const ctx    = createContext({ inputPath, originalName, presetId, outputProfileId, preset, outputProfile })
  const logger = await createLogger(preset, outputProfile, originalName, inputPath)

  try {
    for (const stage of pipeline) {
      const prevPath        = ctx.currentPath
      const resultsBefore   = { ...ctx.results }
      const stageStart      = Date.now()

      await stage(ctx)

      const stageDuration = Date.now() - stageStart
      const audioChanged  = ctx.currentPath !== prevPath

      if (logger) {
        // Collect the ctx.results keys that this stage added or updated.
        const changedKeys = Object.keys(ctx.results).filter(k => ctx.results[k] !== resultsBefore[k])
        const stageResults = {}
        for (const key of changedKeys) stageResults[key] = ctx.results[key]

        await logger.logStep(
          stage.name,
          audioChanged ? ctx.currentPath : null,
          stageResults,
          stageDuration,
        )
      }
    }

    const report   = buildReport(ctx)
    const toClean  = ctx.tmpFiles.filter(f => f !== ctx.currentPath)
    await Promise.all(toClean.map(removeTmp))

    if (logger) await logger.finalize(report)

    return { outputPath: ctx.currentPath, report, peaks: ctx.peaks }
  } catch (err) {
    await Promise.all(ctx.tmpFiles.map(removeTmp))
    throw err
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

function createContext({ inputPath, originalName, presetId, outputProfileId, preset, outputProfile }) {
  const tmpFiles = []
  return {
    // Static — set at creation, never changed by stages
    inputPath,
    originalName,
    presetId,
    outputProfileId,
    preset,
    outputProfile,
    // Allocates a temp path and registers it for cleanup
    tmp(ext) {
      const p = tempPath(ext)
      tmpFiles.push(p)
      return p
    },
    tmpFiles,
    // Convenience logger — use ctx.log() in stage functions instead of console.log directly.
    // Structured per-step file logging is handled by logger.js (PIPELINE_LOG=true).
    log: console.log.bind(console),
    // Set by the decode stage
    probe:           null,
    inputSampleRate: null,
    inputChannels:   null,
    // Updated by each stage that writes a new audio file
    currentPath: inputPath,
    // Set by the extractPeaks stage
    peaks: null,
    // Accumulates per-stage results — keyed by stage name.
    // buildReport() reads only the keys that are present, so stages absent
    // from a pipeline produce no orphaned keys in the report JSON.
    results: {},
  }
}

// ── Report builder ────────────────────────────────────────────────────────────

/**
 * Build the response report from accumulated ctx.results.
 * Only renders keys for stages that actually ran — absent stages produce no
 * orphaned null keys in the JSON.
 *
 * measureBefore and measureAfter are required by every pipeline. If either is
 * missing the pipeline is misconfigured and we throw a clear error rather than
 * silently producing a broken report.
 */
function buildReport(ctx) {
  const { probe, presetId, outputProfileId, originalName, results } = ctx

  if (!results.beforeMeasurements) {
    throw new Error('[pipeline] buildReport: measureBefore stage did not run — ctx.results.beforeMeasurements is missing')
  }
  if (!results.afterMeasurements) {
    throw new Error('[pipeline] buildReport: measureAfter stage did not run — ctx.results.afterMeasurements is missing')
  }

  const audioStream = probe.streams.find(s => s.codec_type === 'audio')
  const duration    = parseFloat(probe.format?.duration || audioStream?.duration || 0)

  return {
    file:             originalName,
    preset:           presetId,
    output_profile:   outputProfileId,
    duration_seconds: Math.round(duration),
    processing_applied: {
      stereo_to_mono:  results.stereoToMono ?? false,
      resampled_from:  ctx.inputSampleRate !== 44100 ? ctx.inputSampleRate : null,
      hpf_60hz_notch:  results.notch60Hz   ?? false,
      ...(results.humEQ && { hum_eq: formatHumEqResult(results.humEQ) }),
      ...(results.noiseReduction && { noise_reduction:   formatNrResult(results.noiseReduction) }),
      ...(results.dereverb       && { dereverberation:   formatDereverbResult(results.dereverb) }),
      ...(results.enhancementEQ  && { enhancement_eq:    formatEqResult(results.enhancementEQ) }),
      ...(results.airBoost       && { air_boost:          formatAirBoostResult(results.airBoost) }),
      ...(results.roomTonePad    && { room_tone_padding:  formatRoomToneResult(results.roomTonePad) }),
      ...(results.deEss          && { de_esser:           formatDeEssResult(results.deEss) }),
      ...(results.autoLeveler         && { auto_leveler:         formatAutoLevelerResult(results.autoLeveler) }),
      ...(results.compression         && { compression:           formatCompressionResult(results.compression) }),
      ...(results.parallelCompression && { parallel_compression:  formatParallelCompressionResult(results.parallelCompression) }),
      ...(results.vocalExpander         && { vocal_expander:          formatVocalExpanderResult(results.vocalExpander) }),
      ...(results.vadGate               && { vad_gate:                formatVadGateResult(results.vadGate) }),
      ...(results.resonanceSuppressor   && { resonance_suppressor:    formatResonanceSuppressorResult(results.resonanceSuppressor) }),
      normalization_gain_db:
        results.afterMeasurements?.rmsDbfs == null || results.beforeMeasurements?.rmsDbfs == null
          ? null
          : round2(results.afterMeasurements.rmsDbfs - results.beforeMeasurements.rmsDbfs),
      limiting_max_reduction_db: null,
    },
    before:           formatMeasurements(results.beforeMeasurements),
    after:            formatMeasurements(results.afterMeasurements),
    // acx_certification is absent (not null) when output_profile !== 'acx'
    ...(results.acxCertification && { acx_certification: results.acxCertification }),
    // separation_pipeline is absent (not null) when no separation stage ran
    ...(results.separation && {
      separation_pipeline: buildSeparationPipelineReport(results),
    }),
    // enhancement_pipeline is absent (not null) when no enhancement_pipeline stage ran
    ...(results.enhancementPipeline && {
      enhancement_pipeline: formatEnhancementPipelineResult(results.enhancementPipeline),
    }),
    quality_advisory: results.qualityAdvisory ?? null,
    warnings:         buildWarnings(ctx),
  }
}

// ── Report formatters ─────────────────────────────────────────────────────────

function formatMeasurements(m) {
  return {
    rms_dbfs:         m.rmsDbfs,
    true_peak_dbfs:   m.truePeakDbfs,
    // noiseFloorDbfs is back-filled into beforeMeasurements by analyzeFramesRaw
    // and written directly into afterMeasurements by measureAfter. Both snapshots
    // are plain four-field objects; noiseFloorDbfs is null if the stage didn't run.
    noise_floor_dbfs: m.noiseFloorDbfs ?? null,
    lufs_integrated:  m.lufsIntegrated,
  }
}

function formatHumEqResult(r) {
  if (!r) return null
  return {
    triggered:         r.triggered,
    flagged_harmonics: r.flaggedHarmonics,
    notches_applied:   r.notchesApplied,
    detection_detail:  r.detectionDetail.map(d => ({
      frequency_hz: d.frequency,
      peak_db:      d.peakDb,
      floor_db:     d.floorDb,
      delta_db:     d.deltaDb,
      flagged:      d.flagged,
    })),
    ...(r.triggered && { ffmpeg_filter: r.ffmpegFilter }),
  }
}

function formatNrResult(r) {
  return {
    applied:               r.applied,
    tier:                  r.tier,
    model:                 r.model,
    pre_noise_floor_dbfs:  r.pre_noise_floor_dbfs,
    post_noise_floor_dbfs: r.post_noise_floor_dbfs,
  }
}

function formatDereverbResult(r) {
  if (!r?.applied) return null
  return {
    applied:        r.applied,
    strength:       r.strength,
    preserve_early: r.preserve_early,
  }
}

function formatEqResult(r) {
  if (!r?.applied) return null
  return {
    profile:   r.profile,
    warmth:    bandReport(r.bands.warmth),
    mud:       bandReport(r.bands.mud),
    clarity:   bandReport(r.bands.clarity),
    upper_mid: bandReport(r.bands.upper_mid),
    presence:  bandReport(r.bands.presence),
    air:       bandReport(r.bands.air),
  }
}

function formatAirBoostResult(r) {
  if (!r.applied) {
    return {
      applied:           false,
      requested_gain_db: r.requested_gain_db,
      skip_reason:       r.skip_reason,
    }
  }
  return {
    applied:           true,
    requested_gain_db: r.requested_gain_db,
    applied_gain_db:   r.applied_gain_db,
    acx_constrained:   r.acx_constrained ?? false,
    model:             r.model,
    shelves:           r.shelves,
  }
}

function formatRoomToneResult(r) {
  return { applied: r.applied, head_added_s: r.headAdded_s, tail_added_s: r.tailAdded_s }
}

function formatDeEssResult(r) {
  if (!r) return null
  return {
    applied:          r.applied,
    f0_hz:            r.f0Hz,
    target_freq_hz:   r.targetFreqHz,
    max_reduction_db: r.maxReductionDb,
    p95_energy_db:    r.p95EnergyDb,
    mean_energy_db:   r.meanEnergyDb,
    trigger_reason:   r.triggerReason,
  }
}

function formatAutoLevelerResult(r) {
  if (!r) return null
  if (!r.applied) {
    return {
      applied: false,
      reason: r.reason ?? null,
      ...(r.pre_leveling_rms_std_db != null && { pre_leveling_rms_std_db: r.pre_leveling_rms_std_db }),
    }
  }
  return {
    applied:                    true,
    activation_reason:          r.activation_reason,
    pre_leveling_rms_std_db:    r.pre_leveling_rms_std_db,
    post_leveling_rms_std_db:   r.post_leveling_rms_std_db,
    median_target_rms_dbfs:     r.median_target_rms_dbfs,
    max_gain_applied_db:        r.max_gain_applied_db,
    min_gain_applied_db:        r.min_gain_applied_db,
    segments_analyzed:          r.segments_analyzed,
    gain_capped_segments:       r.gain_capped_segments,
  }
}

function formatCompressionResult(r) {
  if (!r) return null
  if (!r.applied) {
    return {
      applied:                 false,
      input_crest_factor_db:   r.inputCrestFactorDb   ?? null,
      target_crest_factor_db:  r.targetCrestFactorDb  ?? null,
      skip_reason:             r.skipReason            ?? null,
      passes:                  r.passes ? r.passes.map(formatCompressionPass) : null,
    }
  }

  return {
    applied:                   true,
    input_crest_factor_db:     r.inputCrestFactorDb,
    target_crest_factor_db:    r.targetCrestFactorDb,
    final_crest_factor_db:     r.finalCrestFactorDb,
    threshold_percentile:      r.thresholdPercentile,
    threshold_dbfs:            r.thresholdDbfs,
    derived_ratio:             r.derivedRatio,
    derived_gain_reduction_db: r.derivedGainReductionDb,
    max_gain_reduction_db:     r.maxGainReductionDb,
    avg_gain_reduction_db:     r.avgGainReductionDb,
    passes:                    r.passes ? r.passes.map(formatCompressionPass) : null,
  }
}

function formatCompressionPass(passData) {
  const { passNumber, config, result } = passData
  return {
    pass_number: passNumber,
    config: {
      target_crest_factor_db: config.targetCrestFactorDb,
      threshold_percentile: config.thresholdPercentile,
      attack: config.attack,
      release: config.release,
    },
    result: {
      applied: result.applied,
      input_crest_factor_db: result.inputCrestFactorDb,
      final_crest_factor_db: result.finalCrestFactorDb,
      skip_reason: result.skipReason,
      threshold_dbfs: result.thresholdDbfs,
      derived_ratio: result.derivedRatio,
      derived_gain_reduction_db: result.derivedGainReductionDb,
      max_gain_reduction_db: result.maxGainReductionDb,
      avg_gain_reduction_db: result.avgGainReductionDb,
    }
  }
}

function formatParallelCompressionResult(r) {
  if (!r || !r.applied) {
    return {
      applied: false,
      reason:  r?.reason ?? null,
    }
  }
  return {
    applied:                          true,
    threshold_dbfs:                   r.thresholdDbfs,
    voiced_rms_dbfs:                  r.voicedRmsDbfs,
    ratio:                            r.ratio,
    attack_ms:                        r.attackMs,
    release_ms:                       r.releaseMs,
    makeup_gain_db:                   r.makeupGainDb,
    wet_mix_target:                   r.wetMixTarget,
    wet_mix_effective:                r.wetMixEffective,
    crest_factor_guard_activated:     r.crestFactorGuardActivated,
    pre_pc_crest_factor_db:           r.prePcCrestFactorDb,
    parallel_desser_applied:          r.parallelDesserApplied,
    parallel_desser_type:             r.parallelDesserType,
    parallel_desser_center_freq_hz:   r.parallelDesserCenterFreqHz,
    parallel_desser_max_reduction_db: r.parallelDesserMaxReductionDb,
    vad_gate_applied:                 r.vadGateApplied,
    vad_gate_fade_ms:                 r.vadGateFadeMs,
  }
}

function formatVocalExpanderResult(r) {
  if (!r) return null
  if (!r.applied) {
    return {
      applied:        false,
      skipped_reason: r.reason ?? null,
    }
  }
  return {
    applied:        true,
    skipped_reason: null,
    calibration: {
      noiseFloor_db: r.noiseFloorDb,
      voiced_db: r.fullVoicedP50Db,
      threshold_dbfs:                    r.thresholdDb,
      headroom_offset_db:                r.headroomOffsetDb,
    },
    parameters: {
      ratio:              r.ratio,
      high_freq_depth:    r.highFreqDepth,
      release_ms:         r.releaseMs,
      max_attenuation_db: r.maxAttenuationDb,
    },
    result: {
      avg_attenuation_silence_db: r.avgAttenuationSilenceDb,
      max_attenuation_db:         r.maxAttenuationAppliedDb,
      pct_frames_expanded:        r.pctFramesExpanded,
      over_expansion_flag:        r.overExpansionFlag,
    },
  }
}

function formatVadGateResult(r) {
  if (!r) return null
  if (!r.applied) {
    return {
      applied:        false,
      skipped_reason: r.reason ?? null,
    }
  }
  return {
    applied:        true,
    skipped_reason: null,
    parameters: {
      lookahead_ms: r.lookaheadMs,
      hold_ms:      r.holdMs,
      attack_ms:    r.attackMs,
      release_ms:   r.releaseMs,
      floor_db:     r.floorDb,
    },
    result: {
      voiced_frames:        r.voicedFrames,
      silence_frames:       r.silenceFrames,
      open_segments:        r.openSegments,
      pct_samples_at_floor: r.pctSamplesAtFloor,
    },
  }
}

function formatResonanceSuppressorResult(r) {
  if (!r) return null
  if (r.applied === false) return { applied: false }
  return {
    applied:           true,
    max_reduction_db:  r.max_reduction_db  ?? null,
    mean_reduction_db: r.mean_reduction_db ?? null,
    spike_frames:      r.spike_frames      ?? null,
    artifact_risk:     r.artifact_risk     ?? false,
  }
}

function bandReport(band) {
  if (!band?.applied) return { applied: false }
  return { applied: true, freq_hz: band.freq_hz, gain_db: band.gain_db }
}

/**
 * Assembles the separation_pipeline report from individual top-level result keys.
 * Each NE processing stage writes its own key (rnnoisePrePass, tonalPretreatment,
 * separation, separationValidation, residualCleanup, bandwidthExtension).
 * This function merges them into the report shape without coupling the stages
 * to each other or to the report structure.
 */
function buildSeparationPipelineReport(results) {
  const sv = results.separationValidation
  return {
    rnnoise_pre_pass: results.rnnoisePrePass
      ? {
          applied:               results.rnnoisePrePass.applied,
          pre_noise_floor_dbfs:  results.rnnoisePrePass.pre_noise_floor_dbfs,
          post_noise_floor_dbfs: sv?.postSeparationNoiseFloorDbfs ?? null,
        }
      : undefined,
    tonal_pretreatment: results.tonalPretreatment
      ? {
          applied: results.tonalPretreatment.applied,
          notches: results.tonalPretreatment.notches ?? [],
        }
      : undefined,
    separation: results.separation
      ? {
          model:                            results.separation.model,
          post_separation_noise_floor_dbfs: sv?.postSeparationNoiseFloorDbfs ?? null,
          sibilance_ratio:                  sv?.sibilanceRatio ?? null,
          breath_ratio:                     sv?.breathRatio ?? null,
          artifact_flags:                   sv?.artifactFlags ?? [],
        }
      : undefined,
    residual_cleanup: results.residualCleanup
      ? {
          applied:                       results.residualCleanup.applied,
          tier:                          results.residualCleanup.tier ?? null,
          post_cleanup_noise_floor_dbfs: results.residualCleanup.post_cleanup_noise_floor_dbfs ?? null,
        }
      : undefined,
    separation_quality: sv?.separationQuality ?? null,
  }
}

function formatEnhancementPipelineResult(ep) {
  if (!ep) return null
  return {
    model: ep.model,
    mode:  ep.mode,
    ...(ep.nfe    != null && { nfe:    ep.nfe }),
    ...(ep.solver != null && { solver: ep.solver }),
    ...(ep.lambd  != null && { lambd:  ep.lambd }),
    ...(ep.tau    != null && { tau:    ep.tau }),
  }
}

// ── Warnings ──────────────────────────────────────────────────────────────────

function buildWarnings(ctx) {
  const { results, outputProfile } = ctx
  const warnings = []

  if (results.noiseReduction && !results.noiseReduction.applied) {
    warnings.push('Noise reduction not available — noise floor unchanged')
  }

  if (results.compression?.applied &&
      results.compression.derivedRatio >= 6.0) {
    warnings.push('Heavy compression was applied. Input dynamics were significantly outside target range.')
  }

  // ACX certification failures surface as warnings
  if (results.acxCertification?.certificate === 'fail') {
    const checks = results.acxCertification.checks
    if (!checks.rms?.pass) {
      warnings.push(
        `Loudness ${results.afterMeasurements.rmsDbfs} dBFS RMS outside target range ` +
        `[${outputProfile.loudnessRange[0]}, ${outputProfile.loudnessRange[1]}]`
      )
    }
    if (!checks.noise_floor?.pass) {
      warnings.push(
        `Noise floor ${results.afterMeasurements.noiseFloorDbfs} dBFS exceeds ` +
        `ceiling of ${outputProfile.noiseFloorCeiling} dBFS`
      )
    }
    if (!checks.true_peak?.pass) {
      warnings.push(
        `True peak ${results.afterMeasurements.truePeakDbfs} dBFS exceeds ` +
        `ceiling of ${outputProfile.truePeakCeiling} dBFS`
      )
    }
  }

  return warnings
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
