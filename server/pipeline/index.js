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
 *   Stage 7:   Extended report — quality advisory flags, breath/plosive detection,
 *              overprocessing detection, notch-60Hz conditional
 *
 * Sprint 3 additions:
 *   Stage 4:   De-esser (F0 estimation → sibilance analysis → conditional
 *              frequency-selective compressor)
 *   Stage 4a:  Compression (feed-forward RMS compressor, soft knee;
 *              conditional for ACX Audiobook via crest-factor gate)
 *
 * Compliance model v2:
 *   - "compliance target" renamed to "output profile"
 *   - ACX certification (6-point) only runs for acx output profile
 *   - Quality advisory flags replace aggregate human_review_risk
 *   - Report JSON restructured per compliance model v2 spec
 */

import { PRESETS, OUTPUT_PROFILES } from '../presets.js'
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
import { runFfmpeg } from '../lib/exec-ffmpeg.js'
import { applyNoiseReduction } from './noiseReduce.js'
import { measureAudio, measureVoicedRms, checkAcxCertification } from './measure.js'
import { extractPeaks } from './peaks.js'
import { analyzeAudioFrames } from './silenceAnalysis.js'
import { analyzeSpectrum } from './enhancementEQ.js'
import { applyRoomTonePadding } from './roomTone.js'
import { generateQualityAdvisory } from './riskAssessment.js'
import { analyzeAndDeEss } from './deEsser.js'
import { applyCompression } from './compression.js'

/**
 * Process an audio file through the preset chain.
 *
 * @param {string} inputPath       - Path to the uploaded audio file
 * @param {string} originalName    - Original filename
 * @param {string} presetId        - Preset ID (e.g. 'acx_audiobook')
 * @param {string} outputProfileId - Output profile ID (e.g. 'acx')
 * @returns {{ outputPath: string, report: object, peaks: object[] }}
 */
