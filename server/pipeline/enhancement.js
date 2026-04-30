/**
 * Enhancement stage spawners — Python subprocess launchers for ML stages
 * used across all processing pipelines.
 *
 * Environment:
 *   SEPARATION_PYTHON  — Python executable (default: python3)
 *   SEPARATION_DEVICE  — Compute device for device-aware scripts (default: auto)
 *   RESONANCE_PYTHON   — Python override for resonance suppressor (falls back to SEPARATION_PYTHON)
 *   TORCH_NUM_THREADS  — PyTorch thread count (default: CPU count)
 *   AP_BWE_REPO        — Path to cloned AP-BWE repo (default: vendor/ap_bwe)
 *   AP_BWE_CHECKPOINT  — Path to the .pt checkpoint file (required for AP-BWE)
 *   LAVASR_MODEL_PATH  — HuggingFace Hub ID or local path (default: YatharthS/LavaSR)
 */

import { spawn }         from 'child_process'
import { fileURLToPath } from 'url'
import { writeFile, rm } from 'fs/promises'
import os                from 'os'
import path              from 'path'
import { tempPath }      from '../lib/ffmpeg.js'
import { spawnPython, spawnPythonCapture, DEVICE, PYTHON as SHARED_PYTHON } from './spawnPython.js'

// Resonance suppressor allows its own Python override before falling back to
// the shared SEPARATION_PYTHON, matching the original RESONANCE_PYTHON cascade.
const RESONANCE_PYTHON = process.env.RESONANCE_PYTHON ?? SHARED_PYTHON
const NUM_THREADS      = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR             = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const HARMONIC_EXCITER_SCRIPT = path.join(SCRIPTS_DIR, 'harmonic_exciter.py')
const VOCAL_SATURATION_SCRIPT = path.join(SCRIPTS_DIR, 'vocal_saturation.py')
const DEREVERB_SCRIPT         = path.join(SCRIPTS_DIR, 'dereverb.py')
const AP_BWE_SCRIPT           = path.join(SCRIPTS_DIR, 'ap_bwe_extend.py')
const LAVASR_SCRIPT           = path.join(SCRIPTS_DIR, 'lavasr_extend.py')
const CLICK_REMOVER_SCRIPT    = path.join(SCRIPTS_DIR, 'click_remover.py')
const RESONANCE_SCRIPT        = path.join(SCRIPTS_DIR, 'resonance_suppressor.py')
const SIBILANCE_SCRIPT        = path.join(SCRIPTS_DIR, 'sibilance_suppressor.py')

// ── Enhancement stages ────────────────────────────────────────────────────────

/**
 * Harmonic exciter — adds subtle harmonic content in the presence/air region.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {object} [params]
 * @param {number} [params.hpFreq=3000]            - High-pass cutoff Hz; only freqs above this are excited
 * @param {number} [params.blend=0.06]             - Mix level of excited signal (0.06 = 6%)
 * @param {number} [params.drive=1.8]              - Nonlinear saturation drive amount
 * @param {number} [params.evenHarmonicWeight=0.4] - Even-harmonic blend (0=odd only, 1=even only)
 */
export function runHarmonicExciter(inputPath, outputPath, params = {}) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (params.hpFreq             != null) args.push('--hp-freq',              String(params.hpFreq))
  if (params.blend              != null) args.push('--blend',                String(params.blend))
  if (params.drive              != null) args.push('--drive',                String(params.drive))
  if (params.evenHarmonicWeight != null) args.push('--even-harmonic-weight', String(params.evenHarmonicWeight))
  return spawnPython(HARMONIC_EXCITER_SCRIPT, args, 'HarmonicExciter')
}

/**
 * Vocal Saturation — parallel tube-style saturation mixed with the dry signal.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {object} [params]
 * @param {number} [params.drive=2.0]   - base saturation drive factor
 * @param {number} [params.wetDry=0.3]  - mix ratio (0=dry, 1=wet)
 * @param {number} [params.bias=0.1]    - asymmetric bias for tube character
 * @param {number} [params.fc=3000]     - high crossover Hz; mid band (800 to fc) drive is 1.5x
 */
export function runVocalSaturation(inputPath, outputPath, params = {}) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (params.drive  != null) args.push('--drive',   String(params.drive))
  if (params.wetDry != null) args.push('--wet-dry', String(params.wetDry))
  if (params.bias   != null) args.push('--bias',    String(params.bias))
  if (params.fc     != null) args.push('--fc',      String(params.fc))
  if (params.f0     != null) args.push('--f0',      String(params.f0))
  return spawnPython(VOCAL_SATURATION_SCRIPT, args, 'VocalSaturation')
}

/**
 * Dereverberation — removes room reflections from voice audio using WPE.
 *
 * @param {string} inputPath     - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath    - 32-bit float WAV at 44.1 kHz (mono)
 * @param {'light'|'medium'|'heavy'} strength - Algorithm tier
 * @param {boolean} preserveEarly - If true, bump WPE delay +2 to protect early reflections
 */
