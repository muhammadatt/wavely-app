/**
 * Stage 7 — Audio measurement and ACX certification.
 *
 * Measures RMS, true peak, and LUFS of a WAV file.
 *
 * LUFS (integrated loudness) and true peak are measured via the ebur128-wasm
 * WASM binding (libebur128), which is more precise than the FFmpeg loudnorm
 * filter proxy used previously. RMS uses FFmpeg volumedetect since libebur128
 * does not expose RMS.
 *
 * Noise floor is NOT measured here. It comes from the frame-based silence
 * analysis (frameAnalysis.js) and is merged into the measurements object by
 * the measureBefore / measureAfter stages. Previous revisions of this file
 * computed noise floor from FFmpeg volumedetect's histogram by picking the
 * deepest non-zero bucket, but that reports the level of the single quietest
 * sample (dominated by zero-crossings) rather than the actual steady-state
 * silence floor, so it was effectively always below the ACX ceiling and the
 * noise-floor check passed regardless of the real recording. The silence
 * analysis bootstrap is the authoritative source.
 *
 * Sprint 2: Added measureVoicedRms() for silence-excluding RMS measurement
 * used in Stage 5 ACX normalization (spec §5b).
 *
 * Compliance model v2: checkCompliance() replaced by checkAcxCertification()
 * which only runs for acx output profile and checks 6 points (RMS, true peak,
 * noise floor, sample rate, bit depth, channel format).
 */

import { runFfmpeg } from '../lib/exec-ffmpeg.js'
import { OUTPUT_PROFILES } from '../presets.js'
import { readWavSamples, readWavAllChannels } from './wavReader.js'
import {
  ebur128_integrated_mono,
  ebur128_integrated_stereo,
  ebur128_true_peak_mono,
  ebur128_true_peak_stereo,
} from 'ebur128-wasm/ebur128_wasm.js'

/**
 * Measure audio properties of a WAV file.
 * Returns { rmsDbfs, truePeakDbfs, lufsIntegrated }.
 *
 * Note: noiseFloorDbfs is intentionally not included. Callers that need a
 * noise floor should merge one in from frameAnalysis (see measureBefore /
 * measureAfter stages). See file header for rationale.
 */
export async function measureAudio(filePath) {
  const [volumeStats, loudnormStats] = await Promise.all([
    measureVolume(filePath),
    measureLoudness(filePath),
  ])

  return {
    rmsDbfs:        volumeStats.meanVolume,
    truePeakDbfs:   loudnormStats.truePeak,
    lufsIntegrated: loudnormStats.integratedLoudness,
  }
}

/**
 * Use FFmpeg's volumedetect filter for mean/max volume. Noise floor is
 * deliberately not derived from the histogram — see file header.
 */
async function measureVolume(filePath) {
  const { stderr } = await runFfmpeg([
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ])

  const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/)
  const maxMatch  = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/)

  const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : null
  const maxVolume  = maxMatch  ? parseFloat(maxMatch[1])  : null

  return {
    meanVolume: round2(meanVolume),
    maxVolume:  round2(maxVolume),
  }
}

/**
 * Measure integrated LUFS and true peak via libebur128 (WASM binding).
 * Handles both mono and stereo files.
 */
async function measureLoudness(filePath) {
  const { channels, sampleRate } = await readWavAllChannels(filePath)

  if (!channels || channels.length === 0) {
    throw new Error('measureLoudness expected a WAV file with at least one audio channel, but none were found')
  }
  if (channels.length > 2) {
    throw new Error(
      `measureLoudness currently supports only mono or stereo WAV files (got ${channels.length} channels)`
    )
  }

  // Guard against OOM for very long files (2 hours at 44.1 kHz ≈ 317M samples)
  const maxSamplesPerChannel = 2 * 60 * 60 * 44100
  if (channels[0].length > maxSamplesPerChannel) {
    const durationMin = Math.round(channels[0].length / sampleRate / 60)
    throw new Error(`File too long for in-memory LUFS measurement (${durationMin} min, max 120 min)`)
  }

  let integratedLoudness, truePeak

  if (channels.length === 2) {
    integratedLoudness = ebur128_integrated_stereo(sampleRate, channels[0], channels[1])
    truePeak           = ebur128_true_peak_stereo(sampleRate, channels[0], channels[1])
  } else {
    integratedLoudness = ebur128_integrated_mono(sampleRate, channels[0])
    truePeak = ebur128_true_peak_mono(sampleRate, channels[0])
  }

  return {
    integratedLoudness: round2(integratedLoudness),
    truePeak:           round2(truePeak),
  }
}

