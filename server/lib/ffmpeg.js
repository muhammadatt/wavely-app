/**
 * FFmpeg helper utilities.
 *
 * Promise-based helpers for the processing pipeline using direct CLI invocation.
 * All intermediate files use 32-bit float PCM WAV at 44.1 kHz internally.
 */

import { runFfmpeg, ffprobe as runFfprobe } from './exec-ffmpeg.js'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import path from 'path'

const TEMP_DIR = path.resolve(import.meta.dirname, '..', 'uploads')
const INTERNAL_SAMPLE_RATE = 44100

/**
 * Generate a temp file path in the uploads directory.
 */
export function tempPath(ext = '.wav') {
  return path.join(TEMP_DIR, `${randomUUID()}${ext}`)
}

/**
 * Remove a temp file, ignoring errors if it doesn't exist.
 */
export async function removeTmp(filePath) {
  try {
    await unlink(filePath)
  } catch {
    // ignore
  }
}

/**
 * Pad the beginning of an audio file with silence.
 */
export async function padStart(inputPath, outputPath, padMs) {
  // Use apad for silence at the end, but for start we need to delay the audio.
  // adelay delays all channels.
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-af', `adelay=${padMs}|${padMs}`,
    '-acodec', 'pcm_f32le',
    '-ar', String(INTERNAL_SAMPLE_RATE),
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Stage 0: Decode any supported input to 32-bit float PCM WAV at 44.1 kHz.
 */
export async function decodeToFloat32(inputPath, outputPath, { trimStartMs = 0 } = {}) {
  const args = ['-y', '-i', inputPath]
  if (trimStartMs > 0) {
    args.push('-af', `atrim=start=${trimStartMs / 1000}`)
  }
  args.push(
    '-ar', String(INTERNAL_SAMPLE_RATE),
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath
  )
  await runFfmpeg(args)
  return outputPath
}

/**
 * Stage 0b: Convert stereo to mono via mid-channel mixdown.
 */
export async function mixdownToMono(inputPath, outputPath) {
  await runFfmpeg([
    '-i', inputPath,
    '-ac', '1',
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Stage 1: High-pass filter — 80 Hz Butterworth, 4th order (-24 dB/oct).
 *
 * FFmpeg's highpass filter is 2nd order per application, so we chain two
 * to get 4th order. Also applies conditional 60 Hz notch if requested.
 */
export async function applyHighPass(inputPath, outputPath, { notch60Hz = false } = {}) {
  const filters = [
    'highpass=f=80:p=2',  // 2nd order Butterworth
    'highpass=f=80:p=2',  // Stacked for 4th order
  ]
  if (notch60Hz) {
    filters.push('equalizer=f=60:t=q:w=10:g=-20')
  }

  await runFfmpeg([
    '-i', inputPath,
    '-af', filters.join(','),
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Apply a linear gain (in dB) to the audio.
 *
 * Stage 5 normalization applies this after measuring the voiced loudness
 * (RMS for ACX, integrated LUFS for podcast/broadcast). The preceding
 * pipeline keeps intermediate buffers in 32-bit float PCM, so this filter
 * will not clip even at large positive gains — the downstream true-peak
 * limiter enforces the peak ceiling.
 */
export async function applyLinearGain(inputPath, outputPath, gainDb) {
  if (Math.abs(gainDb) < 0.01) {
    // No meaningful gain to apply — just copy
    await runFfmpeg([
      '-i', inputPath,
      '-acodec', 'pcm_f32le',
      '-f', 'wav',
      outputPath,
    ])
    return outputPath
  }

  await runFfmpeg([
    '-i', inputPath,
    '-af', `volume=${gainDb}dB`,
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Stage 6: True peak limiter.
 *
 * Applied after Stage 5 normalization to enforce the output profile's true
 * peak ceiling. Uses FFmpeg `alimiter` (lookahead peak limiter) wrapped in a
 * 192 kHz upsample / internal-rate downsample pair so inter-sample peaks
 * (ITU-R BS.1770 true peak) are caught rather than just sample peaks.
 *
 * Historically this ran a two-pass `loudnorm` invocation, which was both
 * heavyweight and shared a pass-1 measurement helper with the LUFS
 * normalization path. The LUFS normalization path has been replaced by a
 * silence-excluded WASM measurement + linear gain, so the shared helper is
 * no longer needed and the simpler `alimiter`-based implementation is used.
 */
export async function applyTruePeakLimiter(inputPath, outputPath, { peakCeiling }) {
  // alimiter's `limit` parameter is linear amplitude in [0, 1]. Convert from
  // dBFS (dBTP after upsampling): 10^(dB/20).
  const limit = Math.pow(10, peakCeiling / 20)

  await runFfmpeg([
    '-i', inputPath,
    '-af',
    `aresample=192000,` +
    `alimiter=limit=${limit}:level=disabled:asc=1,` +
    `aresample=${INTERNAL_SAMPLE_RATE}`,
    '-ar', String(INTERNAL_SAMPLE_RATE),
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Encode output to delivery format.
 */
export async function encodeOutput(inputPath, outputPath, { format, bitrate, channels }) {
  const args = ['-i', inputPath]

  if (channels) {
    args.push('-ac', String(channels))
  }

  if (format === 'mp3') {
    args.push(
      '-acodec', 'libmp3lame',
      '-b:a', bitrate || '128k',
      '-abr', '0',  // strict CBR
      '-f', 'mp3',
    )
  } else {
    // WAV 16-bit PCM
    args.push(
      '-acodec', 'pcm_s16le',
      '-ar', String(INTERNAL_SAMPLE_RATE),
      '-f', 'wav',
    )
  }

  args.push(outputPath)
  await runFfmpeg(args)
  return outputPath
}

/**
 * Stage 3: Apply parametric EQ via FFmpeg `equalizer` filter.
 *
 * Accepts an array of FFmpeg filter strings computed by enhancementEQ.js,
 * e.g. [ 'equalizer=f=285:t=q:w=2.5:g=-3.0', 'equalizer=f=4000:t=q:w=1.5:g=2.5' ]
 * Chains them in one FFmpeg pass to minimize generation loss.
 *
 * @param {string}   inputPath
 * @param {string}   outputPath
 * @param {string[]} eqFilters  - FFmpeg filter strings from analyzeSpectrum()
 */
export async function applyParametricEQ(inputPath, outputPath, eqFilters) {
  if (!eqFilters || eqFilters.length === 0) {
    // No EQ to apply — copy through
    await runFfmpeg([
      '-i', inputPath,
      '-acodec', 'pcm_f32le',
      '-f', 'wav',
      outputPath,
    ])
    return outputPath
  }

  await runFfmpeg([
    '-i', inputPath,
    '-af', eqFilters.join(','),
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])
  return outputPath
}

/**
 * Probe a file for audio metadata.
 */
export function probeFile(filePath) {
  return runFfprobe(filePath)
}
