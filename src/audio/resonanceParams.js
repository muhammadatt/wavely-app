/**
 * Resonance Suppressor parameters shared between the UI and the kernel.
 *
 * Separate from effects/resonance.js because that module imports the worklet
 * loader, whose `?worker&url` specifier only resolves under Vite — so anything
 * it touches is unreachable from `node --test`. The pitch-range clamp mirrored
 * here has to be testable against the kernel's own clamp, which is the whole
 * reason it exists.
 */

import { pitchFloorHz } from './dsp/f0.js'

/**
 * Matches FFT_SIZE in resonanceProcessor.js. Duplicated rather than imported so
 * the app bundle does not pull in the whole kernel — it is loaded as a worklet,
 * not as a module.
 */
export const RESONANCE_FRAME_SIZE = 2048

/**
 * Pitch search ranges for harmonic protection.
 *
 * The server's stage only ever ran on speech, so its range was a constant. This
 * effect is a general tool, and an out-of-range source does not degrade
 * gracefully: the tracker returns the best lag *within* the range, which for an
 * out-of-range pitch is an octave artefact reported with full confidence, and
 * the protection mask then lands on bins that are not harmonics.
 *
 * `wide` asks for 40 Hz, below what a 2048-sample frame can autocorrelate; the
 * kernel clamps it, and `effectivePitchRange` is how the UI finds out to what.
 */
export const PITCH_RANGES = {
  voice: { minHz: 70, maxHz: 400, label: 'VOICE', title: 'Speech and vocals (70–400 Hz)' },
  wide: { minHz: 40, maxHz: 1200, label: 'WIDE', title: 'Instruments and full-range material (40–1200 Hz)' },
}

/**
 * The pitch range actually used, after the kernel's clamp.
 *
 * The kernel clamps the requested range to what its frame can autocorrelate and
 * records the result on `kernel.pitchRange` — but that lives inside a worklet
 * and there is no channel back out for a value needed to render a label. So the
 * clamp is mirrored here, and a test pins the two together.
 */
export function effectivePitchRange(sampleRate, rangeKey) {
  const range = PITCH_RANGES[rangeKey] ?? PITCH_RANGES.voice
  const floor = pitchFloorHz(sampleRate, RESONANCE_FRAME_SIZE)
  return { minHz: Math.max(floor, range.minHz), maxHz: range.maxHz }
}
