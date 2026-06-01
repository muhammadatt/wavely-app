/**
 * Stage 3b — Air Boost
 *
 * Adds a wide, gradual high-frequency lift modeled on the Maag EQ4 Air Band
 * at the 10 kHz corner setting.
 *
 * Filter model: 5 parametric peaking bands (bells) + 1 high shelf.
 * The Maag Air Band curve is a log-frequency sigmoid (fc=3675 Hz, n=1.774),
 * which cannot be reproduced by standard biquad shelf filters. It requires
 * overlapping wide parametric bands whose sum approximates the sigmoid shape.
 *
 * Reference plateau (REFERENCE_PLATEAU_DB): plateau lift measured directly
 * from canonical Maag EQ4 hardware data (Air Band, 10 kHz corner, knob=10):
 * 16.460 dBu plateau (median 29k–40k Hz) − 3.910 dBu baseline (median
 * 50–500 Hz) = 12.55 dB, rounded to 12.5932 (the value used historically;
 * within measurement noise of the dataset). All gains scale linearly from
 * this reference by the factor (air_boost_db / REFERENCE_PLATEAU_DB).
 *
 * The gRef values are fitted directly against the realised FFmpeg
 * equalizer/highshelf biquad response — not against an analytic sigmoid —
 * by `server/scripts/fit_airboost_bands.py` using log-frequency RMS
 * minimisation across 100 Hz – 20 kHz. Resulting fit quality vs. the Maag
 * hardware curve at reference plateau gain:
 *   RMS error   : 0.12 dB
 *   max |error| : 0.30 dB across 100 Hz – 16 kHz
 *                 (1.15 dB at the 20 kHz edge, from shelf rise near Nyquist;
 *                  irrelevant for speech content)
 *
 * Realised response at the 18 dB setting (impulse → FFT verification):
 *   1870 Hz:  Maag +4.27 dB  →  model +4.56 dB   (delta +0.29 dB)
 *   5556 Hz:  Maag +12.45 dB →  model +12.05 dB  (delta −0.40 dB)
 *  13610 Hz:  Maag +16.83 dB →  model +16.63 dB  (delta −0.21 dB)
 *
 * Topology note: the high shelf provides the bulk lift (+22.5 dB at
 * reference plateau) and the 2.4 / 4.8 / 9.6 kHz bells carve it back into
 * the Maag's slow log-frequency sigmoid shape. At a typical operating
 * gain of 2 dB these bells are fractions of a dB each.
 *
 * model: maag_eq4_approximation_v2
 *
 * ACX output profile: a pre/post noise floor check constrains the applied
 * gain to keep the noise floor below the -60 dBFS ACX ceiling.
 */

import { fileURLToPath }  from 'url'
import path               from 'path'
import { readFile }       from 'fs/promises'
import { applyParametricEQ, tempPath, removeTmp } from '../lib/ffmpeg.js'
import { remeasureFrames }    from './frameAnalysis.js'
import { spawnPython }    from './spawnPython.js'
import { getReferenceCurvePath } from './referenceEQ.js'

const SCRIPTS_DIR    = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const MASK_SCRIPT    = path.join(SCRIPTS_DIR, 'air_boost_masked.py')
const PRECUT_SCRIPT  = path.join(SCRIPTS_DIR, 'air_boost_precut.py')

const ACX_NOISE_FLOOR_CEILING = -60   // dBFS — ACX hard ceiling
const ACX_PRE_CHECK_LIMIT     = -61   // dBFS — skip if already this close before boost
const REDUCTION_STEP_DB       = 0.25  // dB per iteration of the ACX reduction loop

const DEFAULT_PRECUT_MAX_CUT_DB    = 6.0
const DEFAULT_PRECUT_MIN_EXCESS_DB = 1.0

// ─── Filter model ────────────────────────────────────────────────────────────
//
// The Maag Air Band shape is a sigmoid on the log-frequency scale.
// It cannot be reproduced by standard biquad shelf filters (which transition
// in 1–2 octaves; the Maag transitions over ~4 octaves). The correct
// implementation uses parametric peaking bands (bells) whose overlapping
// skirts sum to the sigmoid shape, plus a high shelf to handle the plateau
// without upper-frequency rolloff.
//
// All gRef values are the per-band gains at the reference plateau of 12.5932 dB.
// At runtime, each gain is scaled by (air_boost_db / REFERENCE_PLATEAU_DB).
//
// Measurement notes:
//   - Low-frequency lift below 300 Hz is < 0.04 dB at reference plateau
//     (< 0.01 dB at typical operating gains of 1.5–2.5 dB).
//   - The 2.4 / 4.8 / 9.6 kHz bells have negative gRef values — these are
//     corrective subtractive shaping that pulls the high shelf's broad
//     plateau down into the Maag's slow log-frequency sigmoid. They are
//     not a "cut" in the audible sense; the net response at every audible
//     frequency is non-negative.

