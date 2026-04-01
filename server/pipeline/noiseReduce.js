/**
 * Stage 2 — Noise Reduction (STUB).
 *
 * DeepFilterNet3 integration is planned for a future sprint.
 * This module acts as a pass-through: it copies the input file
 * to the output path unchanged and logs the skip.
 *
 * When implemented, this will:
 * - Analyze noise floor and classify noise character
 * - Select adaptive tier (1-5) based on measured noise floor
 * - Apply DeepFilterNet3 via Python subprocess or libdf Rust bindings
 * - Validate post-reduction artifact levels
 */

import { copyFile } from 'fs/promises'

/**
 * @param {string} inputPath - Path to input WAV (32-bit float, 44.1kHz)
 * @param {string} outputPath - Path to write output WAV
 * @param {object} options
 * @param {number} options.ceilingTier - Max NR tier allowed by preset (3 or 4)
 * @param {number} options.noiseFloorDbfs - Measured noise floor
 * @returns {object} Processing metadata for the report
 */
export async function applyNoiseReduction(inputPath, outputPath, { ceilingTier, noiseFloorDbfs }) {
  // STUB: pass-through — copy input to output unchanged
  await copyFile(inputPath, outputPath)

  console.log(
    `[NR STUB] Noise reduction skipped (DeepFilterNet3 not yet integrated). ` +
    `Noise floor: ${noiseFloorDbfs} dBFS, ceiling tier: ${ceilingTier}`
  )

  return {
    applied: false,
    tier: null,
    model: null,
    pre_noise_floor_dbfs: noiseFloorDbfs,
    post_noise_floor_dbfs: noiseFloorDbfs,
    message: 'Noise reduction not available — DeepFilterNet3 integration pending',
  }
}
