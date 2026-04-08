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
import path from 'path'

const PYTHON = process.env.SEPARATION_PYTHON ?? 'python3'
const DEVICE = process.env.SEPARATION_DEVICE ?? 'auto'

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const RNNOISE_SCRIPT          = path.join(SCRIPTS_DIR, 'rnnoise_denoise.py')
const SEPARATE_SCRIPT         = path.join(SCRIPTS_DIR, 'separate_vocals.py')
const AUDIOSR_SCRIPT          = path.join(SCRIPTS_DIR, 'audiosr_extend.py')
const RESEMBLE_SCRIPT         = path.join(SCRIPTS_DIR, 'run_resemble_enhance.py')
const VOICEFIXER_SCRIPT       = path.join(SCRIPTS_DIR, 'voicefixer_enhance.py')
const HARMONIC_EXCITER_SCRIPT = path.join(SCRIPTS_DIR, 'harmonic_exciter.py')
const CLEARERVOICE_SCRIPT     = path.join(SCRIPTS_DIR, 'clearervoice_enhance.py')

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
 * Stage NE-6: AudioSR bandwidth extension.
 *
 * @param {string} inputPath     - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath    - 32-bit float WAV at 44.1 kHz
 * @param {number} guidanceScale - Diffusion guidance scale (default: 3.5)
 */
export function runAudioSR(inputPath, outputPath, guidanceScale = 3.5) {
  return spawnPython(
    AUDIOSR_SCRIPT,
    ['--input', inputPath, '--output', outputPath,
     '--guidance-scale', String(guidanceScale), '--device', DEVICE],
    'AudioSR',
  )
}

/**
 * Resemble Enhance denoising/enhancement.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {'denoise'|'enhance'} mode - Operation mode (default: 'enhance')
 * @param {object} [params]
 * @param {number} [params.nfe=64]           - CFM function evaluations (enhance only)
 * @param {string} [params.solver='midpoint'] - ODE solver: euler|midpoint|rk4 (enhance only)
 * @param {number} [params.lambd=0.1]        - Blend: 0.0=enhance-heavy, 1.0=denoise-heavy (enhance only)
 * @param {number} [params.tau=0.5]          - CFM conditioning noise level (enhance only)
 * @param {number} [params.chunkSeconds]     - Inference chunk size in seconds (default: 10 CPU / 30 CUDA)
 */
export function runResembleEnhance(inputPath, outputPath, mode = 'enhance', params = {}) {
  const args = [
    '--input',  inputPath,
    '--output', outputPath,
    '--mode',   mode,
    '--device', DEVICE,
  ]
  if (params.chunkSeconds != null) args.push('--chunk-seconds', String(params.chunkSeconds))
  if (mode === 'enhance') {
    if (params.nfe    != null) args.push('--nfe',    String(params.nfe))
    if (params.solver != null) args.push('--solver', params.solver)
    if (params.lambd  != null) args.push('--lambd',  String(params.lambd))
    if (params.tau    != null) args.push('--tau',    String(params.tau))
  }
  return spawnPython(RESEMBLE_SCRIPT, args, `Resemble Enhance (${mode})`)
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

// ── Internal helpers ──────────────────────────────────────────────────────────

function spawnPython(script, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
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
        reject(new Error(`${label} exited with ${reason}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}
