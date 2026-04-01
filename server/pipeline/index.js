/**
 * Processing Pipeline Orchestrator.
 *
 * Runs the full preset processing chain on an uploaded audio file.
 * Currently implements Sprint 1 stages:
 *   Stage 0: Decode → 32-bit float PCM 44.1kHz
 *   Stage 1: High-pass filter (80 Hz Butterworth 4th order)
 *   Stage 2: Noise reduction (STUB — pass-through)
 *   Stage 5: Loudness normalization (RMS for ACX, LUFS for others)
 *   Stage 6: True peak limiting
 *   Stage 7: Measurement + compliance report
 *
 * Stages 3 (EQ), 4 (de-esser), 4a (compression) are Sprint 2-3.
 */

import { PRESETS, COMPLIANCE_TARGETS } from '../presets.js'
import {
  tempPath,
  removeTmp,
  decodeToFloat32,
  mixdownToMono,
  applyHighPass,
  applyLinearGain,
  applyLoudnormLUFS,
  applyTruePeakLimiter,
  encodeOutput,
  probeFile,
} from '../lib/ffmpeg.js'
import { applyNoiseReduction } from './noiseReduce.js'
import { measureAudio, checkCompliance } from './measure.js'
import { extractPeaks } from './peaks.js'

/**
 * Process an audio file through the preset chain.
 *
 * @param {string} inputPath - Path to the uploaded audio file
 * @param {string} originalName - Original filename
 * @param {string} presetId - Preset ID (e.g. 'acx_audiobook')
 * @param {string} complianceId - Compliance target ID (e.g. 'acx')
 * @returns {{ outputPath: string, report: object, peaks: object[] }}
 */
export async function processAudio(inputPath, originalName, presetId, complianceId) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)
  const compliance = COMPLIANCE_TARGETS[complianceId]
  if (!compliance) throw new Error(`Unknown compliance target: ${complianceId}`)

  // Track temp files for cleanup
  const tmpFiles = []
  const tmp = (ext) => {
    const p = tempPath(ext)
    tmpFiles.push(p)
    return p
  }

  try {
    // --- Probe input ---
    const probe = await probeFile(inputPath)
    const audioStream = probe.streams.find(s => s.codec_type === 'audio')
    const inputSampleRate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : null
    const inputChannels = audioStream?.channels || 1

    // --- Stage 0: Decode to 32-bit float PCM 44.1kHz ---
    const decodedPath = tmp('.wav')
    await decodeToFloat32(inputPath, decodedPath)

    // --- Stage 0b: Channel handling ---
    let currentPath = decodedPath
    let stereoToMono = false

    if (preset.channelOutput === 'mono' && inputChannels > 1) {
      const monoPath = tmp('.wav')
      await mixdownToMono(currentPath, monoPath)
      currentPath = monoPath
      stereoToMono = true
    }

    // --- Measure "before" values ---
    const beforeMeasurements = await measureAudio(currentPath)

    // --- Stage 1: High-pass filter ---
    // Check if 60 Hz notch is needed (simplified: would need spectral analysis)
    // For now, skip the notch — requires pre-processing spectral analysis (Sprint 2)
    const hpfPath = tmp('.wav')
    await applyHighPass(currentPath, hpfPath, { notch60Hz: false })
    currentPath = hpfPath

    // --- Stage 2: Noise reduction (STUB) ---
    const nrPath = tmp('.wav')
    const nrCeiling = preset.noiseReductionCeiling <= 8 ? 3 : 4
    const nrResult = await applyNoiseReduction(currentPath, nrPath, {
      ceilingTier: nrCeiling,
      noiseFloorDbfs: beforeMeasurements.noiseFloorDbfs,
    })
    currentPath = nrPath

    // --- Stage 3: Enhancement EQ (Sprint 2) ---
    // --- Stage 4: De-esser (Sprint 3) ---
    // --- Stage 4a: Compression (Sprint 3) ---

    // --- Stage 5: Loudness normalization ---
    const normPath = tmp('.wav')

    if (compliance.measurementMethod === 'RMS') {
      // ACX path: RMS-based normalization via linear gain
      const targetRms = (compliance.loudnessRange[0] + compliance.loudnessRange[1]) / 2 // -20.5 dBFS
      const currentRms = (await measureAudio(currentPath)).rmsDbfs
      const gainDb = targetRms - currentRms
      await applyLinearGain(currentPath, normPath, gainDb)
    } else {
      // LUFS path: standard/broadcast via loudnorm two-pass
      const targetLufs = (compliance.loudnessRange[0] + compliance.loudnessRange[1]) / 2
      await applyLoudnormLUFS(currentPath, normPath, {
        targetLUFS: targetLufs,
        peakCeiling: compliance.truePeakCeiling,
      })
    }
    currentPath = normPath

    // --- Stage 6: True peak limiting ---
    const limitedPath = tmp('.wav')
    await applyTruePeakLimiter(currentPath, limitedPath, {
      peakCeiling: compliance.truePeakCeiling,
    })
    currentPath = limitedPath

    // --- Measure "after" values ---
    const afterMeasurements = await measureAudio(currentPath)

    // --- Stage 7: Compliance check ---
    const complianceResults = checkCompliance(afterMeasurements, complianceId)

    // --- Encode output ---
    // For now, output as WAV 16-bit (free tier MP3 encoding can be added later)
    const outputPath = tmp('.wav')
    const outputChannels = preset.channelOutput === 'mono' ? 1 : undefined
    await encodeOutput(currentPath, outputPath, {
      format: 'wav',
      channels: outputChannels,
    })

    // --- Extract waveform peaks ---
    const peaks = await extractPeaks(currentPath)

    // --- Build report ---
    const report = buildReport({
      originalName,
      presetId,
      complianceId,
      probe,
      stereoToMono,
      inputSampleRate,
      nrResult,
      beforeMeasurements,
      afterMeasurements,
      complianceResults,
    })

    // --- Build warnings ---
    if (!nrResult.applied) {
      report.warnings.push('Noise reduction not available — noise floor unchanged')
    }
    if (complianceResults.overall_pass === false) {
      if (!complianceResults.loudness_pass) {
        report.warnings.push(
          `Loudness ${afterMeasurements.rmsDbfs} dBFS outside target range ` +
          `[${compliance.loudnessRange[0]}, ${compliance.loudnessRange[1]}]`
        )
      }
      if (!complianceResults.noise_floor_pass) {
        report.warnings.push(
          `Noise floor ${afterMeasurements.noiseFloorDbfs} dBFS exceeds ` +
          `ceiling of ${compliance.noiseFloorCeiling} dBFS`
        )
      }
    }

    // Clean up all temp files except the output
    const toClean = tmpFiles.filter(f => f !== outputPath)
    await Promise.all(toClean.map(removeTmp))

    return { outputPath, report, peaks }
  } catch (err) {
    // Clean up everything on error
    await Promise.all(tmpFiles.map(removeTmp))
    throw err
  }
}

