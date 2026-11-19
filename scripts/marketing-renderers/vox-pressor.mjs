import { SR } from './shared.mjs'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import { processVoxPressorBuffer } from '../../src/audio/voxPressorProcessor.js'
import { measureVoxPressor } from '../../src/audio/voxPressorSolve.js'
import { measureVoiceProfile } from '../../src/audio/voiceProfile.js'
import { voiceProfileExcerpt } from '../../src/audio/analysisWindow.js'
import { VOX_DEFAULTS, VOX_MEASURED_KEYS, toKernelParams as voxKernelParams } from '../../src/audio/effects/voxPressorParams.js'

/**
 * useVoxPressor.prepareApply (alignment, the voice profile, measureVoxPressor)
 * → applyVoxPressorRegion. The profile is measured as the panel does it — once
 * per file, on the spread excerpt (`voiceProfileExcerpt`) — and handed in:
 * left at VOX_DEFAULTS' null the render had no voice corner on the detectors
 * and SPEED AUTO ran at NORMAL rather than the voice's own release.
 */
export default function render(channels, settings) {
  const alignDb = inputAlignDbFor(channels, SR)
  const profile = measureVoiceProfile(voiceProfileExcerpt(channels, SR), SR)
  const panel = {
    ...VOX_DEFAULTS, ...settings, alignDb, listen: 'off',
    cornerHz: profile?.cornerHz ?? null, voiceF0Hz: profile?.medianF0Hz ?? null,
  }
  const measured = measureVoxPressor(channels, SR, voxKernelParams(panel))
  const solved = { ...panel }
  for (const k of VOX_MEASURED_KEYS) solved[k] = measured[k] ?? null
  const kp = voxKernelParams(solved)
  const out = processVoxPressorBuffer(channels, SR, kp, { compensate: true }).channelData
  return { channels: out, note: `align ${alignDb.toFixed(2)} dB, peaks ${(measured.peaksDb ?? 0).toFixed(1)} dB, body ${(measured.bodyDb ?? 0).toFixed(1)} dB` }
}