const REFERENCE_PLATEAU_DB = 12.5932

const BANDS = [
  // Parametric peaking bands (bells), Q = 0.5
  { freqHz:   600, type: 'bell',  q: 0.5,   gRef:  -0.02733 },
  { freqHz:  1200, type: 'bell',  q: 0.5,   gRef:  -0.30754 },
  { freqHz:  2400, type: 'bell',  q: 0.5,   gRef:  -1.18676 },
  { freqHz:  4800, type: 'bell',  q: 0.5,   gRef:  -0.90883 },
  { freqHz:  9600, type: 'bell',  q: 0.5,   gRef:  +0.91883 },
  // High shelf — provides the bulk plateau lift
  // width_type=o (octaves), w=3.023 oct corresponds to Q=0.4
  { freqHz: 14000, type: 'shelf', wOct: 3.023, gRef: +22.54678 },
]

function buildFilters(gainDb) {
  const scale = gainDb / REFERENCE_PLATEAU_DB
  return BANDS.map(band => {
    const g = (band.gRef * scale).toFixed(5)
    if (band.type === 'bell') {
      return `equalizer=f=${band.freqHz}:width_type=q:w=${band.q}:g=${g}`
    } else {
      return `highshelf=f=${band.freqHz}:width_type=o:w=${band.wOct}:g=${g}`
    }
  })
}

function bandsReport(gainDb) {
  const scale = gainDb / REFERENCE_PLATEAU_DB
  return BANDS.map(band => ({
    f_hz:    band.freqHz,
    type:    band.type,
    ...(band.type === 'bell'
      ? { q: band.q }
      : { width_oct: band.wOct }),
    gain_db: round4(band.gRef * scale),
  }))
}

function round4(x) { return Math.round(x * 10000) / 10000 }

/**
 * Diagnostic fragment about the precut analysis — always safe to merge, even
 * into a skipped-stage result. Does NOT include `pre_attenuation`; that field
 * is added separately by the success path because it represents a filter the
 * stage actually applied to audio.
 */
function buildPrecutDiagnostic(precut, precutErr) {
  if (!precut) return { precut: { ran: false, reason: 'no_preset_context' } }
  if (precutErr) {
    return { precut: { ran: false, reason: 'script_error', error: precutErr } }
  }
  if (!precut.applied) {
    return {
      precut: {
        ran:             true,
        applied:         false,
        reason:          precut.reason,
        n_speech_frames: precut.n_speech_frames,
      },
    }
  }
  return {
    precut: {
      ran:                       true,
      applied:                   true,
      gain_db_reduction:         precut.gain_db_reduction ?? 0,
      peak_excess_db:            precut.peak_excess_db,
      excess_curve_db:           precut.excess_curve_db,
      excess_curve_freqs_hz:     precut.excess_curve_freqs_hz,
      reference_corpus_version:  precut.reference_corpus_version,
      reference_spec_version:    precut.reference_spec_version,
    },
  }
}

/**
 * Run the predictive pre-attenuation analysis (air_boost_precut.py).
 *
 * Measures the current spectrum, predicts the post-airBoost magnitude in the
 * 6-16 kHz region, and sizes a single bell cut sized to bring any predicted
 * excess down to the preset's referenceEQ target curve. Returns a normalised
 * object regardless of whether a cut is applied.
 *
 * Gated on reference-curve presence: with no curve at
 * data/reference_curves/{presetId}.json this is a clean no-op (mirroring how
 * referenceEQ itself behaves while the corpus is being built).
 */
async function runPrecutAnalysis(inputPath, gainDb, presetId, precutConfig, noiseFloorDbfs) {
  if (precutConfig?.enabled === false) {
    return { applied: false, reason: 'precut_disabled' }
  }
  const curvePath = await getReferenceCurvePath(presetId)
  if (!curvePath) {
    return { applied: false, reason: 'no_reference_curve' }
  }

  const maxCutDb    = precutConfig?.maxCutDb    ?? DEFAULT_PRECUT_MAX_CUT_DB
  const minExcessDb = precutConfig?.minExcessDb ?? DEFAULT_PRECUT_MIN_EXCESS_DB

  const resultPath = tempPath('.json')

  const args = [
    '--input',         inputPath,
    '--result-json',   resultPath,
    '--curve',         curvePath,
    '--air-boost-db',  String(gainDb),
    '--max-cut-db',    String(maxCutDb),
    '--min-excess-db', String(minExcessDb),
  ]
  if (noiseFloorDbfs != null) args.push('--noise-floor', String(noiseFloorDbfs))

  try {
    await spawnPython(PRECUT_SCRIPT, args, 'AirBoostPrecut')
    const text = await readFile(resultPath, 'utf8')
    return JSON.parse(text)
  } finally {
    await removeTmp(resultPath)
  }
}

