/**
 * Stage 3b — Air Boost
 *
 * Adds a wide, gradual high-frequency lift modeled on the Maag EQ4 Air Band
 * at the 10 kHz corner setting. Three cascaded high-shelf filters with
 * staggered corner frequencies reproduce the ~4-octave transition width of
 * the measured Maag EQ4 curve.
 *
 * Filter parameters derived from Audio Precision measurements published in
 * Sound On Sound (October 2016), extracted via WebPlotDigitizer.
 * model: maag_eq4_approximation_v1_unverified
 *
 * ACX output profile: a pre/post noise floor check constrains the applied
 * gain to keep the noise floor below the -60 dBFS ACX ceiling.
 */

import { applyParametricEQ } from '../lib/ffmpeg.js'
import { remeasureFrames }    from './frameAnalysis.js'

const ACX_NOISE_FLOOR_CEILING = -60  // dBFS — ACX hard ceiling
const ACX_PRE_CHECK_LIMIT     = -61  // dBFS — skip if already this close before boost
const REDUCTION_STEP_DB       = 0.25 // dB per iteration of the ACX reduction loop

// Three-shelf model. Ratios sum to 1.0 and are applied to the scalar air_boost_db.
const SHELVES = [
  { ratio: 0.275, freqHz: 1800,  widthOct: 4.0 },
  { ratio: 0.375, freqHz: 5000,  widthOct: 3.5 },
  { ratio: 0.350, freqHz: 14000, widthOct: 3.0 },
]

function buildFilters(gainDb) {
  return SHELVES.map(({ ratio, freqHz, widthOct }) => {
    const g = gainDb * ratio
    return `equalizer=f=${freqHz}:t=h:width_type=o:w=${widthOct}:g=${g.toFixed(4)}`
  })
}

function shelvesReport(gainDb) {
  return SHELVES.map(({ ratio, freqHz, widthOct }) => ({
    f_hz:      freqHz,
    width_oct: widthOct,
    gain_db:   round4(gainDb * ratio),
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

    const reMeasured    = await remeasureFrames(outputPath, metrics)
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
    shelves:           shelvesReport(currentGain),
  }
}
