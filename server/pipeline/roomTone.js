/**
 * Room tone padding — ACX Audiobook only.
 *
 * ACX requires 0.5–1 second of room tone at the head and 1–5 seconds at the
 * tail of each file. This module:
 *
 *   1. Detects existing near-silence duration at head and tail
 *      (frames ≤ noise_floor + 3 dB per spec)
 *   2. Extracts a 500 ms room tone sample from the quietest silence segment
 *      (identified by silenceAnalysis, actual room ambience not digital silence)
 *   3. If head < 0.5 s → prepend room tone to reach 0.75 s
 *   4. If tail < 1.0 s → append room tone to reach 2.0 s
 *
 * Implementation: read 32-bit float samples, measure head/tail near-silence,
 * extract a room tone chunk from the quietest segment, then synthesize a new
 * padded 32-bit float WAV in JS (via writePaddedWav / float32ToWav) without
 * using temp files or FFmpeg concat filters.
 *
 * Reference: processing spec v3, "Room Tone Padding" section.
 */

import { writeFile } from 'fs/promises'
import { readWavSamples } from './wavReader.js'

const HEAD_TARGET_S   = 0.75   // target head room tone (s)
const TAIL_TARGET_S   = 2.0    // target tail room tone (s)
const HEAD_THRESHOLD_S = 0.5   // trigger if head room tone < this
const TAIL_THRESHOLD_S = 1.0   // trigger if tail room tone < this
const PAD_SOURCE_S     = 0.5   // room tone sample duration to extract

/**
 * Apply room tone padding if needed (ACX Audiobook preset only).
 *
 * @param {string} inputPath  - 32-bit float WAV (internal format)
 * @param {string} outputPath - Output path (same format)
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @returns {{ applied: boolean, headAdded_s: number, tailAdded_s: number }}
 */