export function runDereverb(inputPath, outputPath, strength = 'medium', preserveEarly = false) {
  const args = ['--input', inputPath, '--output', outputPath, '--strength', strength]
  if (preserveEarly) args.push('--preserve-early')
  return spawnPython(DEREVERB_SCRIPT, args, `Dereverb (${strength})`)
}

/**
 * Stage NE-6: AP-BWE bandwidth extension.
 * Restores high-frequency content attenuated during source separation.
 * Outputs 32-bit float WAV at 48 kHz; the caller resamples to 44.1 kHz via
 * decodeToFloat32.
 *
 * Requires:
 *   AP_BWE_REPO        — path to cloned AP-BWE repo (default: vendor/ap_bwe)
 *   AP_BWE_CHECKPOINT  — path to the .pt checkpoint file (required)
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 48 kHz
 */
export function runApBwe(inputPath, outputPath) {
  return spawnPython(
    AP_BWE_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--device', DEVICE],
    'AP-BWE',
    { AP_BWE_CHECKPOINT: process.env.AP_BWE_CHECKPOINT, AP_BWE_REPO: process.env.AP_BWE_REPO },
  )
}

/**
 * Stage NE-6 (LavaSR path): Lightweight Vocos-based bandwidth extension.
 * Outputs 48 kHz WAV; caller resamples back to 44.1 kHz via decodeToFloat32.
 *
 * Requires:
 *   LAVASR_MODEL_PATH  — HuggingFace Hub ID or local path (default: YatharthS/LavaSR)
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 48 kHz
 */
export function runLavaSR(inputPath, outputPath) {
  return spawnPython(
    LAVASR_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--device', DEVICE],
    'LavaSR',
    { LAVASR_MODEL_PATH: process.env.LAVASR_MODEL_PATH },
  )
}

/**
 * Click remover — Hampel-filter detection on HPF residual + Burg AR interpolation.
 * Runs between Pre-4 (frame analysis) and Stage 1 (HPF) in the standard chain.
 * Captures and returns the JSON processing report printed to stdout.
 *
 * @param {string} inputPath       - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath      - 32-bit float WAV at 44.1 kHz
 * @param {object} [params]
 * @param {number} [params.thresholdSigma=3.5]  - Hampel detection sensitivity (lower = more aggressive)
 * @param {number} [params.maxClickMs=15]        - Max click duration to repair (ms); longer clicks are skipped
 * @returns {Promise<object>} Parsed JSON report from the script
 */
export function runClickRemover(inputPath, outputPath, params = {}) {
  const args = [inputPath, outputPath]
  if (params.thresholdSigma != null) args.push('--threshold',    String(params.thresholdSigma))
  if (params.maxClickMs     != null) args.push('--max-click-ms', String(params.maxClickMs))
  return spawnPythonCapture(CLICK_REMOVER_SCRIPT, args, 'ClickRemover')
}

// ── Resonance Suppressor ──────────────────────────────────────────────────────

/**
 * Stage 3b — Dynamic Resonance Suppressor.
 * STFT-based spectral spike detection and dynamic gain reduction applied to
 * voiced frames only (VAD mask), leaving silence frames unmodified.
 *
 * @param {string}        inputPath   32-bit float WAV at 44.1 kHz
 * @param {string}        outputPath  Pre-allocated output path (ctx.tmp('.wav'))
 * @param {string}        presetId    e.g. 'acx_audiobook'
 * @param {object[]|null} frames      ctx.results.metrics.frames — written to a temp
 *   JSON file for VAD gating. Pass null to suppress VAD gating (full-file mode).
 * @param {number|null}   f0          Estimated fundamental frequency for harmonic cross-referencing
 * @returns {Promise<object>}  Result dict from resonance_suppressor_report_entry()
 */
export async function applyResonanceSuppression(inputPath, outputPath, presetId, frames, f0 = null) {
  console.log(`[ResonanceSuppressor] Starting: preset=${presetId} | input=${inputPath}`)
  const startTime = Date.now()

  const args = [
    RESONANCE_SCRIPT,
    '--input',  inputPath,
    '--output', outputPath,
    '--preset', presetId,
  ]

  if (f0 != null) args.push('--f0', String(f0))

  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
    console.log(`[ResonanceSuppressor] Using VAD mask with ${frames.length} frames`)
  }

  let result
  try {
    result = await runResonanceScript(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }

  const durationMs = Date.now() - startTime
  console.log(
    `[ResonanceSuppressor] Done in ${durationMs}ms: skipped=${result.applied === false} ` +
    `max_reduction=${result.max_reduction_db ?? 'n/a'}dB ` +
    `artifact_risk=${result.artifact_risk ?? false}`,
  )
  return result
}

// ── Sibilance Suppressor ──────────────────────────────────────────────────────

