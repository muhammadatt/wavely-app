/**
 * Hum detection worker.
 *
 * The analysis is a single 2^19-point FFT — a few hundred milliseconds of
 * straight-line arithmetic. Running it on the main thread would drop frames
 * and freeze the knobs mid-drag, so it lives here.
 *
 * Message in:  { samples: Float32Array (mono, transferred), sampleRate, options }
 * Message out: { type: 'done', result } | { type: 'error', message }
 */

import { detectHum } from '../audio/dsp/humDetect.js'

self.onmessage = (e) => {
  const { samples, sampleRate, options } = e.data
  try {
    const result = detectHum(samples, sampleRate, options)
    self.postMessage({ type: 'done', result })
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) })
  }
}
