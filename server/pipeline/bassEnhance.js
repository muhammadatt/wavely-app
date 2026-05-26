/**
 * BassEnhance — psychoacoustic bass synthesis wrapper.
 *
 * Adds harmonic overtones of the fundamental and blends them into the dry
 * signal. The auditory system infers the missing fundamental from its
 * overtones, producing perceived sub-bass without the energy cost (or
 * limiter-overloading risk) of a real bass boost.
 *
 * Consumes upstream VAD frames (ctx.results.metrics.frames) and the cached
 * F0 contour (getF0Contour in f0Analysis.js); both are written to temp JSON
 * files referenced by --vad-frames-json / --f0-contour-json on the Python
 * side. The script handles missing inputs gracefully — VAD absent means the
 * whole file is treated as voiced; F0 absent means the fallback crossover
 * drives both the LPF and the fundamental-removal HPF.
 */

import { writeFile, rm } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { tempPath }       from '../lib/ffmpeg.js'
import { spawnPythonCapture } from './spawnPython.js'

const SCRIPTS_DIR        = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const BASS_ENHANCE_SCRIPT = path.join(SCRIPTS_DIR, 'bass_enhance.py')

/**
 * Apply BassEnhance to `inputPath`, writing the result to `outputPath`.
 *
 * @param {string} inputPath          32-bit float WAV (mono or stereo)
 * @param {string} outputPath         Pre-allocated output path (ctx.tmp('.wav'))
 * @param {object} [params]           Sparse parameter overrides; see bass_enhance.py
 * @param {object[]|null} [frames]    ctx.results.metrics.frames — written to a temp
 *   JSON file. Pass null/empty to disable VAD gating (whole file treated as voiced).
 * @param {{ median:number, perFrame:number[], nFft:number, hopLength:number }|null} [f0Contour]
 *   Per-frame F0 contour from getF0Contour() in f0Analysis.js. Pass null to fall
 *   back to crossoverFallbackHz for both the LPF crossover and the HPF cutoff.
 * @returns {Promise<object>}  Parsed JSON info dict from bass_enhance.py
 */
export async function applyBassEnhance(inputPath, outputPath, params = {}, frames = null, f0Contour = null) {
  const args = ['--input', inputPath, '--output', outputPath]

  // Segmentation
  if (params.crossoverFallbackHz != null) args.push('--crossover-fallback-hz', String(params.crossoverFallbackHz))
  if (params.segmentTransitionMs != null) args.push('--segment-transition-ms', String(params.segmentTransitionMs))
  if (params.f0ClusterMinGapMs   != null) args.push('--f0-cluster-min-gap-ms', String(params.f0ClusterMinGapMs))
  if (params.f0MinHz             != null) args.push('--f0-min-hz',             String(params.f0MinHz))
  if (params.f0MaxHz             != null) args.push('--f0-max-hz',             String(params.f0MaxHz))
  // Waveshaper
  if (params.drive               != null) args.push('--drive',                 String(params.drive))
  if (params.softness            != null) args.push('--softness',              String(params.softness))
  if (params.bias                != null) args.push('--bias',                  String(params.bias))
  // Fundamental removal
  if (params.fundamentalCutRatio     != null) args.push('--fundamental-cut-ratio',     String(params.fundamentalCutRatio))
  if (params.fundamentalCutSmoothMs  != null) args.push('--fundamental-cut-smooth-ms', String(params.fundamentalCutSmoothMs))
  if (params.fundamentalCutNFilters  != null) args.push('--fundamental-cut-n-filters', String(params.fundamentalCutNFilters))
  // VAD gate
  if (params.vadAttackMs         != null) args.push('--vad-attack-ms',         String(params.vadAttackMs))
  if (params.vadReleaseMs        != null) args.push('--vad-release-ms',        String(params.vadReleaseMs))
  // Skip & mix
  if (params.skipIfVoicedRatioBelow != null) args.push('--skip-if-voiced-ratio-below', String(params.skipIfVoicedRatioBelow))
  if (params.mix                 != null) args.push('--mix',                   String(params.mix))
  if (params.normalizeOutput === false)   args.push('--no-normalize-output')

  // VAD frames as a temp JSON — Python script handles missing file by
  // treating the whole input as voiced.
  let vadPath = null
  if (frames && frames.length > 0) {
    vadPath = tempPath('.json')
    await writeFile(vadPath, JSON.stringify(frames))
    args.push('--vad-frames-json', vadPath)
  }

  // F0 contour — write the whole getF0Contour() shape; the Python side
  // extracts perFrame / hopLength / median itself.
  let f0Path = null
  if (f0Contour?.perFrame?.length > 0) {
    f0Path = tempPath('.json')
    await writeFile(f0Path, JSON.stringify(f0Contour))
    args.push('--f0-contour-json', f0Path)
  }

  try {
    return await spawnPythonCapture(BASS_ENHANCE_SCRIPT, args, 'BassEnhance')
  } finally {
    if (vadPath) await rm(vadPath, { force: true }).catch(() => {})
    if (f0Path)  await rm(f0Path,  { force: true }).catch(() => {})
  }
}
