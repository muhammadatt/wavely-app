/**
 * Server-side preset and output profile configuration.
 *
 * Re-exports from the shared client definitions (src/audio/presets.js).
 * If ES module import from src/ causes issues in the future,
 * extract shared config to a shared/ directory.
 */

export {
  PRESETS,
  OUTPUT_PROFILES,
  resolveOutputProfileId,
  getDefaultOutputProfile,
  isOutputProfileLocked,
} from '../src/audio/presets.js'
