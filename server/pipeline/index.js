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
      const resultKeysBefore = new Set(Object.keys(ctx.results))
      const stageStart      = Date.now()

      await stage(ctx)

      const stageDuration = Date.now() - stageStart
      const audioChanged  = ctx.currentPath !== prevPath

      if (logger) {
        // Collect only the ctx.results keys that this stage added.
        const newKeys     = Object.keys(ctx.results).filter(k => !resultKeysBefore.has(k))
        const stageResults = {}
        for (const key of newKeys) stageResults[key] = ctx.results[key]

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
      ...(results.noiseReduction && { noise_reduction:   formatNrResult(results.noiseReduction) }),
      ...(results.dereverb       && { dereverberation:   formatDereverbResult(results.dereverb) }),
      ...(results.enhancementEQ  && { enhancement_eq:    formatEqResult(results.enhancementEQ) }),
      ...(results.separationEQ   && { separation_eq:     formatEqResult(results.separationEQ) }),
      ...(results.roomTonePad    && { room_tone_padding:  formatRoomToneResult(results.roomTonePad) }),
      ...(results.deEss          && { de_esser:           formatDeEssResult(results.deEss) }),
      ...(results.autoLeveler    && { auto_leveler:       formatAutoLevelerResult(results.autoLeveler) }),
      ...(results.compression    && { compression:        formatCompressionResult(results.compression) }),
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
    // separation_pipeline is absent (not null) for all presets except noise_eraser
    ...(results.separationPipeline && {
      separation_pipeline: formatSeparationPipelineResult(results.separationPipeline),
    }),
    // enhancement_pipeline is absent (not null) for all presets except voicefixer
    ...(results.enhancementPipeline && {
      enhancement_pipeline: formatEnhancementPipelineResult(results.enhancementPipeline),
    }),
    // separationEQ appears in processing_applied for noise_eraser (replaces enhancementEQ)
    quality_advisory: results.qualityAdvisory ?? null,
    warnings:         buildWarnings(ctx),
  }
}

// ── Report formatters ─────────────────────────────────────────────────────────

function formatMeasurements(m) {
  return {
    rms_dbfs:         m.rmsDbfs,
    true_peak_dbfs:   m.truePeakDbfs,
    // noiseFloorDbfs is merged into beforeMeasurements / afterMeasurements
    // by the measureBefore / measureAfter stages from silenceAnalysis. If a
    // future pipeline forgets to populate it the report emits null.
    noise_floor_dbfs: m.noiseFloorDbfs ?? null,
    lufs_integrated:  m.lufsIntegrated,
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
    profile:        r.profile,
    mud_cut:        bandReport(r.bands.mud_cut),
    warmth_boost:   bandReport(r.bands.warmth_boost),
    clarity_cut:    bandReport(r.bands.clarity_cut),
    presence_boost: bandReport(r.bands.presence_boost),
    air_boost:      bandReport(r.bands.air_boost),
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
    voice_type:       r.voiceType,
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
  const base = {
    applied:               r.applied,
    skipped_reason:        r.skippedReason,
    crest_factor_db:       r.crestFactorDb,
    max_gain_reduction_db: r.maxGainReductionDb,
    avg_gain_reduction_db: r.avgGainReductionDb,
    ratio:                 r.params?.ratio     ?? null,
    threshold_dbfs:        r.params?.threshold ?? null,
    attack_ms:             r.params?.attack    ?? null,
    release_ms:            r.params?.release   ?? null,
  }
  if (r.applied) {
    base.threshold_method  = r.thresholdMethod ?? null
    base.threshold_clamped = r.thresholdClamped ?? false
    if (r.thresholdMethod === 'adaptive_p85') {
      base.p85_dbfs         = r.p85Dbfs
      base.p99_dbfs         = r.p99Dbfs
      base.expected_gr_db   = r.expectedGrDb
      base.target_gr_window = r.targetGrWindow
      if (r.thresholdClamped) {
        base.threshold_pre_clamp_dbfs = r.thresholdPreClampDbfs
      }
    } else if (r.thresholdMethod === 'static_fallback') {
      base.fallback_reason = r.fallbackReason
    }
  }
  return base
}

function bandReport(band) {
  if (!band?.applied) return { applied: false }
  return { applied: true, freq_hz: band.freq_hz, gain_db: band.gain_db }
}

function formatSeparationPipelineResult(sp) {
  if (!sp) return null
  return {
    rnnoise_pre_pass: sp.rnnoisePrePass
      ? {
          applied:                 sp.rnnoisePrePass.applied,
          pre_noise_floor_dbfs:    sp.rnnoisePrePass.pre_noise_floor_dbfs,
          post_noise_floor_dbfs:   sp.rnnoisePrePass.post_noise_floor_dbfs,
        }
      : undefined,
    tonal_pretreatment: sp.tonalPretreatment
      ? {
          applied: sp.tonalPretreatment.applied,
          notches: sp.tonalPretreatment.notches ?? [],
        }
      : undefined,
    separation: sp.separation
      ? {
          model:                            sp.separation.model,
          post_separation_noise_floor_dbfs: sp.separation.post_separation_noise_floor_dbfs ?? null,
          sibilance_ratio:                  sp.separation.sibilance_ratio ?? null,
          breath_ratio:                     sp.separation.breath_ratio ?? null,
          artifact_flags:                   sp.separation.artifact_flags ?? [],
        }
      : undefined,
    residual_cleanup: sp.residualCleanup
      ? {
          applied:                       sp.residualCleanup.applied,
          tier:                          sp.residualCleanup.tier ?? null,
          post_cleanup_noise_floor_dbfs: sp.residualCleanup.post_cleanup_noise_floor_dbfs ?? null,
        }
      : undefined,
    separation_quality: sp.separation_quality ?? null,
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
