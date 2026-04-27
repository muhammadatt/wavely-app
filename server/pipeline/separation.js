/**
 * Separation helpers — Node.js spawners for NE Python scripts.
 *
 * Each function spawns the corresponding Python script as a child process and
 * resolves when the script exits with code 0. Failures throw with stderr
 * included in the message for debuggability.
 *
 * Python executable and device are configurable via environment variables:
 *   SEPARATION_PYTHON  — Python executable (default: python3)
 *   SEPARATION_DEVICE  — Compute device passed to scripts (default: auto)
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import os from 'os'
import path from 'path'

const PYTHON = process.env.SEPARATION_PYTHON ?? 'python3'
const DEVICE = process.env.SEPARATION_DEVICE ?? 'auto'
const NUM_THREADS = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const RNNOISE_SCRIPT          = path.join(SCRIPTS_DIR, 'rnnoise_denoise.py')
const DTLN_SCRIPT             = path.join(SCRIPTS_DIR, 'dtln_denoise.py')
const SEPARATE_SCRIPT         = path.join(SCRIPTS_DIR, 'separate_vocals.py')
const VOICEFIXER_SCRIPT       = path.join(SCRIPTS_DIR, 'voicefixer_enhance.py')
const HARMONIC_EXCITER_SCRIPT  = path.join(SCRIPTS_DIR, 'harmonic_exciter.py')
const VOCAL_SATURATION_SCRIPT  = path.join(SCRIPTS_DIR, 'vocal_saturation.py')
const CLEARERVOICE_SCRIPT      = path.join(SCRIPTS_DIR, 'clearervoice_enhance.py')
const DEREVERB_SCRIPT         = path.join(SCRIPTS_DIR, 'dereverb.py')
const AP_BWE_SCRIPT           = path.join(SCRIPTS_DIR, 'ap_bwe_extend.py')
const LAVASR_SCRIPT           = path.join(SCRIPTS_DIR, 'lavasr_extend.py')
const CLICK_REMOVER_SCRIPT    = path.join(SCRIPTS_DIR, 'click_remover.py')

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Stage NE-1: RNNoise pre-separation pass.
 * Reduces stationary broadband noise before handing off to the separator.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 */
export function runRnnoise(inputPath, outputPath) {
  return spawnPython(
    RNNOISE_SCRIPT,
    ['--input', inputPath, '--output', outputPath],
    'RNNoise',
  )
}

/**
 * DTLN noise reduction — lightweight LSTM-based denoiser, 16 kHz internal rate.
 * Mono-only: stereo inputs are mixed to mono inside the script.
 *
 * Env:
 *   DTLN_REPO        — path to cloned DTLN_pytorch repo (default: vendor/dtln_pytorch)
 *   DTLN_CHECKPOINT  — path to .pth weights (default: <DTLN_REPO>/DTLN_norm_500h.pth)
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz (mono)
 */
export function runDtln(inputPath, outputPath) {
  return spawnPython(
    DTLN_SCRIPT,
    ['--input', inputPath, '--output', outputPath],
    'DTLN',
    { DTLN_REPO: process.env.DTLN_REPO, DTLN_CHECKPOINT: process.env.DTLN_CHECKPOINT }
  )
}

/**
 * Stage NE-3: Vocal source separation.
 *
 * @param {string} inputPath   - 32-bit float WAV at 44.1 kHz (mono or stereo)
 * @param {string} outputPath  - 32-bit float WAV at 44.1 kHz (vocals stem only)
 * @param {'demucs'|'convtasnet'} model - Separation backend
 */
export function runSeparation(inputPath, outputPath, model = 'demucs') {
  return spawnPython(
    SEPARATE_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--model', model, '--device', DEVICE],
    `Separation (${model})`,
  )
}

/**
 * VoiceFixer speech restoration.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {0|1|2}  mode       - VoiceFixer mode: 0=original, 1=preprocessing, 2=train (default: 0)
 */
