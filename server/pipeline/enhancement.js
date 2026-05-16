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

import { spawn }               from 'child_process'
import { fileURLToPath }       from 'url'
import { writeFile, readFile, rm } from 'fs/promises'
import os                     from 'os'
import path                   from 'path'
import { tempPath }      from '../lib/ffmpeg.js'
import { spawnPython, spawnPythonCapture, DEVICE, PYTHON as SHARED_PYTHON } from './spawnPython.js'
import { PRESETS }       from '../presets.js'

// Resonance suppressor allows its own Python override before falling back to
// the shared SEPARATION_PYTHON, matching the original RESONANCE_PYTHON cascade.
const RESONANCE_PYTHON = process.env.RESONANCE_PYTHON ?? SHARED_PYTHON
const NUM_THREADS      = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR                  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const HARMONIC_EXCITER_SCRIPT      = path.join(SCRIPTS_DIR, 'harmonic_exciter.py')
const VOCAL_SATURATION_SCRIPT      = path.join(SCRIPTS_DIR, 'vocal_saturation.py')
const DEREVERB_SCRIPT              = path.join(SCRIPTS_DIR, 'dereverb.py')
const AP_BWE_SCRIPT                = path.join(SCRIPTS_DIR, 'ap_bwe_extend.py')
const LAVASR_SCRIPT                = path.join(SCRIPTS_DIR, 'lavasr_extend.py')
const CLICK_REMOVER_SCRIPT         = path.join(SCRIPTS_DIR, 'click_remover.py')
const RESONANCE_SCRIPT             = path.join(SCRIPTS_DIR, 'resonance_suppressor.py')
const BREATH_REDUCER_SCRIPT        = path.join(SCRIPTS_DIR, 'breath_reducer.py')
const SPECTRAL_SUBTRACTION_SCRIPT  = path.join(SCRIPTS_DIR, 'spectral_subtraction.py')
const ROOM_PRESENCE_SCRIPT         = path.join(SCRIPTS_DIR, 'room_presence.py')

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
 * @param {number} [params.drive=2.0]          - base saturation drive factor
 * @param {number} [params.wetDry=0.3]         - mix ratio (0=dry, 1=wet)
 * @param {number} [params.bias=0.1]           - asymmetric bias for even-harmonic warmth
 * @param {number} [params.lowCrossover=500]   - low band upper boundary Hz
 * @param {number} [params.midCrossover=3500]  - mid band upper boundary Hz
 * @param {number} [params.softness=0.3]       - transfer function softness (0=tanh, 1=arctan)
 */
export function runVocalSaturation(inputPath, outputPath, params = {}) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (params.drive        != null) args.push('--drive',          String(params.drive))
  if (params.wetDry       != null) args.push('--wet-dry',        String(params.wetDry))
  if (params.bias         != null) args.push('--bias',           String(params.bias))
  if (params.lowCrossover != null) args.push('--low-crossover',  String(params.lowCrossover))
  if (params.midCrossover != null) args.push('--mid-crossover',  String(params.midCrossover))
  if (params.softness     != null) args.push('--softness',       String(params.softness))
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
 * DSP pre-pass: MMSE decision-directed spectral subtraction + optional transient shaper.
 *
 * Runs before the main ML noise reduction (DF3, RNNoise, DTLN) to reduce diffuse
 * noise and reverb energy, lowering the complexity of the signal the ML model
 * receives. Musical noise is prevented by the decision-directed SNR estimator,
 * spectral floor, and 3-bin median filter mop-up.
 *
 * @param {string} inputPath     - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath    - 32-bit float WAV at 44.1 kHz
 * @param {object} [params]
 * @param {number} [params.alphaDd=0.98]              - Decision-directed smoothing (0–1; higher = more temporal smoothing)
 * @param {number} [params.beta=0.05]                 - Spectral floor / minimum Wiener gain (0–1)
 * @param {number} [params.strength=1.0]              - Suppression strength (0 = bypass, 1 = full)
 * @param {boolean} [params.transientShaper=false]    - Enable transient shaper for reverb tail suppression
 * @param {number} [params.transientMaxReductionDb=6] - Transient shaper max gain reduction in dB
 */
