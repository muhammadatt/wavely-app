/**
 * OptoSmooth (LA-2A) factory presets.
 *
 * ⚠ EVERY PEAK REDUCTION FIGURE HERE IS AGAINST THE FITTED TAPER. That law
 * reaches 27 dB of gain reduction across its travel where the one it replaced
 * topped out at 13, so a Peak Reduction number recorded before the fit means
 * roughly half of what the same number means now. Nothing here predates it.
 *
 * The two controls that decide a preset's character:
 *
 *   PEAK REDUCTION is side-chain drive into a fixed internal threshold. With a
 *   flat side-chain, 62 gives about 11.6 dB of gain reduction on speech at
 *   nominal level.
 *
 *   R37 is knob ROTATION, and 100 is fully clockwise, flat, factory. Winding
 *   it DOWN attenuates the side-chain below 1 kHz by up to 10 dB, so the cell
 *   stops ducking on plosives and rides the presence band instead. A preset
 *   that lowers it is compressing LESS at the same Peak Reduction, which is
 *   why the two move together below.
 *
 * AUTO MAKEUP IS PART OF THE PRESET, and it has to be. The gain a preset
 * states is only what the plugin plays if AUTO is off — with AUTO on the
 * plugin owns that knob and re-measures it from the selection. Both are
 * legitimate; what is not legitimate is a preset that states a gain and has it
 * silently overwritten with nothing saying so. Where AUTO is on, the stated
 * gain is the value the knob holds until the first measurement lands.
 */

import { definePluginPresets } from './store.js'

/**
 * ⚠ THIS MODULE DELIBERATELY IMPORTS NOTHING FROM `effects/la2aCompressor.js`.
 * That module pulls in the worklet loader, whose `?worker&url` specifier only
 * resolves under Vite — so anything touching it is unreachable from
 * `node --test`, and a preset collection nothing can test is how a dead
 * control ships. Same reason `softClipperParams.js` exists. Nothing is lost:
 * a factory preset states every param, so there is no default to inherit, and
 * the fallbacks below are only for a stored preset with a key missing.
 */

export const OPTO_SMOOTH_PRESET_PLUGIN = 'opto-smooth'

const GAIN_MIN_DB = -12
const GAIN_MAX_DB = 24

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * The panel's own clamps, applied to anything arriving from storage.
 *
 * ⚠ IT ALSO CANONICALISES THE GAIN TO 0 WHILE AUTO IS ON, and that is what
 * stops every preset reading as MODIFIED a moment after it is chosen. With
 * AUTO on the plugin owns the Gain knob and writes a measured value into it
 * from the selection, so a preset stating a gain would disagree with the knob
 * within one measurement — through no edit by the user. The gain is not part
 * of the preset in that state, so it is not part of the comparison either.
 * Turning AUTO off makes it part of both again.
 */
function normalize(params) {
  const autoMakeup = params.autoMakeup !== false
  return {
    mode: params.mode === 'limit' ? 'limit' : 'compress',
    peakReduction: clamp(params.peakReduction ?? 50, 0, 100),
    gain: autoMakeup ? 0 : clamp(params.gain ?? 0, GAIN_MIN_DB, GAIN_MAX_DB),
    r37: clamp(params.r37 ?? 100, 0, 100),
    autoMakeup,
  }
}

export const OPTO_SMOOTH_PARAM_KEYS = [
  'mode', 'peakReduction', 'gain', 'r37', 'autoMakeup',
]

export const OPTO_SMOOTH_PRESETS = [
  {
    id: 'factory:narration-level',
    name: 'Narration Level',
    description: 'Gentle phrase levelling, flat side-chain. The starting point.',
    params: {
      mode: 'compress',
      peakReduction: 45,
      gain: 0,
      r37: 100,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:audiobook-glue',
    name: 'Audiobook Glue',
    description: 'Steadier still, with a little LF taken out of the detector.',
    params: {
      mode: 'compress',
      // Deeper than Narration Level, and R37 wound back a touch so the extra
      // depth is spent on the body of the phrase rather than on plosives.
      peakReduction: 60,
      gain: 0,
      r37: 82,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:plosive-rider',
    name: 'Plosive Rider',
    description: 'Side-chain filtered hard — the cell rides presence, not thump.',
    params: {
      mode: 'compress',
      // R37 at 45 takes most of the available 10 dB out of the side-chain
      // below 1 kHz, so a close-mic'd narrator's plosives stop setting the
      // gain reduction for the whole phrase. The Peak Reduction is higher than
      // it looks because the cell is being fed less.
      peakReduction: 62,
      gain: 0,
      r37: 45,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:podcast-density',
    name: 'Podcast Density',
    description: 'Loud and forward, with the tube stage working.',
    params: {
      mode: 'compress',
      peakReduction: 75,
      gain: 0,
      // The one preset that asks for audible tube colour. OptoSmooth's own
      // measurement says it steadies rather than thickens on fast material —
      // this is the setting for a voice that is already fairly even.
      r37: 100,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:safety-limit',
    name: 'Safety Limit',
    description: 'LIMIT mode, shallow — a ceiling, not a leveller.',
    params: {
      mode: 'limit',
      // Shallow on purpose. LIMIT is a hard ceiling, and auto makeup can ask
      // for more than the +24 dB Gain knob has at deep LIMIT settings — it
      // clamps and undershoots rather than overshooting, but a preset should
      // not sit where that is the normal case.
      peakReduction: 40,
      gain: 0,
      r37: 100,
      autoMakeup: true,
    },
  },
]

/**
 * Registration is a named function AND is called on import.
 *
 * Called on import because the registry has to answer the same way whatever
 * order the user opened windows in. Named because the store is a module-level
 * registry and a test that resets it needs a way to put the shipping
 * collection back — without one, the first test to reset would silently
 * un-register this plugin for every test after it.
 */
export function registerOptoSmoothPresets() {
  return definePluginPresets({
    pluginId: OPTO_SMOOTH_PRESET_PLUGIN,
    paramKeys: OPTO_SMOOTH_PARAM_KEYS,
    factory: OPTO_SMOOTH_PRESETS,
    normalize,
  })
}

registerOptoSmoothPresets()