export async function applyRoomTonePadding(inputPath, outputPath, frameAnalysis) {
  const { samples, sampleRate } = await readWavSamples(inputPath)
  const { noiseFloorDbfs, quietestSilenceSegment } = frameAnalysis

  // Threshold for "near-silence" in the head/tail detection (noise_floor + 3 dB)
  const nearSilenceThresholdDb = noiseFloorDbfs + 3

  // Measure existing head and tail room tone durations
  const frameSamples = Math.round(0.02 * sampleRate) // 20 ms frames for head/tail detection
  const headDuration = measureEdgeSilence(samples, frameSamples, sampleRate, nearSilenceThresholdDb, 'head')
  const tailDuration = measureEdgeSilence(samples, frameSamples, sampleRate, nearSilenceThresholdDb, 'tail')

  // Only pad if the existing duration is below the trigger threshold.
  // If the file already has ≥ 0.5 s head or ≥ 1.0 s tail room tone, leave it alone.
  let headNeeded = 0
  if (headDuration < HEAD_THRESHOLD_S) {
    headNeeded = Math.max(0, HEAD_TARGET_S - headDuration)
  }

  let tailNeeded = 0
  if (tailDuration < TAIL_THRESHOLD_S) {
    tailNeeded = Math.max(0, TAIL_TARGET_S - tailDuration)
  }

  if (headNeeded < 0.01 && tailNeeded < 0.01) {
    // Already has enough room tone — just copy
    await copyFile(inputPath, outputPath)
    return { applied: false, headAdded_s: 0, tailAdded_s: 0 }
  }

  // Extract room tone source from the quietest silence segment
  const roomToneSamples = extractRoomTone(samples, sampleRate, quietestSilenceSegment)

  // Build the padded output
  await writePaddedWav(
    samples,
    sampleRate,
    roomToneSamples,
    headNeeded,
    tailNeeded,
    outputPath
  )

  return {
    applied: true,
    headAdded_s: round2(headNeeded),
    tailAdded_s: round2(tailNeeded),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Measure the duration of near-silence at the head or tail.
 * Returns duration in seconds.
 */
function measureEdgeSilence(samples, frameSamples, sampleRate, thresholdDb, edge) {
  const numFrames = Math.floor(samples.length / frameSamples)
  let silentFrames = 0

  for (let i = 0; i < numFrames; i++) {
    const fi = edge === 'head' ? i : numFrames - 1 - i
    const start = fi * frameSamples
    const end   = start + frameSamples
    const rmsDb = frameRmsDb(samples, start, end)
    if (rmsDb <= thresholdDb) {
      silentFrames++
    } else {
      break  // stop at first non-silent frame
    }
  }

  return (silentFrames * frameSamples) / sampleRate
}

/**
 * Extract a room tone sample of PAD_SOURCE_S duration from the quietest
 * silence segment. Returns a repeatable chunk that can be tiled.
 */
function extractRoomTone(samples, sampleRate, quietestSegment) {
  const padLengthSamples = Math.round(PAD_SOURCE_S * sampleRate)

  if (!quietestSegment || quietestSegment.lengthSamples < padLengthSamples) {
    // Fallback: very low digital near-silence (avoid true digital silence which sounds unnatural)
    const noise = new Float32Array(padLengthSamples)
    // Sub-threshold dither: inaudible but not perfectly flat
    for (let i = 0; i < padLengthSamples; i++) {
      noise[i] = (Math.random() * 2 - 1) * 0.000003  // ~-110 dBFS noise floor
    }
    return noise
  }

  const start = quietestSegment.offsetSamples
  return samples.slice(start, start + padLengthSamples)
}

/**
 * Tile a room tone clip to fill the required duration.
 */
function tileRoomTone(roomToneSamples, neededSamples) {
  if (neededSamples <= 0) return new Float32Array(0)
  const out = new Float32Array(neededSamples)
  for (let i = 0; i < neededSamples; i++) {
    out[i] = roomToneSamples[i % roomToneSamples.length]
  }
  return out
}

/**
 * Write a Float32Array as 32-bit float WAV.
 */
function float32ToWav(samples, sampleRate) {
  const numSamples    = samples.length
  const numChannels   = 1
  const bitsPerSample = 32
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8
  const blockAlign    = numChannels * bitsPerSample / 8
  const dataSize      = numSamples * blockAlign
  const headerSize    = 44
  const buf           = Buffer.alloc(headerSize + dataSize)
  let off = 0

  // RIFF header
  buf.write('RIFF', off); off += 4
  buf.writeUInt32LE(36 + dataSize, off); off += 4
  buf.write('WAVE', off); off += 4

  // fmt chunk
  buf.write('fmt ', off); off += 4
  buf.writeUInt32LE(16, off); off += 4              // chunk size
  buf.writeUInt16LE(3, off); off += 2               // PCM float format
  buf.writeUInt16LE(numChannels, off); off += 2
  buf.writeUInt32LE(sampleRate, off); off += 4
  buf.writeUInt32LE(byteRate, off); off += 4
  buf.writeUInt16LE(blockAlign, off); off += 2
  buf.writeUInt16LE(bitsPerSample, off); off += 2

  // data chunk
  buf.write('data', off); off += 4
  buf.writeUInt32LE(dataSize, off); off += 4

  const view = new DataView(buf.buffer)
  for (let i = 0; i < numSamples; i++) {
    view.setFloat32(off + i * 4, samples[i], true)
  }

  return buf
}

/**
 * Write a padded WAV: [head pad] + [audio] + [tail pad].
 */
async function writePaddedWav(originalSamples, sampleRate, roomToneSamples, headNeeded_s, tailNeeded_s, outputPath) {
  const headSamples = Math.round(headNeeded_s * sampleRate)
  const tailSamples = Math.round(tailNeeded_s * sampleRate)

  const headPad = tileRoomTone(roomToneSamples, headSamples)
  const tailPad = tileRoomTone(roomToneSamples, tailSamples)

  const totalSamples = headPad.length + originalSamples.length + tailPad.length
  const combined     = new Float32Array(totalSamples)
  combined.set(headPad, 0)
  combined.set(originalSamples, headPad.length)
  combined.set(tailPad, headPad.length + originalSamples.length)

  const wavBuf = float32ToWav(combined, sampleRate)
  await writeFile(outputPath, wavBuf)
}

async function copyFile(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}

function frameRmsDb(samples, start, end) {
  let sumSq = 0
  for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
  const rms = Math.sqrt(sumSq / (end - start))
  return rms <= 0 ? -120 : 20 * Math.log10(rms)
}

function round2(n) {
  return Math.round(n * 100) / 100
}
