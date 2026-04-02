/**
 * Thin wrapper around FFmpeg/FFprobe via child_process.
 *
 * Replaces the deprecated fluent-ffmpeg package with direct CLI invocation.
 */

import { execFile } from 'child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'

const FFMPEG_PATH = ffmpegInstaller.path
const FFPROBE_PATH = ffprobeInstaller.path

/**
 * Run an FFmpeg command and return { stdout, stderr }.
 *
 * @param {string[]} args - FFmpeg CLI arguments
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, ['-y', ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        return reject(err)
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Run FFprobe on a file and return parsed JSON metadata.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_PATH,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(parseErr)
        }
      },
    )
  })
}
