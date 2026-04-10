/**
 * Stage 2 — Noise Reduction via DeepFilterNet3.
 *
 * Runs DeepFilterNet3 uncapped by default (atten_lim_db=null). DF3 is an
 * adaptive neural model that classifies speech vs. noise per time-frequency
 * bin — it will not aggressively attenuate speech even without an external
 * ceiling. Passing atten_lim_db limits the maximum attenuation applied to any
 * bin; use this only when intentional conservative processing is required
 * (e.g. the NE-5 residual cleanup pass after source separation).
 *
 * DeepFilterNet3 operates at 48 kHz internally. The Python script handles the
 * 44.1 kHz → 48 kHz resample on input; decodeToFloat32 resamples the 48 kHz
 * output back to 44.1 kHz so the rest of the pipeline sees its expected format.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { decodeToFloat32, tempPath, removeTmp } from '../lib/ffmpeg.js'

// --- DeepFilter invocation strategy ---
// DEEPFILTER_BINARY (env): path to a pre-built deep-filter CLI binary.
//   Used on platforms where the Python deepfilternet package can't be
//   compiled (e.g. Windows ARM64 without MSVC Build Tools).
//   On Linux servers, leave unset — the Python script path is used instead.
// DEEPFILTER_PYTHON (env): Python executable that has deepfilternet installed.
//   Defaults to 'python3'. Set to a venv python path if needed.
const DEEPFILTER_BINARY = process.env.DEEPFILTER_BINARY ?? null
const PYTHON = process.env.DEEPFILTER_PYTHON ?? 'python3'
const SCRIPT  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deepfilter_enhance.py')

/**
 * @param {string} inputPath  - Path to input WAV (32-bit float, 44.1 kHz)
 * @param {string} outputPath - Path to write output WAV (32-bit float, 44.1 kHz)
 * @param {object} [options]
 * @param {number|null} [options.attenLimDb=null] - Maximum attenuation passed to
 *   DeepFilterNet3 via atten_lim_db. null = uncapped (default). Only set this
 *   when intentionally conservative processing is needed (e.g. NE-5 residual cleanup).
 * @returns {Promise<object>} Processing metadata for the pipeline report
 */
export async function applyNoiseReduction(inputPath, outputPath, { attenLimDb = null } = {}) {

  // DeepFilterNet3 outputs 48 kHz — hold in a temp file before resampling
  const nr48kPath = tempPath('.wav')

  try {
    await runDeepFilter(inputPath, nr48kPath, attenLimDb)

    // Resample 48 kHz → 32-bit float 44.1 kHz (pipeline internal format)
    await decodeToFloat32(nr48kPath, outputPath)
  } finally {
    await removeTmp(nr48kPath)
  }

  return {
    applied:               true,
    model:                 'DeepFilterNet3',
    atten_lim_db:          attenLimDb,
    post_noise_floor_dbfs: null, // remeasured after full chain in Stage 7
  }
}

/**
 * Invoke DeepFilter via whichever strategy is configured:
 *   - DEEPFILTER_BINARY set → CLI binary  (dev override, e.g. Windows ARM64)
 *   - otherwise            → Python script (production default, Linux server)
 *
 * @param {string}      inputPath  - WAV at any sample rate
 * @param {string}      outputPath - 32-bit float WAV at 48 kHz
 * @param {number|null} attenLimDb - Max attenuation in dB; null = no limit
 */
function runDeepFilter(inputPath, outputPath, attenLimDb) {
  if (DEEPFILTER_BINARY) {
    return runDeepFilterCli(inputPath, outputPath, attenLimDb)
  }
  return runDeepFilterPython(inputPath, outputPath, attenLimDb)
}

/**
 * CLI binary strategy.
 * The binary writes <basename> into --output-dir; we point it at a dedicated
 * temp directory and rename the result to the desired outputPath.
 */
async function runDeepFilterCli(inputPath, outputPath, attenLimDb) {
  const tmpDir = tempPath('')   // unique path — reuse tempPath for uniqueness
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    // CLI attenuation: null (uncapped) → 100 dB (CLI's "full reduction")
    const attenArg = attenLimDb !== null ? String(attenLimDb) : '100'

    await spawnProcess(
      DEEPFILTER_BINARY,
      ['-a', attenArg, '-o', tmpDir, inputPath],
      'DeepFilter CLI',
    )

    // Binary writes <inputBasename> into tmpDir
    const outFile = path.join(tmpDir, path.basename(inputPath))
    fs.renameSync(outFile, outputPath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Python script strategy (production default).
 * Calls deepfilter_enhance.py which uses the deepfilternet Python package.
 */
function runDeepFilterPython(inputPath, outputPath, attenLimDb) {
  const args = [SCRIPT, '--input', inputPath, '--output', outputPath]
  if (attenLimDb !== null) {
    args.push('--atten-lim-db', String(attenLimDb))
  }
  return spawnProcess(PYTHON, args, 'DeepFilter Python')
}

/**
 * Shared subprocess helper.
 */
function spawnProcess(executable, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    // Drain stdout to prevent pipe buffer deadlock — DeepFilterNet3 emits
    // progress output that can fill the 64 KB OS pipe buffer and block the
    // child process indefinitely if the parent never reads it.
    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdout.trim()) console.log(`[${label}] ${stdout.trim()}`)
      if (code === 0 && signal === null) {
        resolve()
      } else {
        const reasonParts = []
        if (code !== null) reasonParts.push(`code ${code}`)
        if (signal !== null) reasonParts.push(`signal ${signal}`)
        const reason = reasonParts.length ? reasonParts.join(', ') : 'unknown reason'
        reject(new Error(
          `${label} exited with ${reason}.\n` + stderr.slice(-2000)
        ))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}
