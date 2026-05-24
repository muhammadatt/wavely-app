/**
 * Clip-gain de-esser pipeline module.
 *
 * Two-pass alternative to the compressor-based deEsser:
 *
 *   1. Detection — the shared sibilance detector is asked for the event map
 *      with `min_duration_ms` set, so brief consonant stops and click
 *      residuals are filtered out.
 *   2. Gain pass — clip_gain_deesser.py reads the audio and the enriched
 *      event map (per-event peak sample / dB / type), computes a per-event
 *      target gain relative to the surrounding voiced RMS, and renders a
 *      cosine-fade gain envelope that's multiplied against the file.
 *
 * No time constants. Each event gets a uniform gain reduction across its
 * body, framed by half-Hann fades that prevent clicks at the boundaries.
 */

import { spawn }                 from 'child_process'
import { fileURLToPath }         from 'url'
import { readFile, writeFile, rm } from 'fs/promises'
import os                        from 'os'
import path                      from 'path'
import { PYTHON as SHARED_PYTHON } from './spawnPython.js'

const CLIP_GAIN_PYTHON = process.env.CLIP_GAIN_DEESSER_PYTHON ?? SHARED_PYTHON
const NUM_THREADS      = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

const SCRIPTS_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const SCRIPT_PATH  = path.join(SCRIPTS_DIR, 'clip_gain_deesser.py')

/**
 * @typedef {Object} ClipGainDeEsserConfig
 * @property {boolean} [enabled]
 * @property {number}  [stridentCeilingDb]
 *   Ceiling for events tagged sibilantClass = "strident" (/s/, /ʃ/).
 * @property {number}  [nonStridentCeilingDb]
 *   Ceiling for events tagged sibilantClass = "non_strident" (/f/, /θ/).
 *   May be zero or negative — non-strident events sit below the surrounding
 *   voiced RMS so a positive ceiling rarely engages them.
 * @property {number}  [naturalCeilingDb]
 *   Back-compat single ceiling. Used for both classes when neither class-
 *   specific value is supplied. Ignored otherwise.
 * @property {number}  [reductionRatio]
 * @property {number}  [maxReductionDb]
 * @property {number}  [contextWindowMs]
 * @property {{
 *   fricativeInMs?:  number,
 *   fricativeOutMs?: number,
 *   affricateInMs?:  number,
 *   affricateOutMs?: number,
 * }} [fades]
 */

/**
 * Run the clip-gain de-esser.
 *
 * @param {string} inputPath
 * @param {string|null} outputPath   - Output WAV path. May be null when
 *                                     `opts.decisionOnly` is set.
 * @param {string} eventsJsonPath    - Path to the event map written by
 *                                     analyze_sibilance_events.py. The map's
 *                                     events must include startSample,
 *                                     endSample, peakSample, eventPeakDb,
 *                                     eventType (i.e. produced by a detector
 *                                     pass where `audio` was supplied).
 *                                     When `opts.recomputeEventPeaks` is set
 *                                     only startSample/endSample/eventType
 *                                     are required — eventPeakDb is measured
 *                                     fresh from `inputPath`.
 * @param {ClipGainDeEsserConfig} config
 * @param {Array}  [vadFrames]       - Frame list from frameAnalysis (used as
 *                                     the voiced/silence reference for
 *                                     context RMS measurement).
 * @param {{ recomputeEventPeaks?: boolean, decisionOnly?: boolean }} [opts]
 *   recomputeEventPeaks: re-measure each event's peak dBFS against `inputPath`
 *     within the [startSample, endSample] window, ignoring the eventPeakDb
 *     baked into the events JSON. Used when the events file came from a
 *     different signal stage (e.g. dry-path detection driving a wet-branch
 *     decision pass on the synthesized compressed signal).
 *   decisionOnly: don't write `outputPath`. The script still computes the
 *     per-event gain decisions and returns `treatedEvents`; the caller is
 *     responsible for any envelope rendering. Used by the parallel-compression
 *     wet-branch pass, which builds and applies the envelope in JS so it can
 *     mix in-process without a second WAV round-trip.
 * @returns {Promise<object>}
 */
export async function applyClipGainDeEsser(
  inputPath,
  outputPath,
  eventsJsonPath,
  config,
  vadFrames = null,
  opts = {},
) {
  const { recomputeEventPeaks = false, decisionOnly = false } = opts
  const fades = config.fades ?? {}
  // Class-keyed ceilings with legacy fallback. When a preset still ships only
  // the single naturalCeilingDb, both classes inherit it — preserves the
  // pre-split behaviour exactly.
  const legacyCeiling     = config.naturalCeilingDb     ?? 7.0
  const stridentCeiling   = config.stridentCeilingDb    ?? legacyCeiling
  const nonStridentCeil   = config.nonStridentCeilingDb ?? legacyCeiling
  const args  = [
    SCRIPT_PATH,
    '--input',                    inputPath,
    '--events-json',              eventsJsonPath,
    '--strident-ceiling-db',      String(stridentCeiling),
    '--non-strident-ceiling-db',  String(nonStridentCeil),
    '--reduction-ratio',          String(config.reductionRatio  ?? 0.55),
    '--max-reduction-db',         String(config.maxReductionDb  ?? 7.0),
    '--context-window-ms',        String(config.contextWindowMs ?? 80.0),
    '--fricative-fade-in-ms',     String(fades.fricativeInMs    ?? 3.0),
    '--fricative-fade-out-ms',    String(fades.fricativeOutMs   ?? 4.0),
    '--affricate-fade-in-ms',     String(fades.affricateInMs    ?? 1.5),
    '--affricate-fade-out-ms',    String(fades.affricateOutMs   ?? 4.5),
  ]

  if (outputPath)         args.push('--output', outputPath)
  if (recomputeEventPeaks) args.push('--recompute-event-peaks')
  if (decisionOnly)        args.push('--no-render')

  let vadMaskPath = null
  if (vadFrames && vadFrames.length > 0) {
    vadMaskPath = await writeTempJson(vadFrames)
    args.push('--vad-mask-json', vadMaskPath)
  }

  try {
    return await runScript(args)
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
  }
}

async function writeTempJson(payload) {
  const { tempPath } = await import('../lib/ffmpeg.js')
  const p = tempPath('.json')
  await writeFile(p, JSON.stringify(payload))
  return p
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLIP_GAIN_PYTHON, args, {
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
      const text   = chunk.toString()
      stdout      += text
      stdoutBuffer += text
      const lines  = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()
      for (const line of lines) {
        if (line.trim() && !line.startsWith('JSON_RESULT:')) {
          console.log(`[ClipGainDeEsser] ${line}`)
        }
      }
    })

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim() && !stdoutBuffer.startsWith('JSON_RESULT:')) {
        console.log(`[ClipGainDeEsser] ${stdoutBuffer.trim()}`)
      }
      if (stderr.trim() && code === 0) console.log(`[ClipGainDeEsser] ${stderr.trim()}`)

      if (code === 0 && signal === null) {
        const line = stdout.split('\n').find(l => l.startsWith('JSON_RESULT:'))
        if (!line) {
          reject(new Error('clip_gain_deesser: exited 0 but emitted no JSON_RESULT line'))
          return
        }
        try {
          resolve(JSON.parse(line.slice('JSON_RESULT:'.length)))
        } catch (err) {
          reject(new Error(`clip_gain_deesser: failed to parse JSON_RESULT: ${err.message}`))
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`clip_gain_deesser exited with ${parts.join(', ')}.\n${stderr.slice(-2000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn clip_gain_deesser: ${err.message}`))
    })
  })
}
