/**
 * Registers every plugin's preset collection.
 *
 * Import this once, for the side effect. The store is a registry, and a
 * definition that is only registered when its panel first opens would make
 * `listPresets` answer differently depending on which windows the user had
 * already visited.
 */
import './optoSmooth.js'
import './fetPunch.js'
import './resoTame.js'

import { registerOptoSmoothPresets } from './optoSmooth.js'
import { registerFetPunchPresets } from './fetPunch.js'
import { registerResoTamePresets } from './resoTame.js'

export { OPTO_SMOOTH_PRESET_PLUGIN, registerOptoSmoothPresets } from './optoSmooth.js'
export { FET_PUNCH_PRESET_PLUGIN, registerFetPunchPresets } from './fetPunch.js'
export {
  RESO_TAME_PRESET_PLUGIN, registerResoTamePresets, RESO_TAME_STOCK_ZONES,
} from './resoTame.js'
export * from './store.js'

/**
 * Put every shipping collection back after `resetPluginPresets()`.
 *
 * Only tests need this — the import above already did it once. Idempotent, so
 * calling it a second time replaces the definitions rather than doubling them.
 */
export function registerPluginPresets() {
  registerOptoSmoothPresets()
  registerFetPunchPresets()
  registerResoTamePresets()
}
