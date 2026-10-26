/**
 * Voice separation spawners.
 *
 * runSeparation — Demucs / ConvTasNet vocal source extraction (Stage NE-3)
 *
 * Environment:
 *   SEPARATION_PYTHON  — Python executable (default: python3)
 *   SEPARATION_DEVICE  — Compute device (default: auto)
 */

import { fileURLToPath } from 'url'
import path from 'path'
import { spawnPython, DEVICE } from './spawnPython.js'

const SCRIPTS_DIR     = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts')
const SEPARATE_SCRIPT = path.join(SCRIPTS_DIR, 'separate_vocals.py')

/**
 * Stage NE-3: Vocal source separation.
 *
 * @param {string} inputPath   - 32-bit float WAV at 44.1 kHz (mono or stereo)
 * @param {string} outputPath  - 32-bit float WAV at 44.1 kHz (vocals stem only)
 * @param {'demucs'|'convtasnet'} model - Separation backend
 */
export function runSeparation(inputPath, outputPath, model = 'demucs') {
  return spawnPython(
    SEPARATE_SCRIPT,
    ['--input', inputPath, '--output', outputPath, '--model', model, '--device', DEVICE],
    `Separation (${model})`,
  )
}