/**
 * Determine Air Boost filter parameters and write the processed output.
 *
 * Runs the predictive pre-cut analysis and (for ACX) the iterative noise-floor
 * compliance loop to find the highest gain that satisfies -60 dBFS. Writes the
 * result to outputPath so the caller can reuse it directly in sequential mode
 * without a second FFmpeg pass.
 *
 * @param {string} inputPath        Source WAV (float32, 44.1 kHz)
 * @param {string} outputPath       Destination path (pre-allocated by caller via ctx.tmp)
 * @param {number} gainDb           Requested boost from preset.airBoost.gainDb
 * @param {string} outputProfileId  'acx' | 'podcast' | 'broadcast'
 * @param {object} metrics          ctx.results.metrics — must contain frames[] for remeasure
 * @param {object} [options]
 * @param {string} [options.presetId]      Preset id (looked up for reference curve)
 * @param {object} [options.precutConfig]  { enabled, maxCutDb, minExcessDb }
 * @returns {object}                Result object (bands, applied_gain_db, …) written to ctx.results.airBoost
 */
export async function computeAirBoostParams(inputPath, outputPath, gainDb, outputProfileId, metrics, options = {}) {
  const requestedGainDb = gainDb

  if (gainDb <= 0) {
    return {
      applied:           false,
      requested_gain_db: requestedGainDb,
      skip_reason:       'air_boost_db <= 0',
    }
  }

  const isAcx = outputProfileId === 'acx'

  // Pre-check: if noise floor is already too close to the ACX ceiling, skip entirely.
  if (isAcx) {
    const noiseFloorPre = metrics.noiseFloorDbfs
    if (noiseFloorPre != null && noiseFloorPre >= ACX_PRE_CHECK_LIMIT) {
      return {
        applied:              false,
        requested_gain_db:    requestedGainDb,
        skip_reason:          'noise_floor_pre_check',
        noise_floor_pre_dbfs: noiseFloorPre,
      }
    }
  }

  // Predictive pre-cut. Computed once on the input; the cut filter and the
  // gain reduction are held constant inside the ACX post-check loop below.
  let precut    = null
  let precutErr = null
  if (options.presetId) {
    try {
      precut = await runPrecutAnalysis(
        inputPath,
        gainDb,
        options.presetId,
        options.precutConfig,
        metrics?.noiseFloorDbfs ?? null,
      )
    } catch (err) {
      precutErr = err.message
      precut    = { applied: false, reason: 'precut_script_error' }
    }
  }
  const precutAppliedFilter = precut?.applied
    ? `equalizer=f=${precut.center_hz}:width_type=q:w=${precut.q}:g=${precut.gain_db.toFixed(5)}`
    : null
  const gainReductionDb = precut?.applied ? (precut.gain_db_reduction ?? 0) : 0

  // Apply filter chain, with an ACX noise-floor compliance loop.
  let currentGain = gainDb - gainReductionDb
  if (currentGain <= 0) {
    return {
      applied:           false,
      requested_gain_db: requestedGainDb,
      skip_reason:       'precut_consumed_all_gain',
      ...buildPrecutDiagnostic(precut, precutErr),
    }
  }

  while (true) {
    const filters = buildFilters(currentGain)
    if (precutAppliedFilter) filters.unshift(precutAppliedFilter)
    await applyParametricEQ(inputPath, outputPath, filters)

    if (!isAcx) break  // non-ACX profiles skip the post-check entirely

    const reMeasured     = await remeasureFrames(outputPath, metrics)
    const noiseFloorPost = reMeasured.noiseFloorDbfs

    if (noiseFloorPost <= ACX_NOISE_FLOOR_CEILING) break  // compliance achieved

    currentGain -= REDUCTION_STEP_DB

    if (currentGain <= 0) {
      return {
        applied:           false,
        requested_gain_db: requestedGainDb,
        skip_reason:       'noise_floor_unresolvable',
        ...buildPrecutDiagnostic(precut, precutErr),
      }
    }
  }

  return {
    applied:                   true,
    requested_gain_db:         requestedGainDb,
    applied_gain_db:           round4(currentGain),
    gain_db_reduced_by_precut: round4(gainReductionDb),
    acx_constrained:           isAcx && currentGain < (requestedGainDb - gainReductionDb),
    model:                     'maag_eq4_approximation_v2',
    bands:                     bandsReport(currentGain),
    ...(precut?.applied && {
      pre_attenuation: {
        f_hz:    precut.center_hz,
        q:       precut.q,
        gain_db: precut.gain_db,
      },
    }),
    ...buildPrecutDiagnostic(precut, precutErr),
  }
}