/**
 * Stage 4 — Sibilance Suppressor.
 * F0-derived sibilant event detection with EMA-based spectral gain reduction.
 * Operates on voiced frames only (VAD mask).
 *
 * @param {string}        inputPath       32-bit float WAV at 44.1 kHz
 * @param {string}        outputPath      Pre-allocated output path (ctx.tmp('.wav'))
 * @param {string}        presetId        e.g. 'acx_audiobook'
 * @param {object[]|null} frames          ctx.results.metrics.frames — written to a temp
 *   JSON file for VAD gating. Pass null to suppress VAD gating (full-file mode).
 * @param {number|null}   f0              Estimated fundamental frequency; script estimates
 *   from audio if null.
 * @param {string|null}   eventsJsonPath  On-disk path to a precomputed event map
 *   (from analyzeSibilanceEvents). When provided, the script bypasses internal
 *   detection and consumes sibilantFrameIndices + f0.perFrame from the map.
 * @param {string|null}   emitEventsPath  When internal detection runs, also write
 *   the canonical event map to this path so the JS pipeline can cache it for
 *   downstream consumers without paying for a separate analyzer pass.
 *   Ignored when eventsJsonPath is set (consumer mode produces no new map).
 * @returns {Promise<object>}  Result dict from sibilance_suppressor_report_entry()
 */
export async function applySibilanceSuppression(inputPath, outputPath, presetId, frames, f0 = null, eventsJsonPath = null, emitEventsPath = null) {
  console.log(`[SibilanceSuppressor] Starting: preset=${presetId} | input=${inputPath}`)
  const startTime = Date.now()

  const args = [
    SIBILANCE_SCRIPT,
    '--input',  inputPath,
    '--output', outputPath,
    '--preset', presetId,
  ]

  if (f0 != null) args.push('--f0', String(f0))

  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
    console.log(`[SibilanceSuppressor] Using VAD mask with ${frames.length} frames`)
  }

  if (eventsJsonPath) {
    args.push('--events-json', eventsJsonPath)
    console.log(`[SibilanceSuppressor] Using precomputed event map: ${eventsJsonPath}`)
  } else if (emitEventsPath) {
    args.push('--emit-events', emitEventsPath)
  }

  let result
  try {
    result = await runSibilanceScript(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }

  const durationMs = Date.now() - startTime
  console.log(
    `[SibilanceSuppressor] Done in ${durationMs}ms: skipped=${result.applied === false} ` +
    `detected=${result.sibilant_frames_detected ?? 'n/a'} ` +
    `max_reduction=${result.max_reduction_db ?? 'n/a'}dB ` +
    `artifact_risk=${result.artifact_risk ?? false}`,
  )
  return result
}

// The resonance suppressor script uses a JSON_RESULT: line-prefix protocol
// rather than writing pure JSON to stdout, so it needs its own spawn helper.
function runResonanceScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RESONANCE_PYTHON, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
      },
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''

    proc.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      stdoutBuffer += text
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()
      for (const line of lines) {
        if (line.trim() && !line.startsWith('JSON_RESULT:')) {
          console.log(`[ResonanceSuppressor] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutBuffer.startsWith('JSON_RESULT:')) {
        console.log(`[ResonanceSuppressor] ${stdoutBuffer.trim()}`)
      }
      if (stderr.trim() && code === 0) console.log(`[ResonanceSuppressor] ${stderr.trim()}`)

      if (code === 0 && signal === null) {
        const jsonLine = stdout.split('\n').find(l => l.startsWith('JSON_RESULT:'))
        if (!jsonLine) {
          reject(new Error('ResonanceSuppressor: script exited 0 but emitted no JSON_RESULT line'))
          return
        }
        try {
          resolve(JSON.parse(jsonLine.slice('JSON_RESULT:'.length)))
        } catch (e) {
          reject(new Error(`ResonanceSuppressor: failed to parse JSON result: ${e.message}`))
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`ResonanceSuppressor exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ResonanceSuppressor: ${err.message}`))
    })
  })
}

function runSibilanceScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(RESONANCE_PYTHON, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
      },
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''

    proc.stdout.on('data', chunk => {
      const text = chunk.toString()
      stdout += text
      stdoutBuffer += text
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()
      for (const line of lines) {
        if (line.trim() && !line.startsWith('JSON_RESULT:')) {
          console.log(`[SibilanceSuppressor] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutBuffer.startsWith('JSON_RESULT:')) {
        console.log(`[SibilanceSuppressor] ${stdoutBuffer.trim()}`)
      }
      if (stderr.trim() && code === 0) console.log(`[SibilanceSuppressor] ${stderr.trim()}`)

      if (code === 0 && signal === null) {
        const jsonLine = stdout.split('\n').find(l => l.startsWith('JSON_RESULT:'))
        if (!jsonLine) {
          reject(new Error('SibilanceSuppressor: script exited 0 but emitted no JSON_RESULT line'))
          return
        }
        try {
          resolve(JSON.parse(jsonLine.slice('JSON_RESULT:'.length)))
        } catch (e) {
          reject(new Error(`SibilanceSuppressor: failed to parse JSON result: ${e.message}`))
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`SibilanceSuppressor exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn SibilanceSuppressor: ${err.message}`))
    })
  })
}
