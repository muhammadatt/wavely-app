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

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Process an audio file through the preset chain.
 *
 * @param {string} inputPath     - Path to the uploaded audio file
 * @param {string} originalName  - Original filename
 * @param {string} presetId      - Preset ID (e.g. 'acx_audiobook')
 * @param {string} outputProfileId - Output profile ID (e.g. 'acx')
 * @returns {{ outputPath: string, report: object, peaks: object[] }}
 */
export async function processAudio(inputPath, originalName, presetId, outputProfileId) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const outputProfile = OUTPUT_PROFILES[outputProfileId]
  if (!outputProfile) throw new Error(`Unknown output profile: ${outputProfileId}`)

  const pipeline = PIPELINES[presetId]
  if (!pipeline) throw new Error(`No pipeline defined for preset: ${presetId}`)

  const ctx = createContext({ inputPath, originalName, presetId, outputProfileId, preset, outputProfile })

  try {
    for (const stage of pipeline) {
      await stage(ctx)
    }

    const report   = buildReport(ctx)
    const toClean  = ctx.tmpFiles.filter(f => f !== ctx.currentPath)
    await Promise.all(toClean.map(removeTmp))

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
      ...(results.enhancementEQ  && { enhancement_eq:    formatEqResult(results.enhancementEQ) }),
      ...(results.roomTonePad    && { room_tone_padding:  formatRoomToneResult(results.roomTonePad) }),
      ...(results.deEss          && { de_esser:           formatDeEssResult(results.deEss) }),
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
    quality_advisory: results.qualityAdvisory ?? null,
    warnings:         buildWarnings(ctx),
  }
}

// ── Report formatters ─────────────────────────────────────────────────────────

function formatMeasurements(m) {
  return {
    rms_dbfs:         m.rmsDbfs,
    true_peak_dbfs:   m.truePeakDbfs,
    noise_floor_dbfs: m.noiseFloorDbfs,
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

function formatCompressionResult(r) {
  if (!r) return null
  return {
    applied:               r.applied,
    skipped_reason:        r.skippedReason,
    crest_factor_db:       r.crestFactorDb,
    max_gain_reduction_db: r.maxGainReductionDb,
    avg_gain_reduction_db: r.avgGainReductionDb,
    ratio:                 r.params?.ratio     ?? null,
    threshold_db:          r.params?.threshold ?? null,
  }
}

function bandReport(band) {
  if (!band?.applied) return { applied: false }
  return { applied: true, freq_hz: band.freq_hz, gain_db: band.gain_db }
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