/**
 * Reconstruct FFmpeg filter strings from a computeAirBoostParams result object.
 * Used by applyAirBoostBands so chunked workers don't re-run the compliance loop.
 */
function filtersFromBandsReport(bands, preAttenuation) {
  const filters = bands.map(band => {
    const g = band.gain_db.toFixed(5)
    if (band.type === 'bell') {
      return `equalizer=f=${band.f_hz}:width_type=q:w=${band.q}:g=${g}`
    } else {
      return `highshelf=f=${band.f_hz}:width_type=o:w=${band.width_oct}:g=${g}`
    }
  })
  if (preAttenuation) {
    filters.unshift(
      `equalizer=f=${preAttenuation.f_hz}:width_type=q:w=${preAttenuation.q}:g=${preAttenuation.gain_db.toFixed(5)}`
    )
  }
  return filters
}

/**
 * Apply a pre-computed Air Boost filter configuration to a single chunk.
 *
 * Used by airBoostApply in chunked mode when airBoostAnalyze has already
 * determined the final filter parameters on the full file. Performs one
 * FFmpeg pass with the pre-scaled band gains — no compliance loop.
 *
 * @param {string} inputPath   Source WAV chunk
 * @param {string} outputPath  Destination WAV chunk
 * @param {object} params      Result from computeAirBoostParams (.bands, optionally .pre_attenuation)
 */
export async function applyAirBoostBands(inputPath, outputPath, params) {
  if (!params.applied) {
    return applyParametricEQ(inputPath, outputPath, [])
  }
  const filters = filtersFromBandsReport(params.bands, params.pre_attenuation ?? null)
  return applyParametricEQ(inputPath, outputPath, filters)
}

/**
 * Blend the boosted WAV back toward the original on sibilant frames.
 *
 * The FFmpeg EQ filter is time-invariant — it boosts sibilants as much as any
 * other HF content.  This pass applies a smooth gain envelope derived from the
 * sibilance event map so that sibilant frames receive a reduced (or no) boost,
 * while non-sibilant frames retain the full air-boost effect.
 *
 * Envelope behaviour: fast attack (boost drops when sibilant starts), slower
 * release (boost recovers after the sibilant ends) — matching de-esser timing.
 *
 * output = original + (boosted − original) × gain_envelope
 *        = original × (1 − env) + boosted × env
 *
 * @param {string} originalPath     Pre-boost WAV (ctx.currentPath before airBoost ran)
 * @param {string} boostedPath      Post-FFmpeg-EQ WAV (output of computeAirBoostParams)
 * @param {string} eventsPath       Sibilance event map JSON (from analyzeSibilanceEvents)
 * @param {string} outputPath       Destination WAV for the blended result
 * @param {number} [sibilantGainFloor=0.0]  Boost fraction retained on sibilant frames
 *                                          (0.0 = no boost, 1.0 = full boost = no-op)
 * @param {number} [attackMs=5.0]   ms for boost to drop when a sibilant starts
 * @param {number} [releaseMs=20.0] ms for boost to recover after a sibilant ends
 * @param {number} [frameOffset=0]  STFT-frame shift applied to sibilant indices
 *                                  from the events JSON. Chunked-mode callers
 *                                  pass the chunk's carve-start expressed in
 *                                  STFT frames so whole-file indices resolve
 *                                  to chunk-local frames. Sequential callers
 *                                  leave this at 0.
 */
export async function applyAirBoostMask(
  originalPath,
  boostedPath,
  eventsPath,
  outputPath,
  sibilantGainFloor = 0.0,
  attackMs          = 5.0,
  releaseMs         = 20.0,
  frameOffset       = 0,
) {
  const args = [
    '--original',            originalPath,
    '--boosted',             boostedPath,
    '--events',              eventsPath,
    '--output',              outputPath,
    '--sibilant-gain-floor', String(sibilantGainFloor),
    '--attack-ms',           String(attackMs),
    '--release-ms',          String(releaseMs),
  ]
  if (frameOffset !== 0) {
    args.push('--frame-offset', String(frameOffset))
  }
  return spawnPython(MASK_SCRIPT, args, 'AirBoostMask')
}