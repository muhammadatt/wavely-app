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
 * 44.1 kHz → 48 kHz resample on input and the algorithmic-delay alignment;
 * decodeToFloat32 resamples the 48 kHz output back to 44.1 kHz so the rest
 * of the pipeline sees its expected format.
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { decodeToFloat32, tempPath, removeTmp, padStart } from '../lib/ffmpeg.js'
import { spawnPython, spawnPythonJsonResult } from './spawnPython.js'

// --- DeepFilter invocation strategy ---
// DEEPFILTER_BINARY (env): path to a pre-built deep-filter CLI binary.
//   Used on platforms where the Python deepfilternet package can't be
//   compiled (e.g. Windows ARM64 without MSVC Build Tools).
//   On Linux servers, leave unset — the Python script path is used instead.
// DEEPFILTER_PYTHON (env): Python executable for the local spawn helper.
//   This now only affects the DTLN path and the CLI-binary error log, since
//   DeepFilterNet3 and RNNoise are routed through spawnPython() and pick up
//   the persistent worker (which uses SEPARATION_PYTHON). Setting
//   DEEPFILTER_PYTHON without SEPARATION_PYTHON will not affect the DF3 or
//   RNNoise interpreter — set SEPARATION_PYTHON to override that.
const DEEPFILTER_BINARY = process.env.DEEPFILTER_BINARY ?? null
const PYTHON = process.env.DEEPFILTER_PYTHON ?? 'python3'
const NUM_THREADS = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR      = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const SCRIPT           = path.join(SCRIPTS_DIR, 'deepfilter_enhance.py')
const RNNOISE_SCRIPT   = path.join(SCRIPTS_DIR, 'rnnoise_denoise.py')
const DTLN_SCRIPT      = path.join(SCRIPTS_DIR, 'dtln_denoise.py')

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
  const strategy = DEEPFILTER_BINARY ? `CLI binary (${DEEPFILTER_BINARY})` : 'Python script'
  console.log(`[DeepFilter] Starting: model=DeepFilterNet3 strategy=${strategy} atten_lim_db=${attenLimDb ?? 'uncapped'}`)

  if (DEEPFILTER_BINARY) {
    // CLI binary doesn't compensate for the 10ms algorithmic fade-in delay
    // itself, so the JS wrapper still pads + trims around it.
    const paddedInput = tempPath('.wav')
    await padStart(inputPath, paddedInput, 10)
    const nr48kPath = tempPath('.wav')
    try {
      await runDeepFilterCli(paddedInput, nr48kPath, attenLimDb)
      await decodeToFloat32(nr48kPath, outputPath, { trimStartMs: 10 })
    } finally {
      await removeTmp(paddedInput)
      await removeTmp(nr48kPath)
    }
  } else {
    // Python script absorbs the algorithmic-delay pad/strip internally so
    // its 48 kHz output is already length-aligned with the 48 kHz input.
    // Only the 48 kHz → 44.1 kHz resample remains for JS to handle.
    const nr48kPath = tempPath('.wav')
    try {
      await runDeepFilterPython(inputPath, nr48kPath, attenLimDb)
      await decodeToFloat32(nr48kPath, outputPath)
    } finally {
      await removeTmp(nr48kPath)
    }
  }

  console.log(`[DeepFilter] Done`)
  return {
    applied:               true,
    model:                 'DeepFilterNet3',
    atten_lim_db:          attenLimDb,
    post_noise_floor_dbfs: null, // remeasured after full chain in Stage 7
  }
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
 * Routed through spawnPython so the persistent worker handles the DF3 model
 * load once per server lifetime instead of every pipeline run.
 */
function runDeepFilterPython(inputPath, outputPath, attenLimDb) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (attenLimDb !== null) {
    args.push('--atten-lim-db', String(attenLimDb))
  }
  return spawnPython(SCRIPT, args, 'DeepFilter Python')
}

// ── Noise reduction alternatives ──────────────────────────────────────────────

