/**
 * Thin wrapper around FFmpeg/FFprobe via child_process.
 *
 * Replaces the deprecated fluent-ffmpeg package with direct CLI invocation.
 */

import { execFile } from 'child_process'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import { SUBPROCESS_TIMEOUT_MS, PROBE_TIMEOUT_MS, timeoutError } from './subprocessTimeout.js'

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
    const options = { maxBuffer: 10 * 1024 * 1024, timeout: SUBPROCESS_TIMEOUT_MS, killSignal: 'SIGKILL' }
    const started = Date.now()
    execFile(FFMPEG_PATH, ['-y', ...args], options, (err, stdout, stderr) => {
      if (err) {
        if (hitLimit(err, started, SUBPROCESS_TIMEOUT_MS)) err = Object.assign(timeoutError('FFmpeg'), { stderr })
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
    const started = Date.now()
    execFile(
      FFPROBE_PATH,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) return reject(hitLimit(err, started, PROBE_TIMEOUT_MS) ? timeoutError('FFprobe', PROBE_TIMEOUT_MS) : err)
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(parseErr)
        }
      },
    )
  })
}

/**
 * Did execFile kill the child for running past `timeoutMs`? It also kills (and
 * sets `killed`) when output overflows maxBuffer, so the clock decides.
 */
function hitLimit(err, started, timeoutMs) {
  return err.killed && timeoutMs > 0 && Date.now() - started >= timeoutMs
}
