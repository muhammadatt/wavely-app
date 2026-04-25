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
 * Reference plateau (REFERENCE_PLATEAU_DB): the net shelf boost measured
 * directly from the Audio Precision plot data published in Sound On Sound
 * (October 2016) — plateau mean (29k–37k Hz) minus baseline mean (20–210 Hz):
 * 16.3972 dBu − 3.8039 dBu = 12.5932 dB. This is the gain value at which
 * the band gRef parameters were fitted. All gains scale linearly from this
 * reference by the factor (air_boost_db / REFERENCE_PLATEAU_DB).
 *
 * Fit quality: RMS error 0.063 dB against sigmoid model (500 Hz – 25 kHz).
 * Scaling verification at 18 dB requested against Maag AP data (17 dB setting,
 * baseline-corrected, scaled to 18 dB):
 *   1870 Hz:  Maag +4.43 dB  →  model +4.33 dB  (delta −0.10 dB)
 *   5556 Hz:  Maag +12.36 dB →  model +12.22 dB (delta −0.14 dB)
 *  13610 Hz:  Maag +16.95 dB →  model +16.32 dB (delta −0.63 dB)
 *
 * model: maag_eq4_approximation_v1_unverified
 *
 * ACX output profile: a pre/post noise floor check constrains the applied
 * gain to keep the noise floor below the -60 dBFS ACX ceiling.
 */

import { applyParametricEQ } from '../lib/ffmpeg.js'
import { remeasureFrames }    from './frameAnalysis.js'

const ACX_NOISE_FLOOR_CEILING = -60   // dBFS — ACX hard ceiling
const ACX_PRE_CHECK_LIMIT     = -61   // dBFS — skip if already this close before boost
const REDUCTION_STEP_DB       = 0.25  // dB per iteration of the ACX reduction loop

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
//   - Low-frequency lift below 300 Hz is < 0.19 dB at reference plateau
//     (< 0.03 dB at typical operating gains of 1.5–2.5 dB).
//   - The -0.32 dB gRef at 1200 Hz is a small corrective cut that the
//     optimiser uses to cancel a slight low-end excess from the 600 Hz band.
//     At G=2.0 dB this cut is −0.05 dB — inaudible and harmless.

const REFERENCE_PLATEAU_DB = 12.5932

const BANDS = [
  // Parametric peaking bands (bells), Q = 0.5
  { freqHz:   600, type: 'bell',  q: 0.5,   gRef:  +0.19570 },
  { freqHz:  1200, type: 'bell',  q: 0.5,   gRef:  -0.32018 },
  { freqHz:  2400, type: 'bell',  q: 0.5,   gRef:  +1.20294 },
  { freqHz:  4800, type: 'bell',  q: 0.5,   gRef:  +2.05333 },
  { freqHz:  9600, type: 'bell',  q: 0.5,   gRef:  +3.46946 },
  // High shelf — handles the plateau without upper-frequency rolloff
  // width_type=o (octaves), w=3.023 oct corresponds to Q=0.4
  { freqHz: 14000, type: 'shelf', wOct: 3.023, gRef: +15.08686 },
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
 * Apply the Air Boost filter chain to inputPath, writing the result to outputPath.
 *
 * @param {string} inputPath        Source WAV (float32, 44.1 kHz)
 * @param {string} outputPath       Destination path (pre-allocated by caller via ctx.tmp)
 * @param {number} gainDb           Requested boost from preset.airBoost.gainDb
 * @param {string} outputProfileId  'acx' | 'podcast' | 'broadcast'
 * @param {object} metrics          ctx.results.metrics — must contain frames[] for remeasure
 * @returns {object}                Result object written to ctx.results.airBoost
 */
export async function applyAirBoost(inputPath, outputPath, gainDb, outputProfileId, metrics) {
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

  // Apply filter chain, with an ACX noise-floor compliance loop.
  let currentGain = gainDb

  while (true) {
    const filters = buildFilters(currentGain)
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
      }
    }
  }

  return {
    applied:           true,
    requested_gain_db: requestedGainDb,
    applied_gain_db:   round4(currentGain),
    acx_constrained:   isAcx && currentGain < requestedGainDb,
    model:             'maag_eq4_approximation_v1_unverified',
    bands:             bandsReport(currentGain),
  }
}