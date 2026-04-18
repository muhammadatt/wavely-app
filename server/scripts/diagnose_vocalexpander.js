#!/usr/bin/env node
/**
 * Diagnostic script to debug vocalExpander detection-band calibration.
 *
 * Usage: node server/scripts/diagnose_vocalexpander.js <path_to_log_dir>
 *
 * Reads the pre-vocalExpander audio (09_deEss.wav or 10_remeasureFramesPostNr.wav)
 * and the frameAnalysis from the log, then outputs detailed statistics about
 * detection-band energy for voiced vs. silence frames.
 */

import { readWavAllChannels } from '../pipeline/wavReader.js'
import { readFile } from 'fs/promises'
import { join } from 'path'

const SAMPLE_RATE = 44100
const DET_FRAME_SAMPLES = Math.round(0.010 * SAMPLE_RATE) // 441
const DET_FRAMES_PER_ANALYSIS_FRAME = 10

// 2nd-order Butterworth highpass
function applyHighpass(samples, fs, f0) {
  const Q = Math.SQRT1_2
  const w0 = (2 * Math.PI * f0) / fs
  const c = Math.cos(w0)
  const a = Math.sin(w0) / (2 * Q)
  const a0 = 1 + a
  const b0 = ((1 + c) / 2) / a0
  const b1 = (-(1 + c)) / a0
  const b2 = ((1 + c) / 2) / a0
  const a1 = (-2 * c) / a0
  const a2 = (1 - a) / a0

  const out = new Float32Array(samples.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    out[i] = y
  }
  return out
}

// 2nd-order Butterworth lowpass in-place
function applyLowpassInPlace(samples, fs, f0) {
  const Q = Math.SQRT1_2
  const w0 = (2 * Math.PI * f0) / fs
  const c = Math.cos(w0)
  const a = Math.sin(w0) / (2 * Q)
  const a0 = 1 + a
  const b0 = ((1 - c) / 2) / a0
  const b1 = (1 - c) / a0
  const b2 = ((1 - c) / 2) / a0
  const a1 = (-2 * c) / a0
  const a2 = (1 - a) / a0

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x
    y2 = y1; y1 = y
    samples[i] = y
  }
}