export async function processAudio(inputPath, originalName, presetId, outputProfileId) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)
  const outputProfile = OUTPUT_PROFILES[outputProfileId]
  if (!outputProfile) throw new Error(`Unknown output profile: ${outputProfileId}`)

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
    const inputBitDepth   = audioStream?.bits_per_sample
      ? `${audioStream.bits_per_sample}-bit PCM`
      : (audioStream?.codec_name || 'unknown')

    if (inputChannels > 2) {
      throw new Error(
        `Unsupported channel count: ${inputChannels}. Only mono and stereo files are supported.`
      )
    }

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

    // Determine output channel count for metadata
    const outputChannelCount = preset.channelOutput === 'mono' ? 1 : inputChannels

    // --- Stage 2a: Silence analysis (Sprint 2) ---
    const preHpfSilenceAnalysis = await analyzeAudioFrames(currentPath)
    const { noiseFloorDbfs: rawNoiseFloor } = preHpfSilenceAnalysis

    const notch60Hz = await detect60HzHum(currentPath, rawNoiseFloor)

    // --- Measure "before" values ---
    const beforeMeasurements = await measureAudio(currentPath)

    // --- Stage 1: High-pass filter ---
    const hpfPath = tmp('.wav')
    await applyHighPass(currentPath, hpfPath, { notch60Hz })
    currentPath = hpfPath
    await logLevel('after HPF', currentPath, { notch60Hz })

    // --- Stage 2: Noise reduction ---
    const nrPath    = tmp('.wav')
    const nrCeiling = ceilingTierFromMaxDb(preset.noiseReductionCeiling)
    const nrResult  = await applyNoiseReduction(currentPath, nrPath, {
      ceilingTier:      nrCeiling,
      noiseFloorDbfs:   beforeMeasurements.noiseFloorDbfs,
    })
    currentPath = nrPath
    await logLevel('after NR', currentPath, {
      tier:         nrResult.tier,
      attenLim:     nrResult.atten_lim_db !== null ? `${nrResult.atten_lim_db}dB` : 'none',
      preNoiseFloor: `${nrResult.pre_noise_floor_dbfs}dBFS`,
    })

    // --- Stage 2a (post-NR): Re-analyze silence on HPF+NR output ---
    const silenceAnalysis = await analyzeAudioFrames(currentPath)
    logSilence('post-NR', silenceAnalysis)

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
    await logLevel('after EQ', currentPath, {
      applied: eqResult.applied,
      filters: eqResult.ffmpegFilters.length,
    })

    // --- Stage 4: De-esser ---
    const preDeEssSilenceAnalysis = await analyzeAudioFrames(currentPath)
    const deEssPath = tmp('.wav')
    const deEssResult = await analyzeAndDeEss(
      currentPath,
      deEssPath,
      presetId,
      preDeEssSilenceAnalysis
    )
    currentPath = deEssPath
    await logLevel('after de-esser', currentPath, {
      applied:    deEssResult.applied,
      voiceType:  deEssResult.voiceType  ?? 'n/a',
      f0:         deEssResult.f0Hz       !== null ? `${deEssResult.f0Hz}Hz`          : 'n/a',
      maxRed:     deEssResult.maxReductionDb !== null ? `${deEssResult.maxReductionDb}dB` : 'n/a',
    })

    // --- Stage 4a: Compression ---
    const compPath = tmp('.wav')
    const compressionResult = await applyCompression(
      currentPath,
      compPath,
      presetId,
      preDeEssSilenceAnalysis
    )
    currentPath = compPath
    await logLevel('after compression', currentPath, {
      applied: compressionResult.applied,
      crest:   compressionResult.crestFactorDb    !== null ? `${compressionResult.crestFactorDb}dB`    : 'n/a',
      maxRed:  compressionResult.maxGainReductionDb !== null ? `${compressionResult.maxGainReductionDb}dB` : 'n/a',
      avgRed:  compressionResult.avgGainReductionDb !== null ? `${compressionResult.avgGainReductionDb}dB` : 'n/a',
    })

    // --- Stage 5: Loudness normalization ---
    const normPath = tmp('.wav')

    let normExtras = {}
    if (outputProfile.measurementMethod === 'RMS') {
      // ACX path: voiced-frame RMS normalization
      const targetRms              = (outputProfile.loudnessRange[0] + outputProfile.loudnessRange[1]) / 2
      const prNormSilenceAnalysis  = await analyzeAudioFrames(currentPath)
      const voicedRms              = await measureVoicedRms(currentPath, prNormSilenceAnalysis)
      const gainDb                 = targetRms - voicedRms

      if (gainDb > 18) {
        console.warn(`[pipeline] Very low recording level — gain required: ${gainDb.toFixed(1)} dB`)
      }

      await applyLinearGain(currentPath, normPath, gainDb)
      normExtras = {
        method:    'RMS',
        target:    `${targetRms}dBFS`,
        voicedRms: `${round2(voicedRms)}dBFS`,
        gainApplied: `${round2(gainDb)}dB`,
      }
    } else {
      // LUFS path: podcast/broadcast via loudnorm two-pass
      const targetLufs = (outputProfile.loudnessRange[0] + outputProfile.loudnessRange[1]) / 2
      await applyLoudnormLUFS(currentPath, normPath, {
        targetLUFS:  targetLufs,
        peakCeiling: outputProfile.truePeakCeiling,
      })
      normExtras = {
        method:  'LUFS',
        target:  `${targetLufs}LUFS`,
        tp:      `${outputProfile.truePeakCeiling}dBTP`,
      }
    }
    currentPath = normPath
    await logLevel('after normalization', currentPath, normExtras)

    // --- Stage 6: True peak limiting ---
    const limitedPath = tmp('.wav')
    await applyTruePeakLimiter(currentPath, limitedPath, {
      peakCeiling: outputProfile.truePeakCeiling,
    })
    currentPath = limitedPath
    await logLevel('after limiting', currentPath, { tp: `${outputProfile.truePeakCeiling}dBTP` })

    // --- Measure "after" values ---
    const afterMeasurements = await measureAudio(currentPath)

    // --- Stage 7: ACX certification (only for acx output profile) ---
    let acxCertification = undefined
    if (outputProfileId === 'acx') {
      const fileMetadata = {
        sampleRate: 44100, // We always decode to 44.1 kHz
        bitDepth: '16-bit PCM', // Output is always 16-bit PCM WAV
        channels: outputChannelCount,
      }
      acxCertification = checkAcxCertification(afterMeasurements, fileMetadata)
    }

    // --- Stage 7b: Quality advisory flags ---
    const postProcessSilenceAnalysis = await analyzeAudioFrames(currentPath)
    const qualityAdvisory = await generateQualityAdvisory(
      currentPath,
      presetId,
      outputProfileId,
      postProcessSilenceAnalysis,
      postProcessSilenceAnalysis.voicedRmsDbfs,
      {
        nrTier: nrResult.tier,
        noiseFloorDbfs: afterMeasurements.noiseFloorDbfs,
      }
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
      outputProfileId,
      probe,
      stereoToMono,
      inputSampleRate,
      notch60Hz,
      nrResult,
      eqResult,
      roomToneResult,
      deEssResult,
      compressionResult,
      beforeMeasurements,
      afterMeasurements,
      acxCertification,
      qualityAdvisory,
    })

    // --- Append warnings ---
    if (!nrResult.applied) {
      report.warnings.push('Noise reduction not available — noise floor unchanged')
    }
    if (acxCertification && acxCertification.certificate === 'fail') {
      const checks = acxCertification.checks
      if (!checks.rms.pass) {
        report.warnings.push(
          `RMS ${checks.rms.value_dbfs} dBFS outside target range ` +
          `[${checks.rms.min}, ${checks.rms.max}]`
        )
      }
      if (!checks.noise_floor.pass) {
        report.warnings.push(
          `Noise floor ${checks.noise_floor.value_dbfs} dBFS exceeds ` +
          `ceiling of ${checks.noise_floor.ceiling} dBFS`
        )
      }
      if (!checks.true_peak.pass) {
        report.warnings.push(
          `True peak ${checks.true_peak.value_dbfs} dBFS exceeds ` +
          `ceiling of ${checks.true_peak.ceiling} dBFS`
        )
      }
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

// ── Noise reduction tier mapping ──────────────────────────────────────────────

function ceilingTierFromMaxDb(maxDb) {
  if (maxDb == null) return 0
  if (maxDb <= 3)  return 1
  if (maxDb <= 6)  return 2
  if (maxDb <= 9)  return 3
  if (maxDb <= 12) return 4
  return 5
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport({
  originalName, presetId, outputProfileId, probe, stereoToMono,
  inputSampleRate, notch60Hz, nrResult, eqResult, roomToneResult,
  deEssResult, compressionResult,
  beforeMeasurements, afterMeasurements, acxCertification, qualityAdvisory,
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

  const report = {
    file:             originalName,
    preset:           presetId,
    output_profile:   outputProfileId,
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
      de_esser: deEssResult ? {
        applied:           deEssResult.applied,
        f0_hz:             deEssResult.f0Hz,
        voice_type:        deEssResult.voiceType,
        target_freq_hz:    deEssResult.targetFreqHz,
        max_reduction_db:  deEssResult.maxReductionDb,
        p95_energy_db:     deEssResult.p95EnergyDb,
        mean_energy_db:    deEssResult.meanEnergyDb,
        trigger_reason:    deEssResult.triggerReason,
      } : null,
      compression: compressionResult ? {
        applied:              compressionResult.applied,
        skipped_reason:       compressionResult.skippedReason,
        crest_factor_db:      compressionResult.crestFactorDb,
        max_gain_reduction_db: compressionResult.maxGainReductionDb,
        avg_gain_reduction_db: compressionResult.avgGainReductionDb,
        ratio:                compressionResult.params?.ratio ?? null,
        threshold_db:         compressionResult.params?.threshold ?? null,
      } : null,
      normalization_gain_db: round2(afterMeasurements.rmsDbfs - beforeMeasurements.rmsDbfs),
      limiting_max_reduction_db: null,
    },
    measurements: {
      before: {
        rms_dbfs:        beforeMeasurements.rmsDbfs,
        lufs_integrated: beforeMeasurements.lufsIntegrated,
        true_peak_dbfs:  beforeMeasurements.truePeakDbfs,
        noise_floor_dbfs: beforeMeasurements.noiseFloorDbfs,
      },
      after: {
        rms_dbfs:        afterMeasurements.rmsDbfs,
        lufs_integrated: afterMeasurements.lufsIntegrated,
        true_peak_dbfs:  afterMeasurements.truePeakDbfs,
        noise_floor_dbfs: afterMeasurements.noiseFloorDbfs,
      },
    },
    quality_advisory: qualityAdvisory,
    warnings:         [],
  }

  // acx_certification is absent (not null) when output_profile is not acx
  if (acxCertification !== undefined) {
    report.acx_certification = acxCertification
  }

  return report
}

function bandReport(band) {
  if (!band || !band.applied) return { applied: false }
  return { applied: true, freq_hz: band.freq_hz, gain_db: band.gain_db }
}

// ── 60 Hz hum detection ───────────────────────────────────────────────────────

async function detect60HzHum(wavPath, rawNoiseFloor) {
  return rawNoiseFloor > -55
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function logLevel(label, filePath, extras = {}) {
  try {
    const { stderr } = await runFfmpeg([
      '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
    ])
    const peak = stderr.match(/max_volume:\s*([-\d.inf]+)\s*dB/)?.[1]  ?? '?'
    const mean = stderr.match(/mean_volume:\s*([-\d.inf]+)\s*dB/)?.[1] ?? '?'
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
