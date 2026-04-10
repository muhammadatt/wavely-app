/**
 * Pipeline Debug Logger.
 *
 * When PIPELINE_LOG=true (or "1"), every processing run is written to a
 * timestamped directory under pipeline-logs/<run-id>/:
 *
 *   00_input.<ext>          — copy of the original uploaded file
 *   01_decode.wav           — audio after the decode stage
 *   02_monoMixdown.wav      — audio after mono mixdown (if path changed)
 *   ...
 *   NN_<stageName>.wav      — audio after each stage that produced a new file
 *   <run-id>.log            — human-readable text log with:
 *                               • run metadata and pipeline settings
 *                               • per-step timing, audio measurements,
 *                                 and stage result data
 *                               • final processing report JSON
 *
 * Stages that do not produce a new audio file (measureBefore, silenceAnalysis,
 * acxCertification, etc.) are still logged with their timing and any new
 * ctx.results keys they added.
 *
 * The logger never throws into the pipeline — all errors are caught and
 * emitted as warnings so that a disk-full or permission error cannot break
 * a processing run.
 *
 * Environment variables:
 *   PIPELINE_LOG=true|1          Enable pipeline logging (disabled by default)
 *   PIPELINE_LOG_DIR=<path>      Override log root directory
 *                                (default: server/pipeline-logs)
 *
 * Intended for local development and pipeline optimisation only.
 * Do NOT enable in production — audio snapshots consume significant disk space.
 */

import { randomUUID } from 'crypto'
import { mkdir, copyFile, appendFile, writeFile } from 'fs/promises'
import path from 'path'
import { measureAudio } from './measure.js'

const LOG_ENABLED =
  process.env.PIPELINE_LOG === 'true' || process.env.PIPELINE_LOG === '1'

const LOG_DIR = process.env.PIPELINE_LOG_DIR
  ? path.resolve(process.env.PIPELINE_LOG_DIR)
  : path.resolve(import.meta.dirname, '..', 'pipeline-logs')

// ── Public API ─────────────────────────────────────────────────────────────────

export function isLoggingEnabled() {
  return LOG_ENABLED
}

/**
 * Create and initialise a PipelineLogger for one processing run.
 * Returns null when logging is disabled, so callers can always do:
 *   if (logger) await logger.logStep(...)
 *
 * @param {object} preset        - Resolved preset config (post-overrides)
 * @param {object} outputProfile - Resolved output profile config
 * @param {string} originalName  - Original filename from the upload
 * @param {string} inputPath     - Path to the uploaded (pre-decode) file
 * @returns {PipelineLogger|null}
 */
export async function createLogger(preset, outputProfile, originalName, inputPath) {
  if (!LOG_ENABLED) return null
  const runId = randomUUID()
  const logger = new PipelineLogger(runId, preset, outputProfile, originalName)
  await logger.init(inputPath)
  return logger
}

// ── PipelineLogger ─────────────────────────────────────────────────────────────

class PipelineLogger {
  constructor(runId, preset, outputProfile, originalName) {
    this.runId        = runId
    this.runDir       = path.join(LOG_DIR, runId)
    this.logPath      = path.join(this.runDir, `${runId}.log`)
    this.stepIndex    = 0
    this.startTime    = Date.now()
    this.preset       = preset
    this.outputProfile = outputProfile
    this.originalName = originalName
    this._ready       = false   // set to true only after init() succeeds
  }

  /**
   * Create the run directory, copy the original input file, and write the
   * log header (run metadata + full preset / output-profile config JSON).
   */
  async init(inputPath) {
    try {
      await mkdir(this.runDir, { recursive: true })

      // Copy the raw uploaded file so the exact input is always available.
      const originalExt = path.extname(this.originalName) || '.wav'
      await copyFile(inputPath, path.join(this.runDir, `00_input${originalExt}`))

      const header = [
        '=== Pipeline Debug Log ===',
        `Run ID:         ${this.runId}`,
        `Timestamp:      ${new Date().toISOString()}`,
        `File:           ${this.originalName}`,
        `Preset:         ${this.preset.id}`,
        `Output Profile: ${this.outputProfile.id}`,
        `Log Dir:        ${this.runDir}`,
        '',
        '=== Preset Configuration ===',
        JSON.stringify(this.preset, null, 2),
        '',
        '=== Output Profile Configuration ===',
        JSON.stringify(this.outputProfile, null, 2),
        '',
        '=== Pipeline Stages ===',
        '',
      ].join('\n')

      await writeFile(this.logPath, header, 'utf8')
      this._ready = true
      console.log(`[pipeline-log] Run ${this.runId} — logging to ${this.runDir}`)
    } catch (err) {
      // A logger init failure must never crash the pipeline.
      console.warn(`[pipeline-log] Logger init failed — logging disabled for this run: ${err.message}`)
    }
  }

