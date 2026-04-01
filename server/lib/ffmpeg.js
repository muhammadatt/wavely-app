/**
 * FFmpeg helper utilities.
 *
 * Wraps fluent-ffmpeg in promise-based helpers for the processing pipeline.
 * All intermediate files use 32-bit float PCM WAV at 44.1 kHz internally.
 */

import ffmpeg from 'fluent-ffmpeg'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { randomUUID } from 'crypto'
import { unlink } from 'fs/promises'
import path from 'path'

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

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
 * Run an ffmpeg command, returning a promise.
 */
function run(command) {
  return new Promise((resolve, reject) => {
    command
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
}

/**
 * Stage 0: Decode any supported input to 32-bit float PCM WAV at 44.1 kHz.
 */
export async function decodeToFloat32(inputPath, outputPath) {
  await run(
    ffmpeg(inputPath)
      .audioFrequency(INTERNAL_SAMPLE_RATE)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
  return outputPath
}

/**
 * Stage 0b: Convert stereo to mono via mid-channel mixdown.
 */
export async function mixdownToMono(inputPath, outputPath) {
  await run(
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
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

  await run(
    ffmpeg(inputPath)
      .audioFilters(filters)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
  return outputPath
}

/**
 * Stage 5+6: Two-pass loudnorm — normalization + true peak limiting.
 *
 * Pass 1: Measure loudness statistics.
 * Pass 2: Apply normalization with peak ceiling.
 *
 * For ACX (RMS-based), we use a linear gain approach instead of loudnorm
 * since loudnorm operates on LUFS. The RMS path is handled separately
 * in the pipeline orchestrator.
 *
 * This function handles the LUFS path (standard/broadcast compliance).
 */
export async function applyLoudnormLUFS(inputPath, outputPath, { targetLUFS, peakCeiling }) {
  // Pass 1: measure
  const stats = await measureLoudnorm(inputPath)

  // Pass 2: apply
  await run(
    ffmpeg(inputPath)
      .audioFilters([
        `loudnorm=I=${targetLUFS}:TP=${peakCeiling}:LRA=11` +
        `:measured_I=${stats.input_i}` +
        `:measured_LRA=${stats.input_lra}` +
        `:measured_TP=${stats.input_tp}` +
        `:measured_thresh=${stats.input_thresh}` +
        `:offset=${stats.target_offset}` +
        `:linear=true:print_format=summary`
      ])
      .audioFrequency(INTERNAL_SAMPLE_RATE)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
  return outputPath
}

/**
 * Measure loudnorm stats (pass 1).
 */
function measureLoudnorm(inputPath) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    ffmpeg(inputPath)
      .audioFilters('loudnorm=I=-16:TP=-1:LRA=11:print_format=json')
      .format('null')
      .output('-')
      .on('error', reject)
      .on('stderr', (line) => { stderr += line + '\n' })
      .on('end', () => {
        try {
          // Extract JSON block from stderr
          const jsonMatch = stderr.match(/\{[\s\S]*?\}/)
          if (!jsonMatch) throw new Error('Could not parse loudnorm stats')
          resolve(JSON.parse(jsonMatch[0]))
        } catch (err) {
          reject(err)
        }
      })
      .run()
  })
}

/**
 * Apply a linear gain (in dB) to the audio.
 * Used for RMS-based normalization (ACX compliance).
 */
export async function applyLinearGain(inputPath, outputPath, gainDb) {
  if (Math.abs(gainDb) < 0.01) {
    // No meaningful gain to apply — just copy
    await run(
      ffmpeg(inputPath)
        .audioCodec('pcm_f32le')
        .format('wav')
        .output(outputPath)
    )
    return outputPath
  }

  await run(
    ffmpeg(inputPath)
      .audioFilters(`volume=${gainDb}dB`)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
  return outputPath
}

/**
 * Stage 6: True peak limiter via loudnorm with tight ceiling.
 * Applied after normalization to catch any inter-sample peaks.
 */
export async function applyTruePeakLimiter(inputPath, outputPath, { peakCeiling }) {
  const stats = await measureLoudnorm(inputPath)

  // Apply loudnorm targeting the measured integrated loudness (preserve level)
  // but enforce the peak ceiling
  await run(
    ffmpeg(inputPath)
      .audioFilters([
        `loudnorm=I=${stats.input_i}:TP=${peakCeiling}:LRA=11` +
        `:measured_I=${stats.input_i}` +
        `:measured_LRA=${stats.input_lra}` +
        `:measured_TP=${stats.input_tp}` +
        `:measured_thresh=${stats.input_thresh}` +
        `:offset=0` +
        `:linear=true:print_format=summary`
      ])
      .audioFrequency(INTERNAL_SAMPLE_RATE)
      .audioCodec('pcm_f32le')
      .format('wav')
      .output(outputPath)
  )
  return outputPath
}

/**
 * Encode output to delivery format.
 */
export async function encodeOutput(inputPath, outputPath, { format, bitrate, channels }) {
  const cmd = ffmpeg(inputPath)

  if (channels) {
    cmd.audioChannels(channels)
  }

  if (format === 'mp3') {
    cmd
      .audioCodec('libmp3lame')
      .audioBitrate(bitrate || '128k')
      .outputOptions('-abr', '0')  // strict CBR
      .format('mp3')
  } else {
    // WAV 16-bit PCM
    cmd
      .audioCodec('pcm_s16le')
      .audioFrequency(INTERNAL_SAMPLE_RATE)
      .format('wav')
  }

  cmd.output(outputPath)
  await run(cmd)
  return outputPath
}

/**
 * Probe a file for audio metadata.
 */
export function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err)
      resolve(metadata)
    })
  })
}