/**
 * ACX Technical Certification — 6-point deterministic check.
 *
 * Only runs when output_profile = acx. Returns a structured certificate
 * with per-check pass/fail and measured values.
 *
 * @param {object} measurements - { rmsDbfs, truePeakDbfs, noiseFloorDbfs, lufsIntegrated }
 *   noiseFloorDbfs must be merged in by the caller from silence analysis —
 *   measureAudio() does not populate it (see file header).
 * @param {object} fileMetadata - { sampleRate: number, bitDepth: string, channels: number }
 * @returns {{ certificate: 'pass'|'fail', checks: object }}
 */
export function checkAcxCertification(measurements, fileMetadata) {
  const target = OUTPUT_PROFILES.acx

  const rmsPass = measurements.rmsDbfs >= target.loudnessRange[0] &&
                  measurements.rmsDbfs <= target.loudnessRange[1]
  const truePeakPass = measurements.truePeakDbfs <= target.truePeakCeiling
  const noiseFloorPass = measurements.noiseFloorDbfs <= target.noiseFloorCeiling
  const sampleRatePass = fileMetadata.sampleRate === 44100
  // Only WAV (16-bit PCM) output is supported for ACX certification today.
  // MP3 192 kbps CBR is also ACX-valid, but that path is not yet wired up:
  // certification runs on the intermediate WAV before tier-based encoding.
  // When tier-based encoding is added, revisit and probe the actual output file.
  const bitDepthPass = fileMetadata.bitDepth === '16-bit PCM'
  const channelPass = fileMetadata.channels === 1

  const allPass = rmsPass && truePeakPass && noiseFloorPass &&
                  sampleRatePass && bitDepthPass && channelPass

  return {
    certificate: allPass ? 'pass' : 'fail',
    checks: {
      rms: {
        value_dbfs: measurements.rmsDbfs,
        min: target.loudnessRange[0],
        max: target.loudnessRange[1],
        pass: rmsPass,
      },
      true_peak: {
        value_dbfs: measurements.truePeakDbfs,
        ceiling: target.truePeakCeiling,
        pass: truePeakPass,
      },
      noise_floor: {
        value_dbfs: measurements.noiseFloorDbfs,
        ceiling: target.noiseFloorCeiling,
        pass: noiseFloorPass,
      },
      sample_rate: {
        value_hz: fileMetadata.sampleRate,
        required: 44100,
        pass: sampleRatePass,
      },
      bit_depth: {
        value: fileMetadata.bitDepth,
        required: '16-bit PCM',
        pass: bitDepthPass,
      },
      channel: {
        value: fileMetadata.channels === 1 ? 'mono' : 'stereo',
        required: 'mono',
        pass: channelPass,
      },
    },
  }
}

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}

/**
 * Measure RMS of voiced frames only, excluding silence.
 *
 * Implements spec §5b silence exclusion:
 *   silence_threshold = noise_floor + 6 dB
 *
 * Used for ACX RMS-based normalization so silence frames don't pull
 * the measured level below the true voiced speech level.
 *
 * @param {string} wavPath
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {number} Voiced RMS in dBFS
 */
export async function measureVoicedRms(wavPath, frameAnalysis) {
  // If we have a frame analysis, use the pre-computed voiced RMS
  if (frameAnalysis && frameAnalysis.voicedRmsDbfs !== undefined) {
    return frameAnalysis.voicedRmsDbfs
  }

  // Fallback: compute from scratch without silence analysis
  const { samples, sampleRate } = await readWavSamples(wavPath)
  const frameSamples = Math.round(0.1 * sampleRate)  // 100 ms frames
  const numFrames    = Math.floor(samples.length / frameSamples)

  if (numFrames === 0) return -60

  // Bootstrap noise floor from lowest 20 frames, combined in the power
  // domain so the result is the RMS of the combined quietest frames rather
  // than the mean of per-frame RMS values. Matches frameAnalysis.js.
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const s = f * frameSamples
    let sq  = 0
    for (let i = s; i < s + frameSamples; i++) sq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sq / frameSamples)
  }

  const sorted = Float64Array.from(frameRms).sort()
  const n = Math.min(20, sorted.length)
  let noiseSumSq = 0
  for (let i = 0; i < n; i++) noiseSumSq += sorted[i] * sorted[i]
  const noiseRms = n > 0 ? Math.sqrt(noiseSumSq / n) : 0

  const noiseFloorDb  = noiseRms > 0 ? 20 * Math.log10(noiseRms) : -120
  const thresholdDb   = noiseFloorDb + 6

  let voicedSumSq = 0
  let count       = 0
  for (let f = 0; f < numFrames; f++) {
    const db = frameRms[f] > 0 ? 20 * Math.log10(frameRms[f]) : -120
    if (db >= thresholdDb) {
      voicedSumSq += frameRms[f] * frameRms[f]
      count++
    }
  }

  if (count === 0) return round2(noiseFloorDb)
  const rms = Math.sqrt(voicedSumSq / count)
  return round2(rms > 0 ? 20 * Math.log10(rms) : -120)
}

