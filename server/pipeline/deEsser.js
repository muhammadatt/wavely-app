/**
 * Stage 4 — De-esser (Conditional).
 *
 * Reduces harsh sibilant energy using a true split-band (HPF + complementary
 * subtraction) architecture so only the high band is attenuated during
 * sibilant events. The legacy JS broadband-attenuation path is replaced by
 * a Python subprocess that uses scipy for vectorised STFT, biquad design,
 * and IIR filtering.
 *
 * Reference: processing spec v3, Stage 4.
 *
 * Algorithm (in de_esser.py):
 *   1. F0 per frame — reused from the cached sibilance event map when the
 *      upstream sibilance suppressor stage has produced one; otherwise
 *      estimated internally on voiced frames.
 *   2. Fricative event detection from the per-frame F0 trajectory and a
 *      continuous F0 -> sibilant band mapping (~3 kHz wide window whose
 *      lower edge tracks linearly with F0).
 *   3. Trigger condition (preset sensitivity) on the P95 - mean delta.
 *   4. Dynamic detection bandpass tracks the per-frame target frequency
 *      and feeds an envelope follower / gain-curve generator.
 *   5. Split-band processing: HPF the input at a static crossover (preset
 *      `crossoverHz`, default 4000 Hz), apply the gain curve to the high
 *      band only, and sum with the untouched low band.
 */

import { spawn }                  from 'child_process'
import { fileURLToPath }          from 'url'
import { readFile, writeFile, rm } from 'fs/promises'
import os                         from 'os'
import path                       from 'path'
import { tempPath }               from '../lib/ffmpeg.js'
import { PYTHON as SHARED_PYTHON } from './spawnPython.js'
import { PRESETS }                from '../presets.js'

const DE_ESSER_PYTHON = process.env.DE_ESSER_PYTHON ?? SHARED_PYTHON
const NUM_THREADS     = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR    = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const DE_ESSER_SCRIPT = path.join(SCRIPTS_DIR, 'de_esser.py')

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Analyze sibilance and conditionally apply de-essing.
 *
 * Thin wrapper around server/scripts/de_esser.py. The Python side handles
 * detection, gain-curve generation, and split-band processing; this function
 * marshals preset config and the cached sibilance event map (when present),
 * spawns the script, and returns the parsed result.
 *
 * @param {string} inputPath        - 32-bit float WAV at 44.1 kHz
 * @param {string} outputPath       - Output WAV path
 * @param {string} presetId
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @param {string|null} eventsJsonPath - On-disk path to a precomputed
 *   sibilance event map (from analyzeSibilanceEvents / sibilance_suppressor's
 *   --emit-events). When provided, de_esser.py reuses f0.perFrame and
 *   f0.median from the map instead of running its own F0 estimator.
 * @returns {DeEsserResult}
 *
 * @typedef {Object} DeEsserResult
 * @property {boolean} applied
 * @property {number|null} f0Hz            - Median F0 across the file
 * @property {number|null} targetFreqHz    - De-esser detection target frequency
 * @property {number|null} maxReductionDb  - Maximum gain reduction applied
 * @property {number|null} p95EnergyDb     - P95 sibilant energy (relative)
 * @property {number|null} meanEnergyDb    - Mean sibilant energy (relative)
 * @property {string|null} triggerReason
 * @property {number} [crossoverHz]        - Static split-band crossover used
 * @property {Array<{startSec:number, endSec:number, durationMs:number, avgReductionDb:number}>} treatedEvents
 */
export async function analyzeAndDeEss(inputPath, outputPath, presetId, frameAnalysis, eventsJsonPath = null) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error(`Unknown preset: ${presetId}`)

  const deEsserConfig = preset.deEsser

  // Skip the spawn entirely when the preset disables the de-esser. Mirrors
  // the legacy JS path's noResult shape and avoids touching the WAV.
  if (!deEsserConfig
      || deEsserConfig.sensitivity === 'none'
      || !(deEsserConfig.maxReduction > 0)) {
    await copyThrough(inputPath, outputPath)
    return noResult("Sensitivity 'none' or maxReduction <= 0")
  }

  const crossoverHz = deEsserConfig.crossoverHz ?? 4000
  const ratio       = deEsserConfig.ratio       ?? 6.7

  console.log(
    `[DeEsser] Starting: preset=${presetId} ` +
    `trigger=${deEsserConfig.trigger}dB ` +
    `maxReduction=${deEsserConfig.maxReduction}dB ` +
    `ratio=${ratio} ` +
    `crossover=${crossoverHz}Hz ` +
    `sensitivity=${deEsserConfig.sensitivity} | input=${inputPath}`,
  )
  const startTime = Date.now()

  const args = [
    DE_ESSER_SCRIPT,
    '--input',         inputPath,
    '--output',        outputPath,
    '--preset',        presetId,
    '--trigger',       String(deEsserConfig.trigger),
    '--max-reduction', String(deEsserConfig.maxReduction),
    '--sensitivity',   deEsserConfig.sensitivity,
    '--crossover-hz',  String(crossoverHz),
    '--ratio',         String(ratio),
  ]

  let vadMaskPath = null
  if (frameAnalysis?.frames?.length) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frameAnalysis.frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  if (eventsJsonPath) {
    args.push('--events-json', eventsJsonPath)
    console.log(`[DeEsser] Reusing sibilance event map: ${eventsJsonPath}`)
  }

  let result
  try {
    result = await runDeEsserScript(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }

  const durationMs = Date.now() - startTime
  console.log(
    `[DeEsser] Done in ${durationMs}ms: applied=${result.applied} ` +
    `f0=${result.f0Hz ?? 'n/a'}Hz ` +
    `maxRed=${result.maxReductionDb ?? 'n/a'}dB ` +
    `crossover=${result.crossoverHz ?? 'n/a'}Hz ` +
    `events=${result.treatedEvents?.length ?? 0}`,
  )

  return result
}

// ── Python subprocess helpers ───────────────────────────────────────────────

/**
 * Spawn de_esser.py and parse its JSON_RESULT: stdout line. Mirrors the
 * runResonanceScript / runSibilanceScript pattern in enhancement.js — the
 * Python script streams progress lines on stdout and emits a single
 * JSON_RESULT: line at the end with the result payload.
 */
function runDeEsserScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(DE_ESSER_PYTHON, args, {
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
          console.log(`[DeEsser] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutBuffer.startsWith('JSON_RESULT:')) {
        console.log(`[DeEsser] ${stdoutBuffer.trim()}`)
      }
      if (stderr.trim() && code === 0) console.log(`[DeEsser] ${stderr.trim()}`)

      if (code === 0 && signal === null) {
        const jsonLine = stdout.split('\n').find(l => l.startsWith('JSON_RESULT:'))
        if (!jsonLine) {
          reject(new Error('DeEsser: script exited 0 but emitted no JSON_RESULT line'))
          return
        }
        try {
          resolve(JSON.parse(jsonLine.slice('JSON_RESULT:'.length)))
        } catch (err) {
          reject(new Error(`DeEsser: failed to parse JSON_RESULT line: ${err.message}`))
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`DeEsser exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn DeEsser: ${err.message}`))
    })
  })
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function copyThrough(inputPath, outputPath) {
  await writeFile(outputPath, await readFile(inputPath))
}

function noResult(reason) {
  return {
    applied:        false,
    f0Hz:           null,
    targetFreqHz:   null,
    maxReductionDb: null,
    p95EnergyDb:    null,
    meanEnergyDb:   null,
    triggerReason:  reason,
    treatedEvents:  [],
  }
}