function buildReport({
  originalName, presetId, complianceId, probe, stereoToMono,
  inputSampleRate, nrResult, beforeMeasurements, afterMeasurements,
  complianceResults,
}) {
  const audioStream = probe.streams.find(s => s.codec_type === 'audio')
  const duration = parseFloat(probe.format?.duration || audioStream?.duration || 0)

  return {
    file: originalName,
    preset: presetId,
    compliance: complianceId,
    duration_seconds: Math.round(duration),
    processing_applied: {
      stereo_to_mono: stereoToMono,
      resampled_from: inputSampleRate !== 44100 ? inputSampleRate : null,
      hpf_60hz_notch: false,
      noise_reduction: {
        applied: nrResult.applied,
        tier: nrResult.tier,
        model: nrResult.model,
        pre_noise_floor_dbfs: nrResult.pre_noise_floor_dbfs,
        post_noise_floor_dbfs: nrResult.post_noise_floor_dbfs,
      },
      enhancement_eq: null,  // Sprint 2
      de_esser: null,        // Sprint 3
      compression: null,     // Sprint 3
      normalization_gain_db: round2(afterMeasurements.rmsDbfs - beforeMeasurements.rmsDbfs),
      limiting_max_reduction_db: null, // Would need limiter telemetry
    },
    before: {
      rms_dbfs: beforeMeasurements.rmsDbfs,
      true_peak_dbfs: beforeMeasurements.truePeakDbfs,
      noise_floor_dbfs: beforeMeasurements.noiseFloorDbfs,
      lufs_integrated: beforeMeasurements.lufsIntegrated,
    },
    after: {
      rms_dbfs: afterMeasurements.rmsDbfs,
      true_peak_dbfs: afterMeasurements.truePeakDbfs,
      noise_floor_dbfs: afterMeasurements.noiseFloorDbfs,
      lufs_integrated: afterMeasurements.lufsIntegrated,
    },
    compliance_results: complianceResults,
    human_review_risk: null, // Sprint 2 (ACX-specific risk assessment)
    warnings: [],
  }
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
