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

/**
 * Geometry of the per-frequency display the panel draws.
 *
 * Lives here rather than in the kernel for the same reason the pitch clamp
 * does: the kernel is loaded as a worklet, and the UI needs these numbers on
 * the main thread to lay out an axis. The kernel imports them from here, so the
 * grid the worklet fills and the axis the panel draws are the same grid.
 *
 * 192 points over 20 Hz–20 kHz is ~0.05 octave each — finer than the ear
 * resolves and finer than the 2048-point FFT can actually distinguish above a
 * few kHz, which is the right way round: the display never has to invent a
 * feature the analysis did not see. Below ~400 Hz the reverse holds and several
 * display points share one FFT bin; the kernel interpolates there rather than
 * drawing a staircase, and the result is smooth but genuinely no more resolved
 * than 21.5 Hz.
 */
export const RESONANCE_DISPLAY_BINS = 192
export const RESONANCE_DISPLAY_MIN_HZ = 20
export const RESONANCE_DISPLAY_MAX_HZ = 20000

/**
 * The span actually displayed at a given sample rate.
 *
 * Clamped to just under Nyquist: the top display point maps to an FFT bin, and
 * asking for one at exactly Nyquist lands on the last bin of the rfft, whose
 * magnitude is real-only and reads low. A hair below keeps the axis honest.
 */
export function resonanceDisplayRange(sampleRate) {
  return {
    minHz: RESONANCE_DISPLAY_MIN_HZ,
    maxHz: Math.min(RESONANCE_DISPLAY_MAX_HZ, sampleRate * 0.5 * 0.98),
  }
}