/**
 * Measure integrated LUFS of voiced frames only, excluding silence.
 *
 * Implements spec §5b silence exclusion for LUFS-based output profiles
 * (podcast, broadcast). Zeroes out silence-frame samples in the per-channel
 * PCM buffer and feeds the result to libebur128 — the zeros are absolute-
 * gated (< -70 LUFS) by R128 so they do not contribute to the integrated
 * measurement, giving a silence-excluded result without allocating a second
 * channel buffer.
 *
 * Why this exists: FFmpeg's `loudnorm` relies only on EBU R128's built-in
 * gating (-70 LUFS absolute + -10 LU relative), which does not track a
 * file-specific noise floor. On recordings with elevated room tone, the
 * relative gate fails to exclude the silence, dragging the measured
 * integrated loudness below the true voiced level and inflating applied
 * gain — resulting in output that is louder than the configured target.
 * Excluding frames flagged silent by the pipeline's silence analysis is
 * the spec-aligned fix.
 *
 * Voicing source: the `isSilence` labels come from whichever backend
 * `analyzeAudioFrames` used. With `VAD_BACKEND=silero` (default) they are
 * Silero VAD v5 neural predictions, with an energy fallback of
 * `noise_floor + 6 dB` for any frame the Silero output does not cover.
 * With `VAD_BACKEND=energy` the labels come entirely from the
 * `noise_floor + 6 dB` threshold. Either way, using `frame.isSilence`
 * keeps this measurement consistent with `measureVoicedRms` and the rest
 * of the pipeline.
 *
 * @param {string} wavPath
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {Promise<number>} Voiced integrated LUFS
 */
export async function measureVoicedLufs(wavPath, frameAnalysis) {
  if (!frameAnalysis || !Array.isArray(frameAnalysis.frames)) {
    throw new Error('measureVoicedLufs requires a frameAnalysis with frames[]')
  }

  const { frames } = frameAnalysis
  let voicedFrameCount = 0
  for (const f of frames) if (!f.isSilence) voicedFrameCount++

  if (voicedFrameCount === 0) {
    throw new Error(
      'Audio level is too low to measure — no voiced frames detected. ' +
      'The file appears to be silent or contains only sub-threshold noise. ' +
      'Check your recording level and try again.'
    )
  }

  const { channels, sampleRate, numChannels, numSamples } = await readWavAllChannels(wavPath)

  if (numChannels === 0) {
    throw new Error('measureVoicedLufs expected a WAV file with at least one audio channel')
  }
  if (numChannels > 2) {
    throw new Error(
      `measureVoicedLufs currently supports only mono or stereo WAV files (got ${numChannels} channels)`
    )
  }

  // OOM guard — matches measureLoudness (2 hours at 44.1 kHz ≈ 317M samples).
  const maxSamplesPerChannel = 2 * 60 * 60 * 44100
  if (numSamples > maxSamplesPerChannel) {
    const durationMin = Math.round(numSamples / sampleRate / 60)
    throw new Error(
      `File too long for in-memory voiced-LUFS measurement (${durationMin} min, max 120 min)`
    )
  }

  // Mute silent frames in place. `channels[]` was freshly allocated by
  // readWavAllChannels, so mutating it is safe. Zeros fall below R128's
  // -70 LUFS absolute gate and are therefore excluded from the integrated
  // measurement. Zeroing also avoids the boundary discontinuities that a
  // naive voiced-frame concatenation would introduce.
  for (const frame of frames) {
    if (!frame.isSilence) continue
    const { offsetSamples, lengthSamples } = frame
    for (let ch = 0; ch < numChannels; ch++) {
      const arr = channels[ch]
      const end = Math.min(offsetSamples + lengthSamples, arr.length)
      arr.fill(0, offsetSamples, end)
    }
  }

  const integrated = numChannels === 2
    ? ebur128_integrated_stereo(sampleRate, channels[0], channels[1])
    : ebur128_integrated_mono(sampleRate, channels[0])

  if (!Number.isFinite(integrated)) {
    throw new Error(
      'Audio level is too low to measure — integrated loudness is non-finite ' +
      'after voiced-frame extraction. Check your recording level and try again.'
    )
  }

  return round2(integrated)
}
