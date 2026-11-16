import { SR, renderAligned } from './shared.mjs'
import { processResonanceBuffer } from '../../src/audio/resonanceProcessor.js'
import {
  RESONANCE_DEFAULTS, RESONANCE_FRAME_SIZE, toKernelParams, withRefModeDefaults,
} from '../../src/audio/resonanceParams.js'
import { DEFAULT_RESONANCE_FOCUS, copyFocus } from '../../src/audio/resonanceFocus.js'
import { DEFAULT_TARGETING } from '../../src/audio/resonanceTargeting.js'

/**
 * useResonance.renderRegion → applyResonanceRegion (src/audio/processing.js).
 *
 * Reso Soothe's apply measures nothing: its reference envelope is computed by
 * the kernel itself, and zone fitting (fitZonesToVoice) is a manual button on
 * the zone model, never part of Apply. So this is the panel's params
 * (useResonance.currentParams under the shipping FOCUS targeting, the shipping
 * reference mode) through the kernel, its STFT latency (one frame) rendered
 * long and trimmed. No pre-roll, deliberately, as applyResonanceRegion.
 */
export default function render(channels, settings) {
  const defaults = withRefModeDefaults(RESONANCE_DEFAULTS)
  const focusModel = DEFAULT_TARGETING === 'focus'
  const panel = {
    attack: defaults.attack,
    release: defaults.release,
    mix: defaults.mix,
    trim: defaults.trim,
    zones: defaults.zones ?? [],
    focus: focusModel ? copyFocus(DEFAULT_RESONANCE_FOCUS) : null,
    refMode: defaults.refMode ?? RESONANCE_DEFAULTS.refMode,
    mode: defaults.mode,
    ...settings,
  }
  const kp = toKernelParams({ ...RESONANCE_DEFAULTS, ...panel })
  const latency = RESONANCE_FRAME_SIZE
  const out = renderAligned(channels, latency, ch => processResonanceBuffer(ch, SR, kp).channelData)
  return { channels: out, note: `${panel.focus ? 'focus' : 'zones'}, ${panel.refMode} reference` }
}
