/**
 * Stage 7 — Audio measurement and compliance checking.
 *
 * Measures RMS, true peak, noise floor, and LUFS of a WAV file.
 * Uses FFmpeg filters for measurement since node-ebur128 requires
 * native compilation. This approach works with any system that has FFmpeg.
 *
 * Sprint 2: Added measureVoicedRms() for silence-excluding RMS measurement
 * used in Stage 5 ACX normalization (spec §5b).
 *
 * Future: replace with libebur128 bindings for better precision.
 */

import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { COMPLIANCE_TARGETS } from '../presets.js'
import { readWavSamples } from './wavReader.js'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

/**
 * Measure audio properties of a WAV file.
 * Returns { rmsDbfs, truePeakDbfs, noiseFloorDbfs, lufsIntegrated }.
 */
export async function measureAudio(filePath) {
  const [volumeStats, loudnormStats] = await Promise.all([
    measureVolume(filePath),
    measureLoudness(filePath),
  ])

  return {
    rmsDbfs: volumeStats.meanVolume,
    truePeakDbfs: loudnormStats.truePeak,
    noiseFloorDbfs: volumeStats.noiseFloor,
    lufsIntegrated: loudnormStats.integratedLoudness,
  }
}

/**
 * Use FFmpeg's volumedetect filter for RMS and peak measurements.
 */
function measureVolume(filePath) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    ffmpeg(filePath)
      .audioFilters('volumedetect')
      .format('null')
      .output('-')
      .on('stderr', (line) => { stderr += line + '\n' })
      .on('error', reject)
      .on('end', () => {
        const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/)
        const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/)

        const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : null
        const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : null

        // Estimate noise floor from the histogram data if available,
        // otherwise use a rough estimate (mean - 20 dB as placeholder).
        // True noise floor measurement requires silence frame analysis.
        const histMatches = [...stderr.matchAll(/histogram_(\d+)db:\s*(\d+)/g)]
        let noiseFloor = meanVolume ? meanVolume - 20 : -60

        if (histMatches.length > 0) {
          // The deepest non-zero histogram bucket approximates the noise floor
          const deepest = histMatches.reduce((min, m) =>
            parseInt(m[1]) > parseInt(min[1]) ? m : min
          )
          noiseFloor = -parseInt(deepest[1])
        }

        resolve({
          meanVolume: round2(meanVolume),
          maxVolume: round2(maxVolume),
          noiseFloor: round2(noiseFloor),
        })
      })
      .run()
  })
}

/**
 * Use FFmpeg's loudnorm filter (pass 1) for LUFS and true peak.
 */
function measureLoudness(filePath) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    ffmpeg(filePath)
      .audioFilters('loudnorm=I=-16:TP=-1:LRA=11:print_format=json')
      .format('null')
      .output('-')
      .on('stderr', (line) => { stderr += line + '\n' })
      .on('error', reject)
      .on('end', () => {
        try {
          const jsonMatch = stderr.match(/\{[\s\S]*?\}/)
          if (!jsonMatch) throw new Error('Could not parse loudnorm output')
          const data = JSON.parse(jsonMatch[0])

          resolve({
            integratedLoudness: parseFloat(data.input_i),
            truePeak: parseFloat(data.input_tp),
            lra: parseFloat(data.input_lra),
            threshold: parseFloat(data.input_thresh),
          })
        } catch (err) {
          reject(err)
        }
      })
      .run()
  })
}

/**
 * Check compliance of measurements against a compliance target.
 */
export function checkCompliance(measurements, complianceId) {
  const target = COMPLIANCE_TARGETS[complianceId]
  if (!target) throw new Error(`Unknown compliance target: ${complianceId}`)

  const results = {
    target: complianceId,
    loudness_pass: false,
    true_peak_pass: false,
    noise_floor_pass: true, // default true if not enforced
    overall_pass: false,
  }

  // Loudness check
  if (target.measurementMethod === 'RMS') {
    const rms = measurements.rmsDbfs
    results.loudness_pass = rms >= target.loudnessRange[0] && rms <= target.loudnessRange[1]
  } else {
    const lufs = measurements.lufsIntegrated
    results.loudness_pass = lufs >= target.loudnessRange[0] && lufs <= target.loudnessRange[1]
  }

  // True peak check
  results.true_peak_pass = measurements.truePeakDbfs <= target.truePeakCeiling

  // Noise floor check (only enforced for ACX)
  if (target.noiseFloorCeiling !== null) {
    results.noise_floor_pass = measurements.noiseFloorDbfs <= target.noiseFloorCeiling
  }

  results.overall_pass = results.loudness_pass && results.true_peak_pass && results.noise_floor_pass

  return results
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
 * @param {import('./silenceAnalysis.js').SilenceAnalysis} silenceAnalysis
 * @returns {number} Voiced RMS in dBFS
 */
export async function measureVoicedRms(wavPath, silenceAnalysis) {
  // If we have silence analysis, use the pre-computed voiced RMS
  if (silenceAnalysis && silenceAnalysis.voicedRmsDbfs !== undefined) {
    return silenceAnalysis.voicedRmsDbfs
  }

  // Fallback: compute from scratch without silence analysis
  const { samples, sampleRate } = await readWavSamples(wavPath)
  const frameSamples = Math.round(0.1 * sampleRate)  // 100 ms frames
  const numFrames    = Math.floor(samples.length / frameSamples)

  if (numFrames === 0) return -60

  // Bootstrap noise floor from lowest 20 frames
  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const s = f * frameSamples
    let sq  = 0
    for (let i = s; i < s + frameSamples; i++) sq += samples[i] * samples[i]
    frameRms[f] = Math.sqrt(sq / frameSamples)
  }

  const sorted = Float64Array.from(frameRms).sort()
  let noiseRms = 0
  const n = Math.min(20, sorted.length)
  for (let i = 0; i < n; i++) noiseRms += sorted[i]
  noiseRms /= n

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
