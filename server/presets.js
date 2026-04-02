/**
 * Server-side preset and compliance configuration.
 *
 * Re-exports from the shared client definitions (src/audio/presets.js).
 * If ES module import from src/ causes issues in the future,
 * extract shared config to a shared/ directory.
 */

export {
  PRESETS,
  COMPLIANCE_TARGETS,
  getDefaultCompliance,
  isComplianceLocked,
} from '../src/audio/presets.js'