/**
 * Stage NE-1: RNNoise pre-separation pass.
 * Lightweight LSTM-based denoiser; reduces stationary broadband noise before
 * handing off to the separator.
 *
 * @param {string} inputPath  - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath - 32-bit float WAV at 44.1 kHz
 * @param {object} [options]
 * @param {string|null} [options.speechProbOut=null] - Explicit path for the
 *   per-frame VAD speech_prob JSON sidecar. If null and the env var
 *   RNNOISE_SPEECH_PROB_DIR is set, the sidecar is written into that
 *   directory using the output WAV's basename. Diagnostic only.
 * @param {Array<{isSilence: boolean}>|null} [options.sileroFrames=null] -
 *   The pipeline's per-frame Silero VAD labels (25 ms frames) from
 *   ctx.results.metrics.frames. When provided, the JS wrapper serialises the
 *   isSilence array to a temp JSON sidecar and passes its path into
 *   rnnoise_denoise.py as --silero-mask. The Python side resolves it onto
 *   RNNoise's 10 ms frame grid for use in the speech_prob diagnostic and
 *   the VAD-disagreement gate.
 * @param {object|null} [options.vadGate=null] - VAD-disagreement gate config.
 *   When `enabled` and sileroFrames are provided, the Python side restores
 *   the dry input on frames where Silero says speech but RNNoise's internal
 *   VAD reports speech_prob below `rnnoiseThreshold`. A short linear
 *   crossfade (`crossfadeMs`) at every override-region boundary keeps
 *   frame-edge transitions click-free. `hangoverFrames` right-extends each
 *   override region forward in time (10 ms per frame) so RNNoise's causal
 *   VAD has time to lock onto voicing before the gate hands control back —
 *   without this, the leading edge of vowels after fricatives is audibly
 *   dipped while RNNoise's speech_prob ramps up. Defaults: threshold=0.30,
 *   xfade=1 ms, hangover=2 frames (= 20 ms).
 */
export async function runRnnoise(
  inputPath,
  outputPath,
  { speechProbOut = null, sileroFrames = null, vadGate = null } = {},
) {
  // RNNoise has a 20ms algorithmic delay (10ms frame + 10ms lookahead). The
  // Python script handles the 20ms pad + 40ms strip + length-match internally
  // and writes 44.1 kHz float32 mono directly to outputPath, so the JS wrapper
  // no longer needs separate padStart/decodeToFloat32 ffmpeg passes.
  let sidecarPath = speechProbOut
  if (!sidecarPath && process.env.RNNOISE_SPEECH_PROB_DIR) {
    const dir = process.env.RNNOISE_SPEECH_PROB_DIR
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(outputPath, path.extname(outputPath))
    sidecarPath = path.join(dir, `${base}.speech_prob.json`)
  }

  // Serialise the Silero mask to a temp JSON sidecar when provided. The
  // payload carries only the isSilence boolean array — the Python side has
  // no use for the per-frame RMS values and reading less reduces I/O.
  let sileroMaskPath = null
  if (sileroFrames && sileroFrames.length) {
    sileroMaskPath = tempPath('.json')
    const isSilence = sileroFrames.map(fr => Boolean(fr.isSilence))
    fs.writeFileSync(
      sileroMaskPath,
      JSON.stringify({ frame_duration_ms: 25, isSilence }),
    )
  }

  const args = ['--input', inputPath, '--output', outputPath]
  if (sidecarPath)    args.push('--speech-prob-out', sidecarPath)
  if (sileroMaskPath) args.push('--silero-mask',    sileroMaskPath)

  // VAD gate is opt-in per call and requires the Silero mask. Without the
  // mask the gate has nothing to disagree with; passing --vad-gate alone
  // would be a no-op on the Python side, so don't surface the flag at all.
  const gateActive = !!(vadGate && vadGate.enabled && sileroMaskPath)
  if (gateActive) {
    args.push('--vad-gate')
    if (typeof vadGate.rnnoiseThreshold === 'number') {
      args.push('--rnnoise-threshold', String(vadGate.rnnoiseThreshold))
    }
    if (typeof vadGate.crossfadeMs === 'number') {
      args.push('--crossfade-ms', String(vadGate.crossfadeMs))
    }
    if (Number.isInteger(vadGate.hangoverFrames) && vadGate.hangoverFrames >= 0) {
      args.push('--hangover-frames', String(vadGate.hangoverFrames))
    }
  }

  let result = null
  try {
    // spawnPythonJsonResult works in both worker mode (returns the dict from
    // run(argv) directly) and legacy spawn mode (parses the JSON_RESULT: line
    // emitted by the script's __main__).
    result = await spawnPythonJsonResult(RNNOISE_SCRIPT, args, 'RNNoise')
  } finally {
    if (sileroMaskPath) await removeTmp(sileroMaskPath)
  }
  return {
    speechProbOut: sidecarPath,
    vadGate:       result?.vad_gate ?? null,
  }
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
  return spawnProcess(PYTHON, [DTLN_SCRIPT, '--input', inputPath, '--output', outputPath], 'DTLN')
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Shared subprocess helper.
 */
function spawnProcess(executable, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMP_NUM_THREADS: NUM_THREADS, MKL_NUM_THREADS: NUM_THREADS, TORCH_NUM_THREADS: NUM_THREADS },
    })

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
      // CLI binary (deep-filter.exe) writes progress to stderr; log it on success too.
      if (stderr.trim() && code === 0) console.log(`[${label}] ${stderr.trim()}`)
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
