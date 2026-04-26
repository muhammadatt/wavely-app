/**
 * Stage 3b — Dynamic Resonance Suppressor.
 *
 * Runs instant_polish_resonance_suppressor.py as a Python subprocess.
 * Applies STFT-based spectral spike detection and dynamic gain reduction
 * to voiced frames only (VAD mask), leaving silence frames unmodified.
 *
 * Input/output: 32-bit float WAV at 44.1 kHz (pipeline internal format).
 */

import { spawn }         from 'child_process'
import { fileURLToPath } from 'url'
import { writeFile, rm } from 'fs/promises'
import os                from 'os'
import path              from 'path'
import { tempPath }      from '../lib/ffmpeg.js'

const PYTHON = process.env.RESONANCE_PYTHON
            ?? process.env.SEPARATION_PYTHON
            ?? process.env.DEEPFILTER_PYTHON
            ?? 'python3'
const NUM_THREADS = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'instant_polish_resonance_suppressor.py',
)

/**
 * @param {string}      inputPath   32-bit float WAV at 44.1 kHz
 * @param {string}      outputPath  Pre-allocated output path (ctx.tmp('.wav'))
 * @param {string}      presetId    e.g. 'acx_audiobook'
 * @param {object[]|null} frames    ctx.results.metrics.frames — written to a temp
 *   JSON file for VAD gating. Pass null to suppress VAD gating (full-file mode).
 * @param {number|null} f0          Estimated fundamental frequency for harmonic cross-referencing
 * @returns {Promise<object>}  Result dict from resonance_suppressor_report_entry()
 */
export async function applyResonanceSuppression(inputPath, outputPath, presetId, frames, f0 = null) {
  console.log(`[ResonanceSuppressor] Starting: preset=${presetId} | input=${inputPath}`)
  const startTime = Date.now()

  const args = [
    SCRIPT,
    '--input',  inputPath,
    '--output', outputPath,
    '--preset', presetId,
  ]

  if (f0 != null) {
    args.push('--f0', String(f0))
  }

  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = tempPath('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
    console.log(`[ResonanceSuppressor] Using VAD mask with ${frames.length} frames`)
  }

  let result
  try {
    console.log(`[ResonanceSuppressor] Running Python script...`)
    result = await runScript(args)
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

function runScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, args, {
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
      // The last element is either empty string (if text ended with \n) or incomplete line
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
      // Flush any remaining stdout buffer
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
        reject(new Error(
          `ResonanceSuppressor exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`,
        ))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ResonanceSuppressor: ${err.message}`))
    })
  })
}
