/**
 * Sibilance event map — detection-only Python pass for downstream stages.
 *
 * Any pipeline stage that needs per-frame sibilance data calls
 * analyzeSibilanceEvents(ctx, { params, f0Contour }) and gets a freshly
 * computed map back. Two design properties:
 *
 *   1. Each caller supplies its own detection params (sparse overrides
 *      over server/scripts/sibilance_detector.DEFAULT_PARAMS). airBoost
 *      uses `preset.airBoost.sibilanceDetection`; a `sibilant_only`
 *      resonanceSuppressor pass uses
 *      `preset.resonanceSuppressor[i].sibilanceDetection`. There is no
 *      shared "preset-level" sibilance config any more.
 *
 *   2. The F0 contour is either supplied by the caller (from getF0Contour()
 *      in f0Analysis.js — preferred when the caller needs the contour for
 *      anything else, e.g. resonanceSuppressor's harmonic mask) OR computed
 *      internally by analyze_sibilance_events.py on the already-loaded audio
 *      array. The internal path saves one full WAV read + one IPC roundtrip
 *      and is the right choice for callers whose only use of F0 is feeding
 *      it back into sibilance detection (e.g. clipGainDeEsser).
 *      In both cases the returned events map carries `events.f0` + `events.nFft`
 *      + `events.hopLength`, so the caller can stash a canonical contour
 *      shape on ctx._f0Contour for downstream cache hits.
 *
 * No shared event-map cache: each caller's params may differ, so caching
 * across stages would silently return the wrong map. If the same stage
 * needs the result twice it should hold the return value itself.
 */

import { fileURLToPath }          from 'url'
import { readFile, writeFile, rm } from 'fs/promises'
import path                       from 'path'
import { spawnPythonJsonResult }  from './spawnPython.js'

const SCRIPTS_DIR     = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const ANALYZER_SCRIPT = path.join(SCRIPTS_DIR, 'analyze_sibilance_events.py')

/**
 * Run a sibilance event analysis pass against ctx.currentPath.
 *
 * @param {object}  ctx                  Pipeline context (see createContext in index.js).
 * @param {object}  [options]
 * @param {object}  [options.params]     Sparse override dict overlaid on
 *                                       sibilance_detector.DEFAULT_PARAMS.
 *                                       Caller-specific (airBoost vs.
 *                                       resonanceSuppressor pass, etc.).
 * @param {object}  [options.f0Contour]  Per-frame F0 contour from
 *                                       getF0Contour() in f0Analysis.js.
 *                                       Optional — when omitted, the Python
 *                                       analyzer computes the contour
 *                                       internally on the already-loaded
 *                                       audio array (saves a second WAV
 *                                       read + IPC trip for callers whose
 *                                       only use of F0 is sibilance
 *                                       detection).
 * @returns {Promise<{events: object, path: string}>}
 *   - events: parsed event map (see sibilance_detector.build_events_map).
 *             Always includes `events.f0` ({median, perFrame}) and the STFT
 *             geometry (`events.nFft`, `events.hopLength`) regardless of
 *             whether the contour was supplied externally or computed
 *             internally — caller can reconstruct a canonical contour shape
 *             from this and seed ctx._f0Contour for downstream cache hits.
 *   - path:   on-disk JSON file (registered with ctx.tmp); pass to
 *             resonance_suppressor.py via --events-json or to
 *             air_boost_masked.py via --events. Stable for the lifetime
 *             of ctx.
 */
export async function analyzeSibilanceEvents(ctx, { params, f0Contour } = {}) {
  const eventsPath  = ctx.tmp('.json')

  const args = [
    '--input',  ctx.currentPath,
    '--output', eventsPath,
  ]

  // External-contour mode: write the supplied contour to a sidecar JSON and
  // pass it in. Internal-contour mode (no f0Contour): skip the flag, the
  // Python side runs estimate_f0_contour on the loaded audio array.
  let contourPath = null
  if (f0Contour) {
    contourPath = ctx.tmp('.json')
    await writeFile(contourPath, JSON.stringify(f0Contour))
    args.push('--f0-contour-json', contourPath)
  }

  // Merge the upstream-measured noise floor into the detection params so
  // the absolute-energy gate has a stable reference. analyzeFramesRaw
  // back-fills ctx.results.metrics.noiseFloorDbfs before any stage that
  // calls into here (airBoost, clipGainDeEsser). Clamped to [-70, -45]
  // dBFS so a pathological measurement (e.g. an unusually clean clip
  // that bottoms out the bootstrap estimate, or a noisy file that pulls
  // the floor up into the voice band) can't make the gate disappear or
  // suppress every sibilant. When the caller already provided an
  // explicit noise_floor_dbfs it wins.
  const mergedParams = { ...(params ?? {}) }
  if (mergedParams.noise_floor_dbfs === undefined) {
    const measured = ctx.results?.metrics?.noiseFloorDbfs
    if (Number.isFinite(measured)) {
      mergedParams.noise_floor_dbfs = Math.min(-45, Math.max(-70, measured))
    }
  }

  let paramsPath = null
  if (Object.keys(mergedParams).length > 0) {
    paramsPath = ctx.tmp('.json')
    await writeFile(paramsPath, JSON.stringify(mergedParams))
    args.push('--params-json', paramsPath)
  }

  const frames = ctx.results.metrics?.frames ?? null
  let vadMaskPath = null
  if (frames && frames.length > 0) {
    vadMaskPath = ctx.tmp('.json')
    await writeFile(vadMaskPath, JSON.stringify(frames))
    args.push('--vad-mask-json', vadMaskPath)
  }

  console.log(
    `[SibilanceAnalyzer] Starting: preset=${ctx.presetId} | input=${ctx.currentPath} ` +
    `| vad_frames=${frames == null ? 'null' : frames.length} ` +
    `vad_mask_passed=${vadMaskPath !== null}`
  )
  const startTime = Date.now()

  try {
    // The analyzer uses the JSON_RESULT: line-prefix protocol (summary
    // line on stdout, the heavy event map written to --output). We don't
    // need the summary value here — it's mirrored in the event map JSON
    // we read off disk below — but spawnPythonJsonResult is still the
    // right shape (it'll route through the worker for migrated scripts).
    await spawnPythonJsonResult(ANALYZER_SCRIPT, args, 'SibilanceAnalyzer')
  } finally {
    if (vadMaskPath) await rm(vadMaskPath, { force: true })
    if (paramsPath)  await rm(paramsPath,  { force: true })
    if (contourPath) await rm(contourPath, { force: true })
  }

  const events = JSON.parse(await readFile(eventsPath, 'utf8'))

  const durationMs = Date.now() - startTime
  console.log(
    `[SibilanceAnalyzer] Done in ${durationMs}ms: frames=${events.frameCount} ` +
    `sibilant=${events.sibilantFrameIndices.length} events=${events.events.length} ` +
    `f0_median=${events.f0?.median ?? 'n/a'}Hz`,
  )

  return { events, path: eventsPath }
}
