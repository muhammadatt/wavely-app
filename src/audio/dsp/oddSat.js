/**
 * Odd-order saturator — the EL7 Fatso's Input stage, ahead of the HF Limiter.
 *
 * WHAT IT IS FOR. Measured on the Fatso (docs/claude-dev-log.md, "EL7 Fatso —
 * harmonic generation across Input and Warmth"): the harmonics come from INPUT
 * drive, not from Warmth, and they are ODD-dominant — at Input 6, odd-order
 * content −25 to −30 dB re output (≈3–5 %) with even 14–18 dB below it, growing
 * ≈2 dB per dB of level (third order). Warmth adds no convincing harmonics; it is
 * the dynamic shelf, which the HF Limiter already has as WARM.
 *
 *   u = G·x                    G follows the file's voice level (Drive is relative)
 *   f(u) = tanh(k₊u)/k₊, u ≥ 0     k± = 1 ± ASYMMETRY
 *          tanh(k₋u)/k₋, u < 0
 *   y = x + DC-block( f(G·x)/G − x )
 *
 * - SYMMETRIC TANH IS THE ODD PART. Its first deviation from a straight line is
 *   −u³/3, so at the levels where it starts to act it is third order, which is
 *   what the Fatso's level law reads.
 * - THE EVEN PART IS AN ASYMMETRY BETWEEN THE HALVES, not an added x² term, and
 *   that is the safety argument: each half is tanh(k·u)/k, whose magnitude never
 *   exceeds |u|, so the curve can NEVER make a sample larger — an added x² term
 *   would have pushed one half past the input at every level. The cost is a DC
 *   offset in the correction, which a 5 Hz blocker removes.
 * - UNITY SMALL-SIGNAL GAIN (f′(0) = 1, then ÷G): quiet material comes out at
 *   its own level and only the peaks are rounded, as the Fatso's Input 6 render
 *   did (same RMS as its source, peak 2.5 dB lower).
 *
 * It makes real harmonics, so it runs 4x oversampled — but only the CORRECTION
 * f(u)/G − x is resampled; the dry path is a whole-sample delay. With Drive at 0
 * the stage is that delay alone, so turning it on never moves the plugin's
 * latency and Drive 0 is bit-transparent.
 */

import { Oversampler, DelayLine, COMPRESSOR_OVERSAMPLE } from './oversample.js'

export const SAT_OVERSAMPLE = COMPRESSOR_OVERSAMPLE
export const SAT_LATENCY_SAMPLES = SAT_OVERSAMPLE.latencySamples

/**
 * Curvature difference between the halves. Calibrated on a sine: even sits
 * 15.0–16.6 dB under odd wherever the third harmonic is −43 to −24 dBc (the
 * Fatso measured 14–18), and both grow at the same third-order rate, so the
 * ratio holds across levels.
 */
export const SAT_ASYMMETRY = 0.045

/** DC blocker corner on the correction, Hz. */
const DC_HZ = 5

/** The transfer curve at unit drive: magnitude never exceeds |u|. */
export function oddSatCurve(u, asym = SAT_ASYMMETRY) {
  const k = u >= 0 ? 1 + asym : 1 - asym
  return Math.tanh(k * u) / k
}

export class OddSaturatorStage {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.latencySamples = SAT_LATENCY_SAMPLES
    this.channels = 0
    this.os = []
    this.dry = []
    this.dcX1 = []
    this.dcY1 = []
    this.corr = new Float32Array(128)
    this.dcA = Math.exp((-2 * Math.PI * DC_HZ) / sampleRate)
    this.enabled = false
    this.gain = 1
  }

  /** `driveLin` is the pre-gain G; `enabled: false` leaves a pure delay. */
  setParams({ driveLin = 1, enabled = false }) {
    if (enabled && !this.enabled) {
      // Coming back in: start from rest, not from whatever was left behind.
      for (let ch = 0; ch < this.channels; ch++) {
        this.os[ch].reset()
        this.dcX1[ch] = 0
        this.dcY1[ch] = 0
      }
    }
    this.enabled = enabled
    this.gain = driveLin
  }

  ensureChannels(n) {
    for (let ch = this.channels; ch < n; ch++) {
      this.os.push(new Oversampler(SAT_OVERSAMPLE))
      this.dry.push(new DelayLine(this.latencySamples))
      this.dcX1.push(0)
      this.dcY1.push(0)
    }
    if (n > this.channels) this.channels = n
  }

  /** In place over `n` samples of every channel in `bufs`. */
  process(bufs, n) {
    this.ensureChannels(bufs.length)
    if (!this.enabled) {
      for (let ch = 0; ch < bufs.length; ch++) {
        const buf = bufs[ch], dry = this.dry[ch]
        for (let i = 0; i < n; i++) buf[i] = dry.push(buf[i])
      }
      return
    }
    if (this.corr.length < n) this.corr = new Float32Array(n)
    const G = this.gain, invG = 1 / G, a = this.dcA
    const len = n * SAT_OVERSAMPLE.factor
    for (let ch = 0; ch < bufs.length; ch++) {
      const buf = bufs[ch]
      const hi = this.os[ch].up(buf, n)
      for (let i = 0; i < len; i++) {
        const x = hi[i]
        hi[i] = oddSatCurve(G * x) * invG - x
      }
      const corr = this.corr
      this.os[ch].down(corr, n)
      const dry = this.dry[ch]
      let x1 = this.dcX1[ch], y1 = this.dcY1[ch]
      for (let i = 0; i < n; i++) {
        // One-pole DC blocker on the correction: the asymmetry's offset.
        const c = corr[i]
        y1 = c - x1 + a * y1
        x1 = c
        buf[i] = dry.push(buf[i]) + y1
      }
      this.dcX1[ch] = x1
      this.dcY1[ch] = y1
    }
  }
}