export function runSpectralSubtraction(inputPath, outputPath, params = {}, vadLabelsPath = null) {
  const args = ['--input', inputPath, '--output', outputPath]
  if (params.alphaDd              != null) args.push('--alpha-dd',                   String(params.alphaDd))
  if (params.beta                 != null) args.push('--beta',                        String(params.beta))
  if (params.strength             != null) args.push('--strength',                    String(params.strength))
  if (params.transientShaper)              args.push('--transient-shaper')
  if (params.transientMaxReductionDb != null) args.push('--transient-max-reduction-db', String(params.transientMaxReductionDb))
  if (vadLabelsPath               != null) args.push('--vad-labels',                 vadLabelsPath)
  return spawnPython(SPECTRAL_SUBTRACTION_SCRIPT, args, 'SpectralSubtraction')
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
 * @param {{ median: number, perFrame: number[], nFft: number, hopLength: number }|null} f0Contour
 *   Per-frame F0 contour from getF0Contour() in f0Analysis.js. When provided, the
 *   harmonic mask tracks pitch changes frame-by-frame rather than using a fixed
 *   scalar position. If null is passed while `preserve_harmonics` remains enabled,
 *   resonance_suppressor.py may skip the entire stage rather than only disabling
 *   harmonic protection. To run without pitch data, callers must also override the
 *   suppressor params to set `preserve_harmonics=false` (e.g. via the preset params
 *   override path). Leaving `f0Contour` null without that override is intended only
 *   for diagnostic / bypass scenarios.
 * @param {string|null} eventsPath
 *   Optional path to the on-disk sibilance event map JSON produced by
 *   analyze_sibilance_events.py (via analyzeSibilanceEvents()). When
 *   supplied, passed as --events-json to the Python script so that any pass
 *   configured with `sibilant_only: true` can gate its suppression to only
 *   the detected sibilant frames. Ignored (and not passed to the script) when
 *   null — passes without sibilant_only are unaffected regardless.
 * @returns {Promise<object>}  Result dict from resonance_suppressor_report_entry()
 */
export async function applyResonanceSuppression(inputPath, outputPath, presetId, frames, f0Contour = null, eventsPath = null) {
  console.log(
    `[ResonanceSuppressor] Starting: preset=${presetId} | ` +
    `f0=${f0Contour ? `${f0Contour.median}Hz (contour, ${f0Contour.perFrame?.length} frames)` : 'none'} | ` +
    `sibilant_events=${eventsPath ? 'yes' : 'no'} | ` +
    `input=${inputPath}`,
  )
  const startTime = Date.now()

  const args = [
    RESONANCE_SCRIPT,
    '--input',  inputPath,
    '--output', outputPath,
  ]

  // Sparse per-preset overrides from src/audio/presets.js. Anything not
  // present in this block inherits from DEFAULT_PARAMS in the Python script.
  const overrides = PRESETS[presetId]?.resonanceSuppressor
  let paramsPath = null
  if (overrides && Object.keys(overrides).length > 0) {
    paramsPath = tempPath('.json')
    await writeFile(paramsPath, JSON.stringify(overrides))
    args.push('--params-json', paramsPath)
  }

  // Write the F0 contour to a temp JSON so the Python CLI can load it as
  // --f0-contour-json. The script also extracts the median and uses it as
  // the lifter cutoff scalar, so no separate --f0 arg is needed.
  let f0ContourPath = null
  if (f0Contour?.perFrame?.length > 0) {
    f0ContourPath = tempPath('.json')
    await writeFile(f0ContourPath, JSON.stringify(f0Contour))
    args.push('--f0-contour-json', f0ContourPath)
  }

  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
    console.log(`[ResonanceSuppressor] Using VAD mask with ${frames.length} frames`)
  }

  // Sibilance event map — only passed when the caller has it and the preset
  // has at least one sibilant_only pass. The Python script ignores it for
  // passes that do not set sibilant_only=True, so passing it unconditionally
  // is safe but wastes a CLI arg on the common case.
  if (eventsPath) {
    args.push('--events-json', eventsPath)
    console.log(`[ResonanceSuppressor] Using sibilance event map: ${eventsPath}`)
  }

  let result
  try {
    result = await runResonanceScript(args)
  } finally {
    if (paramsPath)    await rm(paramsPath,    { force: true })
    if (f0ContourPath) await rm(f0ContourPath, { force: true })
    if (vadMaskPath)   await rm(vadMaskPath,   { force: true })
  }

  const durationMs = Date.now() - startTime
  console.log(
    `[ResonanceSuppressor] Done in ${durationMs}ms (process=${result.process_seconds ?? 'n/a'}s): ` +
    `skipped=${result.applied === false} ` +
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
    proc.stdout.on('data', chunk => { stdout += chunk.toString() })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {

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

// ── Breath Reducer ────────────────────────────────────────────────────────────

/**
 * Stage 4c — Breath Reducer.
 *
 * Detects breath events (moderate RMS, high ZCR, high spectral flatness) in
 * unvoiced regions and applies a smooth wideband gain reduction envelope.
 *
 * @param {string}        inputPath   32-bit float WAV at 44.1 kHz
 * @param {string}        outputPath  Pre-allocated output path (ctx.tmp('.wav'))
 * @param {string}        presetId    e.g. 'acx_audiobook'
 * @param {object[]|null} frames      ctx.results.metrics.frames — VAD frame list
 *   for voiced-region exclusion. Pass null for full-file detection.
 * @returns {Promise<object>}  { applied, breath_events, max_reduction_db, process_seconds }
 */
export async function applyBreathReduction(inputPath, outputPath, presetId, frames) {
  const args = ['--input', inputPath, '--output', outputPath]

  const overrides = PRESETS[presetId]?.breathReducer
  let paramsPath = null
  if (overrides && Object.keys(overrides).length > 0) {
    paramsPath = tempPath('.json')
    await writeFile(paramsPath, JSON.stringify(overrides))
    args.push('--params-json', paramsPath)
  }

  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  try {
    return await spawnPythonCapture(BREATH_REDUCER_SCRIPT, args, 'BreathReducer')
  } finally {
    if (paramsPath)  await rm(paramsPath,  { force: true })
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }
}

// ── Room Presence ─────────────────────────────────────────────────────────────

/**
 * Convolution reverb — IR-based or synthetic.
 *
 * @param {string} inputPath   32-bit float WAV at 44.1 kHz
 * @param {string} outputPath  Pre-allocated output path (ctx.tmp('.wav'))
 * @param {object} [params]
 * @param {string} [params.irPath]            Path to .wir/.wav IR file; omit for synthetic IR
 * @param {number} [params.wet=0.08]          Wet mix fraction (0.0–0.3)
 * @param {number} [params.rt60Ms=80]         RT60 decay time in ms (20–200)
 * @param {number} [params.preDelayMs=1.5]    Pre-delay in ms (0–5)
 * @param {number} [params.earlyReflections=2] Onset ramp (1=sharp, 5=gradual)
 * @param {number} [params.diffusion=0.7]     Tail density/warmth for synthetic IR (0.0–1.0)
 * @returns {Promise<void>}
 */
export async function runRoomPresence(inputPath, outputPath, params = {}) {
  const resultPath = tempPath('.json')
  const args = ['--input', inputPath, '--output', outputPath, '--result-path', resultPath]
  if (params.irPath           != null) args.push('--ir-path',           String(params.irPath))
  if (params.wet              != null) args.push('--wet',               String(params.wet))
  if (params.rt60Ms           != null) args.push('--rt60-ms',           String(params.rt60Ms))
  if (params.preDelayMs       != null) args.push('--pre-delay-ms',      String(params.preDelayMs))
  if (params.earlyReflections != null) args.push('--early-reflections', String(params.earlyReflections))
  if (params.diffusion        != null) args.push('--diffusion',         String(params.diffusion))
  await spawnPython(ROOM_PRESENCE_SCRIPT, args, 'RoomPresence')
  try {
    const json = await readFile(resultPath, 'utf8')
    return JSON.parse(json)
  } catch {
    return {}
  } finally {
    rm(resultPath, { force: true }).catch(() => {})
  }
}
