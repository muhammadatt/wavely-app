/**
 * Processing Pipeline Orchestrator.
 *
 * Runs the full preset processing chain on an uploaded audio file.
 *
 * Sprint 1 stages implemented:
 *   Stage 0:   Decode → 32-bit float PCM 44.1 kHz
 *   Stage 1:   High-pass filter (80 Hz Butterworth 4th order)
 *   Stage 2:   Noise reduction (STUB — pass-through)
 *   Stage 5:   Loudness normalization (RMS for ACX, LUFS for others)
 *   Stage 6:   True peak limiting
 *   Stage 7:   Measurement + compliance report
 *
 * Sprint 2 additions:
 *   Stage 2a:  Silence analysis pass (frame-level silence/voiced detection)
 *   Stage 3:   Enhancement EQ (Meyda.js spectral analysis → FFmpeg parametric EQ)
 *   Stage 5:   RMS normalization now uses voiced-frame RMS (silence excluded)
 *   Room tone: ACX-only head/tail padding using actual room tone
 *   Stage 7:   Extended report — human review risk, breath/plosive detection,
 *              overprocessing detection, notch-60Hz conditional
 *
 * Stages 4 (de-esser) and 4a (compression) are Sprint 3.
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
  applyParametricEQ,
  encodeOutput,
  probeFile,
} from '../lib/ffmpeg.js'
import { applyNoiseReduction } from './noiseReduce.js'
import { measureAudio, measureVoicedRms, checkCompliance } from './measure.js'
import { extractPeaks } from './peaks.js'
import { analyzeAudioFrames } from './silenceAnalysis.js'
import { analyzeSpectrum } from './enhancementEQ.js'
import { applyRoomTonePadding } from './roomTone.js'
import { assessRisks } from './riskAssessment.js'

/**
 * Process an audio file through the preset chain.
 *
 * @param {string} inputPath     - Path to the uploaded audio file
 * @param {string} originalName  - Original filename
 * @param {string} presetId      - Preset ID (e.g. 'acx_audiobook')
 * @param {string} complianceId  - Compliance target ID (e.g. 'acx')
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
    const inputChannels   = audioStream?.channels || 1

    // --- Stage 0: Decode to 32-bit float PCM 44.1 kHz ---
    const decodedPath = tmp('.wav')
    await decodeToFloat32(inputPath, decodedPath)

    // --- Stage 0b: Channel handling ---
    let currentPath  = decodedPath
    let stereoToMono = false

    if (preset.channelOutput === 'mono' && inputChannels > 1) {
      const monoPath = tmp('.wav')
      await mixdownToMono(currentPath, monoPath)
      currentPath  = monoPath
      stereoToMono = true
    }

    // --- Stage 2a: Silence analysis (Sprint 2) ---
    // Must run before Stage 1 HPF so that the 60 Hz notch detection can use
    // the raw noise floor, and before Stage 2 so room tone source is identified
    // from pre-NR signal. We re-run after HPF for EQ and room tone (see below).
    const preHpfSilenceAnalysis = await analyzeAudioFrames(currentPath)
    const { noiseFloorDbfs: rawNoiseFloor } = preHpfSilenceAnalysis

    // Detect 60 Hz hum: if tonal energy at 50/60 Hz is > 6 dB above noise floor
    // (simplified heuristic: noise floor above -55 dBFS often indicates hum)
    const notch60Hz = await detect60HzHum(currentPath, rawNoiseFloor)

    // --- Measure "before" values ---
    const beforeMeasurements = await measureAudio(currentPath)

    // --- Stage 1: High-pass filter ---
    const hpfPath = tmp('.wav')
    await applyHighPass(currentPath, hpfPath, { notch60Hz })
    currentPath = hpfPath

    // --- Stage 2: Noise reduction (STUB — Sprint 1 placeholder) ---
    const nrPath    = tmp('.wav')
    const nrCeiling = preset.noiseReductionCeiling <= 8 ? 3 : 4
    const nrResult  = await applyNoiseReduction(currentPath, nrPath, {
      ceilingTier:      nrCeiling,
      noiseFloorDbfs:   beforeMeasurements.noiseFloorDbfs,
    })
    currentPath = nrPath

    // --- Stage 2a (post-NR): Re-analyze silence on HPF+NR output ---
    // This is the definitive silence analysis used for room tone and EQ
    const silenceAnalysis = await analyzeAudioFrames(currentPath)

    // --- Room tone padding (ACX Audiobook only) ---
    let roomToneResult = { applied: false, headAdded_s: 0, tailAdded_s: 0 }
    if (presetId === 'acx_audiobook') {
      const paddedPath = tmp('.wav')
      roomToneResult = await applyRoomTonePadding(currentPath, paddedPath, silenceAnalysis)
      currentPath = paddedPath
    }

    // --- Stage 3: Enhancement EQ (Sprint 2) ---
    const eqResult = await analyzeSpectrum(
      currentPath,
      presetId,
      silenceAnalysis,
      silenceAnalysis.noiseFloorDbfs
    )
    const eqPath = tmp('.wav')
    await applyParametricEQ(currentPath, eqPath, eqResult.ffmpegFilters)
    currentPath = eqPath

    // --- Stage 4: De-esser (Sprint 3) ---
    // --- Stage 4a: Compression (Sprint 3) ---

    // --- Stage 5: Loudness normalization ---
    // Sprint 2: Use voiced-frame RMS for ACX path (silence excluded per spec §5b)
    const normPath = tmp('.wav')

    if (compliance.measurementMethod === 'RMS') {
      // ACX path: voiced-frame RMS normalization
      const targetRms    = (compliance.loudnessRange[0] + compliance.loudnessRange[1]) / 2 // -20.5 → ~-20 dBFS
      const voicedRms    = await measureVoicedRms(currentPath, silenceAnalysis)
      const gainDb       = targetRms - voicedRms

      if (gainDb > 18) {
        // Edge case warning: recording level very low (spec §5c)
        console.warn(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
      }

      await applyLinearGain(currentPath, normPath, gainDb)
    } else {
      // LUFS path: standard/broadcast via loudnorm two-pass
      const targetLufs = (compliance.loudnessRange[0] + compliance.loudnessRange[1]) / 2
      await applyLoudnormLUFS(currentPath, normPath, {
        targetLUFS:  targetLufs,
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

    // --- Stage 7b: Quality risk assessment (Sprint 2) ---
    const riskResult = await assessRisks(
      currentPath,
      presetId,
      silenceAnalysis,
      silenceAnalysis.voicedRmsDbfs
    )

    // --- Encode output ---
    const outputPath     = tmp('.wav')
    const outputChannels = preset.channelOutput === 'mono' ? 1 : undefined
    await encodeOutput(currentPath, outputPath, {
      format:   'wav',
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
      notch60Hz,
      nrResult,
      eqResult,
      roomToneResult,
      beforeMeasurements,
      afterMeasurements,
      complianceResults,
      riskResult,
    })

    // --- Append warnings ---
    if (!nrResult.applied) {
      report.warnings.push('Noise reduction not available — noise floor unchanged')
    }
    if (complianceResults.overall_pass === false) {
      if (!complianceResults.loudness_pass) {
        const metric = compliance.measurementMethod === 'RMS'
          ? `${afterMeasurements.rmsDbfs} dBFS RMS`
          : `${afterMeasurements.lufsIntegrated} LUFS`
        report.warnings.push(
          `Loudness ${metric} outside target range ` +
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

    // Merge risk assessment warnings into report
    for (const w of riskResult.warnings) {
      if (!report.warnings.includes(w)) report.warnings.push(w)
    }

    // Clean up all temp files except the output
    const toClean = tmpFiles.filter(f => f !== outputPath)
    await Promise.all(toClean.map(removeTmp))

    return { outputPath, report, peaks }
  } catch (err) {
    await Promise.all(tmpFiles.map(removeTmp))
    throw err
  }
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport({
  originalName, presetId, complianceId, probe, stereoToMono,
  inputSampleRate, notch60Hz, nrResult, eqResult, roomToneResult,
  beforeMeasurements, afterMeasurements, complianceResults, riskResult,
}) {
  const audioStream = probe.streams.find(s => s.codec_type === 'audio')
  const duration    = parseFloat(probe.format?.duration || audioStream?.duration || 0)

  // Enhancement EQ band summary for report (spec §7c shape)
  const eqReport = eqResult.applied ? {
    profile:        eqResult.profile,
    mud_cut:        bandReport(eqResult.bands.mud_cut),
    warmth_boost:   bandReport(eqResult.bands.warmth_boost),
    clarity_cut:    bandReport(eqResult.bands.clarity_cut),
    presence_boost: bandReport(eqResult.bands.presence_boost),
    air_boost:      bandReport(eqResult.bands.air_boost),
  } : null

  return {
    file:             originalName,
    preset:           presetId,
    compliance:       complianceId,
    duration_seconds: Math.round(duration),
    processing_applied: {
      stereo_to_mono:    stereoToMono,
      resampled_from:    inputSampleRate !== 44100 ? inputSampleRate : null,
      hpf_60hz_notch:    notch60Hz,
      noise_reduction: {
        applied:               nrResult.applied,
        tier:                  nrResult.tier,
        model:                 nrResult.model,
        pre_noise_floor_dbfs:  nrResult.pre_noise_floor_dbfs,
        post_noise_floor_dbfs: nrResult.post_noise_floor_dbfs,
      },
      enhancement_eq:  eqReport,
      room_tone_padding: presetId === 'acx_audiobook' ? {
        applied:       roomToneResult.applied,
        head_added_s:  roomToneResult.headAdded_s,
        tail_added_s:  roomToneResult.tailAdded_s,
      } : null,
      de_esser:        null,  // Sprint 3
      compression:     null,  // Sprint 3
      normalization_gain_db: round2(afterMeasurements.rmsDbfs - beforeMeasurements.rmsDbfs),
      limiting_max_reduction_db: null,
    },
    before: {
      rms_dbfs:        beforeMeasurements.rmsDbfs,
      true_peak_dbfs:  beforeMeasurements.truePeakDbfs,
      noise_floor_dbfs: beforeMeasurements.noiseFloorDbfs,
      lufs_integrated: beforeMeasurements.lufsIntegrated,
    },
    after: {
      rms_dbfs:        afterMeasurements.rmsDbfs,
      true_peak_dbfs:  afterMeasurements.truePeakDbfs,
      noise_floor_dbfs: afterMeasurements.noiseFloorDbfs,
      lufs_integrated: afterMeasurements.lufsIntegrated,
    },
    compliance_results:   complianceResults,
    human_review_risk:    riskResult.humanReviewRisk,
    overprocessing:       riskResult.overprocessing,
    warnings:             [],
  }
}

function bandReport(band) {
  if (!band || !band.applied) return { applied: false }
  return { applied: true, freq_hz: band.freq_hz, gain_db: band.gain_db }
}

// ── 60 Hz hum detection ───────────────────────────────────────────────────────

/**
 * Simplified heuristic: check if noise floor is elevated enough to suggest hum.
 * A proper implementation would do spectral analysis on silence frames.
 * We use the raw noise floor as a proxy — if > -55 dBFS, there's likely a
 * noise source present and the 60 Hz notch is worth applying.
 *
 * Sprint 2 note: Full spectral tonal detection (per spec §1 supplementary)
 * is deferred to when silence-frame spectral analysis is added.
 */
async function detect60HzHum(wavPath, rawNoiseFloor) {
  // If noise floor is above -55 dBFS, apply the 60 Hz notch conservatively
  return rawNoiseFloor > -55
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
