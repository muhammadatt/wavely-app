/**
 * Per-frame F0 estimation via FFT autocorrelation.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Direct port of server/scripts/estimate_f0_contour.py (`_autocorr_f0_batch`):
 * zero-mean the frame, autocorrelate via |rfft|² → irfft at 2× length, take the
 * peak within the lag range implied by [F0_MIN_HZ, F0_MAX_HZ], gate on
 * MIN_CORR_RATIO, then parabolically interpolate the peak.
 *
 * The Python runs this over a whole file at once; the algorithm itself is
 * strictly per-frame and causal, which is what makes realtime harmonic
 * protection possible in the resonance suppressor without an analyze pass.
 *
 * Two things the whole-file version has that a streaming tracker cannot:
 *   - a Silero voicing mask. Substituted here by the correlation ratio the
 *     estimator already computes, optionally combined with a caller-supplied
 *     energy gate.
 *   - a whole-file median, used to set the cepstral lifter cutoff. Substituted
 *     by a rolling median over recent voiced frames, matching the deque pattern
 *     sibilance_detector.py already uses for its band tracking.
 */

import { getFFT } from './fft.js'

export const F0_MIN_HZ = 70.0
export const F0_MAX_HZ = 400.0
export const MIN_CORR_RATIO = 0.1

/** Rolling-median window, matching sibilance_detector.py's F0_ROLLING_WINDOW_SIZE. */
export const DEFAULT_MEDIAN_WINDOW = 10

export class F0Tracker {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {number} [opts.frameSize=2048] must match the consumer's STFT n_fft
   * @param {number} [opts.medianWindow=10]
   * @param {number} [opts.defaultF0=null] seed used before the first voiced frame
   */
  constructor({
    sampleRate,
    frameSize = 2048,
    medianWindow = DEFAULT_MEDIAN_WINDOW,
    defaultF0 = null,
  }) {
    this.sampleRate = sampleRate
    this.frameSize = frameSize
    this.medianWindow = medianWindow
    this.defaultF0 = defaultF0

    // Autocorrelation runs at 2× the frame length, as in the Python.
    this.corrSize = 2 * frameSize
    this.fft = getFFT(this.corrSize)

    this.lagMin = Math.floor(sampleRate / F0_MAX_HZ)
    this.lagMax = Math.floor(sampleRate / F0_MIN_HZ)

    const bins = (this.corrSize >>> 1) + 1
    this._re = new Float64Array(bins)
    this._im = new Float64Array(bins)
    this._centred = new Float64Array(frameSize)
    this._corr = new Float64Array(this.corrSize)

    this._history = []
    this._sorted = []
    this.lastF0 = null
  }

  reset() {
    this._history.length = 0
    this.lastF0 = null
  }

  /**
   * Estimate F0 for one frame.
   *
   * @param {ArrayLike<number>} frame length === frameSize, unwindowed
   * @param {boolean} [energyGate=true] caller's voicing gate (e.g. above noise floor)
   * @returns {{ f0: number|null, voiced: boolean, ratio: number }}
   */
  estimate(frame, energyGate = true) {
    const n = this.frameSize
    if (n < 64 || this.lagMax >= n || this.lagMin >= this.lagMax) {
      return { f0: null, voiced: false, ratio: 0 }
    }

    // Zero-mean, matching `f64 - f64.mean(axis=1)`.
    let mean = 0
    for (let i = 0; i < n; i++) mean += frame[i]
    mean /= n
    const centred = this._centred
    for (let i = 0; i < n; i++) centred[i] = frame[i] - mean

    // Autocorrelation via the Wiener-Khinchin route: irfft(|rfft(x)|²).
    this.fft.rfft(centred, this._re, this._im)
    const bins = (this.corrSize >>> 1) + 1
    for (let k = 0; k < bins; k++) {
      const re = this._re[k]
      const im = this._im[k]
      this._re[k] = re * re + im * im
      this._im[k] = 0
    }
    this.fft.irfft(this._re, null, this._corr)

    const corr = this._corr
    const corr0 = corr[0]

    let peak = -Infinity
    let peakLag = -1
    for (let lag = this.lagMin; lag < this.lagMax; lag++) {
      if (corr[lag] > peak) {
        peak = corr[lag]
        peakLag = lag
      }
    }

    const ratio = corr0 > 0 ? peak / corr0 : 0
    const voiced = peakLag > 0 && peak > MIN_CORR_RATIO * corr0 && energyGate
    if (!voiced) {
      return { f0: null, voiced: false, ratio }
    }

    // Parabolic interpolation around the peak, guarded exactly as the Python is.
    let f0 = this.sampleRate / peakLag
    if (peakLag > 0 && peakLag < n - 1) {
      const y0 = corr[peakLag - 1]
      const y1 = corr[peakLag]
      const y2 = corr[peakLag + 1]
      const denom = y0 - 2 * y1 + y2
      if (denom !== 0) {
        const delta = (0.5 * (y0 - y2)) / denom
        f0 = this.sampleRate / (peakLag + delta)
      }
    }

    this.lastF0 = f0
    this._history.push(f0)
    if (this._history.length > this.medianWindow) this._history.shift()

    return { f0, voiced: true, ratio }
  }

  /**
   * Rolling median of recent voiced estimates, or the seed default before any
   * voiced frame has been seen. Drives the cepstral lifter cutoff.
   */
  get median() {
    const h = this._history
    if (h.length === 0) return this.defaultF0
    const s = this._sorted
    s.length = h.length
    for (let i = 0; i < h.length; i++) s[i] = h[i]
    s.sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid])
  }
}
