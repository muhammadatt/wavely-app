/**
 * Per-frame F0 estimation via FFT autocorrelation.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Direct port of server/scripts/estimate_f0_contour.py (`_autocorr_f0_batch`):
 * zero-mean the frame, autocorrelate via |rfft|² → irfft at 2× length, take the
 * peak within the lag range implied by the search bounds, gate on
 * MIN_CORR_RATIO, then parabolically interpolate the peak.
 *
 * The Python hard-codes a speech range; here it is settable per consumer via
 * `setRange`, because these effects run on whatever the user loaded rather than
 * on a narrator. F0_MIN_HZ / F0_MAX_HZ remain the speech defaults.
 *
 * The Python runs this over a whole file at once; the algorithm itself is
 * strictly per-frame and causal, which is what makes realtime harmonic
 * protection possible in the resonance suppressor without an analyze pass.
 *
 * One thing the whole-file version has that a streaming tracker cannot: a
 * whole-file median, used to set the cepstral lifter cutoff. Substituted by a
 * rolling median over recent pitched frames, matching the deque pattern
 * sibilance_detector.py already uses for its band tracking.
 *
 * WHAT THIS IS NOT: a voice activity detector. The server pairs this estimator
 * with Silero VAD, and the two answer different questions — Silero says "is
 * someone speaking", this says "is there a periodic component in range". Every
 * fricative is the first without being the second. Substituting one for the
 * other silently narrows behaviour, which is a mistake this file has already
 * caused once (see the note on `pitched` in `estimate`).
 */

import { getFFT } from './fft.js'

export const F0_MIN_HZ = 70.0
export const F0_MAX_HZ = 400.0
export const MIN_CORR_RATIO = 0.1

/** Rolling-median window, matching sibilance_detector.py's F0_ROLLING_WINDOW_SIZE. */
export const DEFAULT_MEDIAN_WINDOW = 10

/**
 * Longest lag worth searching, as a fraction of the frame.
 *
 * Autocorrelation at lag L only has frameSize − L samples of overlap to work
 * with, so the estimate degrades as L approaches the frame length. Half the
 * frame is the conventional stopping point; past it the peak is being formed by
 * a handful of samples and the tracker starts inventing pitches. At 2048
 * samples / 44.1 kHz this puts the hard floor at 43.07 Hz.
 */
const MAX_LAG_FRACTION = 0.5

/** Lowest pitch this frame size can estimate at all. */
export function pitchFloorHz(sampleRate, frameSize) {
  return sampleRate / Math.floor(frameSize * MAX_LAG_FRACTION)
}

export class F0Tracker {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {number} [opts.frameSize=2048] must match the consumer's STFT n_fft
   * @param {number} [opts.medianWindow=10]
   * @param {number} [opts.defaultF0=null] seed used before the first voiced frame
   * @param {number} [opts.minHz=70] low end of the pitch search
   * @param {number} [opts.maxHz=400] high end of the pitch search
   */
  constructor({
    sampleRate,
    frameSize = 2048,
    medianWindow = DEFAULT_MEDIAN_WINDOW,
    defaultF0 = null,
    minHz = F0_MIN_HZ,
    maxHz = F0_MAX_HZ,
  }) {
    this.sampleRate = sampleRate
    this.frameSize = frameSize
    this.medianWindow = medianWindow
    this.defaultF0 = defaultF0

    // Autocorrelation runs at 2× the frame length, as in the Python.
    this.corrSize = 2 * frameSize
    this.fft = getFFT(this.corrSize)

    this.setRange(minHz, maxHz)

    const bins = (this.corrSize >>> 1) + 1
    this._re = new Float64Array(bins)
    this._im = new Float64Array(bins)
    this._centred = new Float64Array(frameSize)
    this._corr = new Float64Array(this.corrSize)

    this._history = []
    this._sorted = []
    this.lastF0 = null
  }

  /**
   * Set the pitch search range, clamped to what this frame size can resolve.
   *
   * The server only ever tracked speech, so the range was a constant. A
   * realtime effect is pointed at whatever the user loaded, and a source
   * outside the search range does not fail quietly — the peak picker returns
   * the best lag *within* the range, which for an out-of-range pitch is an
   * octave artefact reported with full confidence. Widening the range is the
   * only way to avoid that, and it is nearly free: the FFT is sized from the
   * frame, not the range, so this only moves the bounds of a linear scan.
   *
   * @returns {{ minHz: number, maxHz: number }} the clamped range actually used
   */
  setRange(minHz, maxHz) {
    const floor = pitchFloorHz(this.sampleRate, this.frameSize)
    const ceil = this.sampleRate / 2
    let lo = Math.max(floor, Math.min(minHz, ceil))
    let hi = Math.max(lo, Math.min(maxHz, ceil))
    // One lag apart at minimum, or the scan below has nothing to look at.
    if (Math.floor(this.sampleRate / lo) <= Math.floor(this.sampleRate / hi)) {
      hi = this.sampleRate / Math.max(1, Math.floor(this.sampleRate / lo) - 1)
    }
    this.minHz = lo
    this.maxHz = hi
    this.lagMin = Math.floor(this.sampleRate / hi)
    this.lagMax = Math.floor(this.sampleRate / lo)
    return { minHz: lo, maxHz: hi }
  }

  reset() {
    this._history.length = 0
    this.lastF0 = null
  }

  /**
   * Estimate F0 for one frame.
   *
   * @param {ArrayLike<number>} frame length === frameSize, unwindowed
   * @param {boolean} [energyGate=true] caller's activity gate (e.g. above a noise floor)
   * @returns {{ f0: number|null, pitched: boolean, ratio: number }}
   *
   * `pitched` means a periodic component was found in range — NOT that the
   * frame contains speech. The distinction matters: Silero, which this stands
   * in for on the server, labels fricatives and breaths as speech while this
   * returns false for them. Callers that gate audible behaviour on speech
   * presence must not use this flag for it.
   */
  estimate(frame, energyGate = true) {
    const n = this.frameSize
    if (n < 64 || this.lagMax >= n || this.lagMin >= this.lagMax) {
      return { f0: null, pitched: false, ratio: 0 }
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
    const pitched = peakLag > 0 && peak > MIN_CORR_RATIO * corr0 && energyGate
    if (!pitched) {
      return { f0: null, pitched: false, ratio }
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

    return { f0, pitched: true, ratio }
  }

  /**
   * Rolling median of recent pitched estimates, or the seed default before any
   * pitched frame has been seen. Drives the cepstral lifter cutoff.
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