export function runVoiceFixer(inputPath, outputPath, mode = 0) {
  return spawnPython(
    VOICEFIXER_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--mode', String(mode), '--device', DEVICE],
    `VoiceFixer (mode ${mode})`,
  )
}

/**
 * Stage CE-3: ClearerVoice speech enhancement.
 * Replaces Demucs/ConvTasNet vocal separation in the ClearerVoice Eraser pipeline.
 * Models operate on mono audio internally — stereo inputs are mixed to mono in the script.
 *
 * @param {string} inputPath   - 32-bit float WAV at 44.1 kHz (mono or stereo)
 * @param {string} outputPath  - 32-bit float WAV at 44.1 kHz (mono)
 * @param {'mossformer2_48k'|'frcrn_16k'} model - ClearerVoice model
 */
export function runClearerVoice(inputPath, outputPath, model = 'mossformer2_48k') {
  return spawnPython(
    CLEARERVOICE_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--model', model, '--device', DEVICE],
    `ClearerVoice (${model})`,
  )
}

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
  const args = [
    '--input',    inputPath,
    '--output',   outputPath,
    '--strength', strength,
  ]
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
 *   AP_BWE_REPO        - path to cloned AP-BWE repo (default: vendor/ap_bwe)
 *   AP_BWE_CHECKPOINT  - path to the .pt checkpoint file (required)
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 48 kHz
 */
export function runApBwe(inputPath, outputPath) {
  return spawnPython(
    AP_BWE_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--device', DEVICE],
    'AP-BWE',
    { AP_BWE_CHECKPOINT: process.env.AP_BWE_CHECKPOINT, AP_BWE_REPO: process.env.AP_BWE_REPO }
  )
}

/**
 * Stage NE-6 (LavaSR path): Lightweight Vocos-based bandwidth extension.
 * Outputs 48 kHz WAV; caller resamples back to 44.1 kHz via decodeToFloat32.
 *
 * Requires:
 *   LAVASR_MODEL_PATH  - HuggingFace Hub ID or local path (default: YatharthS/LavaSR)
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 48 kHz
 */
export function runLavaSR(inputPath, outputPath) {
  return spawnPython(
    LAVASR_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--device', DEVICE],
    'LavaSR',
    { LAVASR_MODEL_PATH: process.env.LAVASR_MODEL_PATH }
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

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Like spawnPython but collects stdout and returns it as parsed JSON.
 * Stderr is still streamed to console in real time.
 */
function spawnPythonCapture(script, args, label, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: NUM_THREADS, MKL_NUM_THREADS: NUM_THREADS, TORCH_NUM_THREADS: NUM_THREADS, ...extraEnv },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', chunk => { stdout += chunk.toString() })

    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve({ raw: stdout.trim() })
        }
      } else {
        const reasonParts = []
        if (code !== null) reasonParts.push(`code ${code}`)
        if (signal !== null) reasonParts.push(`signal ${signal}`)
        const reason = reasonParts.length ? reasonParts.join(', ') : 'unknown reason'
        reject(new Error(`${label} exited with ${reason}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}

function spawnPython(script, args, label, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: NUM_THREADS, MKL_NUM_THREADS: NUM_THREADS, TORCH_NUM_THREADS: NUM_THREADS, ...extraEnv },
    })

    let stderr = ''

    // Stream stdout line-by-line in real time so progress is visible.
    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n')
      for (const line of lines) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    // Stream stderr in real time — tqdm progress bars from Demucs and other
    // models go to stderr; real-time draining prevents pipe-buffer deadlock
    // and keeps progress visible in server logs.
    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
      } else {
        const reasonParts = []
        if (code !== null) reasonParts.push(`code ${code}`)
        if (signal !== null) reasonParts.push(`signal ${signal}`)
        const reason = reasonParts.length ? reasonParts.join(', ') : 'unknown reason'
        reject(new Error(`${label} exited with ${reason}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}
