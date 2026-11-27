/**
 * Noise-profile learning for Spectral Denoise (dsp/spectralDenoise.js).
 *
 * One rfft per chosen frame over up to ten minutes of audio — a second or two
 * of arithmetic, kept off the main thread so the knobs stay responsive.
 *
 * Message in:  { samples: Float32Array (mono, transferred), options }
 * Message out: { type: 'done', result } | { type: 'error', message }
 *              (result.profile is transferred back)
 */

import { learnNoiseProfile } from '../audio/dsp/spectralDenoise.js'

self.onmessage = (e) => {
  const { samples, options } = e.data
  try {
    const result = learnNoiseProfile(samples, options)
    self.postMessage({ type: 'done', result }, result.profile ? [result.profile.buffer] : [])
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) })
  }
}
