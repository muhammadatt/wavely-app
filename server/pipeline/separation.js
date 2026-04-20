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
 * Vocal Saturation — parallel tanh soft-saturation mixed with the dry signal.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {object} [params]
 * @param {number} [params.drive=2.0]   - tanh saturation factor
 * @param {number} [params.wetDry=0.3]  - mix ratio (0=dry, 1=wet)
 */
export function runVocalSaturation(inputPath, outputPath, params = {}) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (params.drive  != null) args.push('--drive',   String(params.drive))
  if (params.wetDry != null) args.push('--wet-dry', String(params.wetDry))
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
  )
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function spawnPython(script, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: NUM_THREADS, MKL_NUM_THREADS: NUM_THREADS, TORCH_NUM_THREADS: NUM_THREADS },
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