  /**
   * Log one pipeline stage.
   *
   * @param {string}      stageName    - Stage function name (e.g. 'noiseReduce')
   * @param {string|null} audioPath    - Path to the audio file produced by this
   *                                     stage, or null if the stage produced no
   *                                     new audio file.
   * @param {object}      stageResults - New ctx.results keys added by this stage.
   * @param {number}      durationMs   - Wall-clock time for the stage in ms.
   */
  async logStep(stageName, audioPath, stageResults, durationMs) {
    if (!this._ready) return
    try {
      this.stepIndex++
      const idx         = String(this.stepIndex).padStart(2, '0')
      const durationStr = durationMs != null ? ` (${(durationMs / 1000).toFixed(2)}s)` : ''
      const lines       = [`── Step ${idx}: ${stageName}${durationStr}`]

      if (audioPath) {
        // Full audio measurement at this checkpoint.
        // measureAudio runs FFmpeg volumedetect + libebur128 LUFS/true-peak in
        // parallel, adding ~0.2–0.5 s per step — acceptable for a debug tool.
        try {
          const m = await measureAudio(audioPath)
          lines.push(
            `   Audio:  RMS=${fmt(m.rmsDbfs)} dBFS  ` +
            `TruePeak=${fmt(m.truePeakDbfs)} dBTP  ` +
            `NoiseFloor=${fmt(m.noiseFloorDbfs)} dBFS  ` +
            `LUFS=${fmt(m.lufsIntegrated)}`
          )
        } catch (e) {
          lines.push(`   Audio:  measurement failed — ${e.message}`)
        }

        // Copy the audio snapshot to the run directory.
        try {
          const ext      = path.extname(audioPath) || '.wav'
          const destName = `${idx}_${stageName}${ext}`
          await copyFile(audioPath, path.join(this.runDir, destName))
          lines.push(`   File:   ${destName}`)
        } catch (e) {
          lines.push(`   File:   copy failed — ${e.message}`)
        }
      }

      // Stage metadata — new ctx.results keys added by this stage.
      if (stageResults && Object.keys(stageResults).length > 0) {
        // Indent multi-line JSON so it's easy to read in the log.
        const metaJson = JSON.stringify(stageResults, null, 2)
          .split('\n')
          .map((l, i) => (i === 0 ? `   Meta:  ${l}` : `           ${l}`))
          .join('\n')
        lines.push(metaJson)
      }

      lines.push('')
      await appendFile(this.logPath, lines.join('\n') + '\n', 'utf8')
    } catch (err) {
      console.warn(`[pipeline-log] Failed to log step "${stageName}": ${err.message}`)
    }
  }

  /**
   * Append the final processing report JSON and a run-summary footer.
   * Called after the pipeline completes successfully.
   *
   * @param {object} report - The report object returned by buildReport().
   */
  async finalize(report) {
    if (!this._ready) return
    try {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2)
      const footer  = [
        '=== Final Report ===',
        JSON.stringify(report, null, 2),
        '',
        '=== Run Complete ===',
        `Total elapsed: ${elapsed}s`,
        `Steps logged:  ${this.stepIndex}`,
        `Run ID:        ${this.runId}`,
        `Log dir:       ${this.runDir}`,
        '',
      ].join('\n')
      await appendFile(this.logPath, footer, 'utf8')
      console.log(
        `[pipeline-log] Run ${this.runId} complete — ` +
        `${this.stepIndex} steps in ${elapsed}s`
      )
    } catch (err) {
      console.warn(`[pipeline-log] Failed to finalise log: ${err.message}`)
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a numeric measurement value for display, handling null gracefully. */
function fmt(value) {
  return value != null ? value : '?'
}