async function main() {
  const logDir = process.argv[2]
  if (!logDir) {
    console.error('Usage: node diagnose_vocalexpander.js <path_to_log_dir>')
    process.exit(1)
  }

  // Find the input WAV for vocalExpander (last stage before it)
  const candidates = ['10_remeasureFramesPostNr.wav', '09_deEss.wav', '08_noiseReduce.wav']
  let inputPath = null
  for (const c of candidates) {
    try {
      await readFile(join(logDir, c))
      inputPath = join(logDir, c)
      break
    } catch { /* try next */ }
  }
  if (!inputPath) {
    console.error('Could not find input audio file')
    process.exit(1)
  }
  console.log(`Input: ${inputPath}`)

  // Read Silero VAD output
  const sileroPath = join(logDir, 'silero_debug.json')
  let sileroFrames = []
  try {
    const sileroData = JSON.parse(await readFile(sileroPath, 'utf8'))
    sileroFrames = sileroData.frames
    console.log(`Silero VAD: ${sileroFrames.length} frames (${sileroFrames.filter(f => !f.isSilence).length} voiced)`)
  } catch (e) {
    console.log('No silero_debug.json found - run silero_vad.py first')
  }

  const { channels, sampleRate } = await readWavAllChannels(inputPath)
  console.log(`Sample rate: ${sampleRate}, Samples: ${channels[0].length}`)

  // Apply detection bandpass (80-800 Hz)
  const detection = applyHighpass(channels[0], sampleRate, 80)
  applyLowpassInPlace(detection, sampleRate, 800)

  // Compute detection-frame RMS
  const n = channels[0].length
  const numDetFrames = Math.floor(n / DET_FRAME_SAMPLES)
  const detRmsDb = new Float64Array(numDetFrames)
  const fullRmsDb = new Float64Array(numDetFrames)

  for (let f = 0; f < numDetFrames; f++) {
    const start = f * DET_FRAME_SAMPLES
    let detSumSq = 0, fullSumSq = 0
    for (let i = start; i < start + DET_FRAME_SAMPLES; i++) {
      detSumSq += detection[i] * detection[i]
      fullSumSq += channels[0][i] * channels[0][i]
    }
    const detRms = Math.sqrt(detSumSq / DET_FRAME_SAMPLES)
    const fullRms = Math.sqrt(fullSumSq / DET_FRAME_SAMPLES)
    detRmsDb[f] = detRms > 0 ? 20 * Math.log10(detRms) : -120
    fullRmsDb[f] = fullRms > 0 ? 20 * Math.log10(fullRms) : -120
  }

  // Print sample of first 50 frames for diagnosis
  console.log('\nFirst 50 detection frames:')
  console.log('Frame#  FullRMS  DetRMS  Delta')
  for (let f = 0; f < Math.min(50, numDetFrames); f++) {
    const delta = fullRmsDb[f] - detRmsDb[f]
    console.log(`${String(f).padStart(5)}  ${fullRmsDb[f].toFixed(1).padStart(7)}  ${detRmsDb[f].toFixed(1).padStart(6)}  ${delta.toFixed(1).padStart(5)}`)
  }

  // Count frames above certain thresholds
  let countAboveMinus40Full = 0, countAboveMinus40Det = 0
  let countAboveMinus60Full = 0, countAboveMinus60Det = 0
  for (let f = 0; f < numDetFrames; f++) {
    if (fullRmsDb[f] > -40) countAboveMinus40Full++
    if (detRmsDb[f] > -40) countAboveMinus40Det++
    if (fullRmsDb[f] > -60) countAboveMinus60Full++
    if (detRmsDb[f] > -60) countAboveMinus60Det++
  }
  console.log(`\nFrames above -40dB: Full=${countAboveMinus40Full} Det=${countAboveMinus40Det}`)
  console.log(`Frames above -60dB: Full=${countAboveMinus60Full} Det=${countAboveMinus60Det}`)
  console.log(`Total frames: ${numDetFrames}`)

  // Show some loud frames
  console.log('\nSample of frames with full-band RMS > -30dB:')
  let shown = 0
  for (let f = 0; f < numDetFrames && shown < 20; f++) {
    if (fullRmsDb[f] > -30) {
      console.log(`  Frame ${f}: Full=${fullRmsDb[f].toFixed(1)}dB  Det=${detRmsDb[f].toFixed(1)}dB`)
      shown++
    }
  }

  // Compute statistics
  const sorted = Float64Array.from(detRmsDb).sort()
  const p10 = sorted[Math.floor(sorted.length * 0.1)]
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p90 = sorted[Math.floor(sorted.length * 0.9)]

  console.log(`\nOverall detection-band statistics:`)
  console.log(`  P10: ${p10.toFixed(1)} dB`)
  console.log(`  P50: ${p50.toFixed(1)} dB`)
  console.log(`  P90: ${p90.toFixed(1)} dB`)

  // Analyze the delta between full-band and detection-band for "voiced" frames (full > -40)
  const deltas = []
  for (let f = 0; f < numDetFrames; f++) {
    if (fullRmsDb[f] > -40 && fullRmsDb[f] < 0) {
      deltas.push(fullRmsDb[f] - detRmsDb[f])
    }
  }
  deltas.sort((a, b) => a - b)
  if (deltas.length > 0) {
    console.log(`\nFull-to-Detection delta for loud frames (full > -40dB):`)
    console.log(`  Min: ${deltas[0].toFixed(1)} dB  Max: ${deltas[deltas.length-1].toFixed(1)} dB`)
    console.log(`  Median: ${deltas[Math.floor(deltas.length/2)].toFixed(1)} dB`)
    console.log(`  (positive = detection is quieter than full-band)`)
  }

  // Now replicate the vocalExpander calibration using Silero labels
  if (sileroFrames.length > 0) {
    const detSilenceDb = []
    const detVoicedDb = []
    const DET_FRAMES_PER_ANALYSIS = 10

    for (let f = 0; f < numDetFrames; f++) {
      const analysisIdx = Math.min(Math.floor(f / DET_FRAMES_PER_ANALYSIS), sileroFrames.length - 1)
      const frame = sileroFrames[analysisIdx]
      if (frame.isSilence) {
        detSilenceDb.push(detRmsDb[f])
      } else {
        detVoicedDb.push(detRmsDb[f])
      }
    }

    detSilenceDb.sort((a, b) => a - b)
    detVoicedDb.sort((a, b) => a - b)

    const silenceP90 = detSilenceDb[Math.floor(detSilenceDb.length * 0.9)]
    const voicedP30 = detVoicedDb[Math.floor(detVoicedDb.length * 0.3)]
    const voicedP10 = detVoicedDb[Math.floor(detVoicedDb.length * 0.1)]
    const voicedP50 = detVoicedDb[Math.floor(detVoicedDb.length * 0.5)]

    console.log(`\n--- Replicating vocalExpander calibration ---`)
    console.log(`Detection frames partitioned by Silero VAD:`)
    console.log(`  Silence: ${detSilenceDb.length} frames  |  Voiced: ${detVoicedDb.length} frames`)
    console.log(`  Silence P90: ${silenceP90?.toFixed(1)} dB`)
    console.log(`  Voiced P10:  ${voicedP10?.toFixed(1)} dB  P30: ${voicedP30?.toFixed(1)} dB  P50: ${voicedP50?.toFixed(1)} dB`)
    console.log(`  Gap (voicedP30 - silenceP90): ${(voicedP30 - silenceP90).toFixed(1)} dB`)
    console.log(`  Expected: voiced should have MORE energy (positive gap), but seeing LESS (negative gap)`)

    // Now compute the full-band equivalents using frameAnalysis.frames[].rmsDbfs
    // to see if full-band calibration would work better
    const fullSilenceDb = []
    const fullVoicedDb = []
    for (const frame of sileroFrames) {
      // We don't have the full-band rmsDbfs here, but we can aggregate from detection frames
      // Actually, let's compute it differently - use the fullRmsDb we already have
    }

    // Compute full-band statistics from our local measurements
    const fullSilenceFrames = []
    const fullVoicedFrames = []
    for (let f = 0; f < numDetFrames; f++) {
      const analysisIdx = Math.min(Math.floor(f / DET_FRAMES_PER_ANALYSIS), sileroFrames.length - 1)
      const frame = sileroFrames[analysisIdx]
      if (frame.isSilence) {
        fullSilenceFrames.push(fullRmsDb[f])
      } else {
        fullVoicedFrames.push(fullRmsDb[f])
      }
    }
    fullSilenceFrames.sort((a, b) => a - b)
    fullVoicedFrames.sort((a, b) => a - b)

    const fullSilenceP90 = fullSilenceFrames[Math.floor(fullSilenceFrames.length * 0.9)]
    const fullVoicedP30 = fullVoicedFrames[Math.floor(fullVoicedFrames.length * 0.3)]
    const fullVoicedP50 = fullVoicedFrames[Math.floor(fullVoicedFrames.length * 0.5)]

    console.log(`\nFull-band P90/P50 (old approach) ---`)
    console.log(`  Full-band Silence P90: ${fullSilenceP90?.toFixed(1)} dB  ← includes breaths!`)
    console.log(`  Full-band Voiced P50:  ${fullVoicedP50?.toFixed(1)} dB`)
    console.log(`  Gap (voicedP50 - silenceP90): ${(fullVoicedP50 - fullSilenceP90).toFixed(1)} dB`)

    // Compute bootstrapped noise floor (same algorithm as frameAnalysis.js)
    // Use the 20 quietest frames
    const allFrameRms = []
    for (let f = 0; f < numDetFrames; f++) {
      if (fullRmsDb[f] > -100) {
        allFrameRms.push(Math.pow(10, fullRmsDb[f] / 20)) // convert dB to linear RMS
      }
    }
    allFrameRms.sort((a, b) => a - b)
    const bootstrapCount = Math.min(20, allFrameRms.length)
    let sumSqBootstrap = 0
    for (let i = 0; i < bootstrapCount; i++) {
      sumSqBootstrap += allFrameRms[i] * allFrameRms[i]
    }
    const noiseFloorRms = Math.sqrt(sumSqBootstrap / bootstrapCount)
    const noiseFloorDb = 20 * Math.log10(noiseFloorRms)

    console.log(`\n--- Noise floor approach (THE NEW FIX) ---`)
    console.log(`  Bootstrapped Noise Floor: ${noiseFloorDb.toFixed(1)} dB  ← actual quiet floor`)
    console.log(`  Full-band Voiced P50:     ${fullVoicedP50?.toFixed(1)} dB`)
    console.log(`  Gap (voicedP50 - noiseFloor): ${(fullVoicedP50 - noiseFloorDb).toFixed(1)} dB  ← SHOULD BE LARGE POSITIVE`)

    // Simulate threshold calculation with headroomOffsetDb = 3.5
    const headroomOffsetDb = 3.5
    const thresholdFromNoiseFloor = noiseFloorDb + headroomOffsetDb
    const thresholdFromVoiced = fullVoicedP50 - headroomOffsetDb
    const thresholdDb = Math.max(Math.min(thresholdFromNoiseFloor, thresholdFromVoiced), noiseFloorDb)

    console.log(`\n  Threshold calculation (headroom=${headroomOffsetDb}):`)
    console.log(`    thresholdFromNoiseFloor: ${thresholdFromNoiseFloor.toFixed(1)} dB`)
    console.log(`    thresholdFromVoiced:     ${thresholdFromVoiced.toFixed(1)} dB`)
    console.log(`    final thresholdDb:       ${thresholdDb.toFixed(1)} dB`)

    // Investigate what Silero labels as "silence" - are these actually quiet frames?
    console.log(`\n--- What is Silero labeling as "silence"? ---`)
    const silenceFrameDetails = []
    for (let aIdx = 0; aIdx < sileroFrames.length; aIdx++) {
      const frame = sileroFrames[aIdx]
      if (frame.isSilence) {
        // Compute average full-band RMS for the 10 detection frames in this analysis frame
        const detStart = aIdx * DET_FRAMES_PER_ANALYSIS
        const detEnd = Math.min(detStart + DET_FRAMES_PER_ANALYSIS, numDetFrames)
        let sumSq = 0, count = 0
        for (let f = detStart; f < detEnd; f++) {
          if (fullRmsDb[f] > -100) { // skip digital silence
            sumSq += Math.pow(10, fullRmsDb[f] / 10)
            count++
          }
        }
        const avgRmsDb = count > 0 ? 10 * Math.log10(sumSq / count) : -120
        silenceFrameDetails.push({
          index: aIdx,
          prob: frame.maxProb,
          rmsDb: avgRmsDb
        })
      }
    }

    // Sort by RMS (loudest first) and show the loudest "silence" frames
    silenceFrameDetails.sort((a, b) => b.rmsDb - a.rmsDb)
    console.log(`  Loudest 10 "silence" frames (sorted by RMS):`)
    for (let i = 0; i < Math.min(10, silenceFrameDetails.length); i++) {
      const f = silenceFrameDetails[i]
      console.log(`    Frame ${f.index}: RMS=${f.rmsDb.toFixed(1)}dB  prob=${f.prob.toFixed(3)}`)
    }

    // Distribution of silence frame energy
    const silenceAboveMinus40 = silenceFrameDetails.filter(f => f.rmsDb > -40).length
    const silenceAboveMinus50 = silenceFrameDetails.filter(f => f.rmsDb > -50).length
    const silenceAboveMinus60 = silenceFrameDetails.filter(f => f.rmsDb > -60).length
    console.log(`\n  Silence frame energy distribution:`)
    console.log(`    > -40 dB: ${silenceAboveMinus40} frames (likely breaths/pauses)`)
    console.log(`    > -50 dB: ${silenceAboveMinus50} frames`)
    console.log(`    > -60 dB: ${silenceAboveMinus60} frames`)
    console.log(`    Total silence frames: ${silenceFrameDetails.length}`)
  }
}

main().catch(console.error)
