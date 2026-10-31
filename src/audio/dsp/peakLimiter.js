/**
 * Linked lookahead peak limiter with a release — a GAIN that holds a ceiling,
 * never a waveshaper.
 *
 * WHY. VoxPressor's per-stage makeup lifts each stage's body to the input's
 * 99.9th percentile, which puts a few onsets 3–4 dB over the stage's input
 * peak. A memoryless soft ceiling (`softCeiling`, a tanh knee) bent those
 * samples back down — 0.15 % of the samples of a real narration clip, up to
 * 3.3 dB deep — and a tanh on a loud transient is a distortion generator: the
 * owner's verdict was that it does not sound good on spikes, where the tuned
 * harmonics are the LA-2A's. This takes the same onsets down with a smooth gain
 * envelope instead, so what it costs is a few ms of level, not a harmonic
 * series.
 *
 * THE NO-OVERSHOOT GUARANTEE IS lookaheadLimiter.js's: the centred running min
 * and the triangular smoother share a half-width, so g ≤ gReq at every sample.
 * The release is the Warmth guard's (`warmthGuard.js`): a one-pole that lags
 * only UPWARD and takes the smoothed value whenever it falls, so it keeps
 * g ≤ gReq too. Linked across channels, so the image does not move.
 *
 * LATENCY is 2L, constant. With no ceiling it is a pure delay, bit for bit:
 * every request is 1, the running sums of exact ones stay exactly one, and the
 * gain never leaves 1.
 */

import { RunningMin, Boxcar } from './lookaheadLimiter.js'
import { float32AtOrBelow } from './makeupReference.js'

/**
 * Half-width of the lookahead, ms: the gain is fully down 2L after it starts
 * falling. Reasoned — long enough that the envelope does not ride a voice's
 * cycles (the Warmth guard's 1.5 ms works on bass), short enough not to
 * pre-duck a consonant audibly.
 */
export const PEAK_LIMITER_HALF_MS = 2
/** Release, ms (one-pole, upward only). Reasoned, not auditioned. */
export const PEAK_LIMITER_RELEASE_MS = 50

export function peakLimiterHalfWidth(sampleRate) {
  return Math.max(1, Math.round((PEAK_LIMITER_HALF_MS / 1000) * sampleRate))
}

/** The limiter's latency, samples (constant, on or off). */
export function peakLimiterLatencySamples(sampleRate) {
  return 2 * peakLimiterHalfWidth(sampleRate)
}

export class LinkedPeakLimiter {
  constructor(sampleRate) {
    const L = peakLimiterHalfWidth(sampleRate)
    this.L = L
    this.latencySamples = 2 * L
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    this.relCoef = 1 - Math.exp(-1 / ((PEAK_LIMITER_RELEASE_MS / 1000) * sampleRate))
    this.g = 1
    this.threshold = 0 // linear; 0 = no ceiling
    this.lines = []
    this.pos = 0
    this.minGain = 1
    // Consecutive samples whose request was 1: once the min window and both
    // boxcars hold nothing else, an idle limiter is a delay line.
    this.quiet = 0
  }

  /** The ceiling, linear (≤ 0 or non-finite: none — a pure delay). */
  setThreshold(lin) {
    this.threshold = Number.isFinite(lin) && lin > 0 ? lin : 0
  }

  reset() {
    this.min.reset()
    this.box1.fill(1)
    this.box2.fill(1)
    for (const l of this.lines) l.fill(0)
    this.pos = 0
    this.g = 1
    this.minGain = 1
    this.quiet = 0
  }

  /** Limit `io` in place; its output is delayed by `latencySamples`. */
  process(io, n) {
    const nCh = io.length
    const lat = this.latencySamples
    while (this.lines.length < nCh) this.lines.push(new Float32Array(lat))
    const T = this.threshold
    /**
     * IDLE FAST PATH: no ceiling, the gain back at exactly 1 and every stage of
     * the lookahead flushed to 1 (2L + 1 for the min window, L + 1 for each
     * boxcar). Pushing more ones would leave all of them unchanged, so the
     * output is the delayed input, bit for bit, and the pushes are skipped.
     */
    if (T === 0 && this.g === 1 && this.quiet > 4 * this.L + 3) {
      for (let c = 0; c < nCh; c++) {
        const line = this.lines[c]
        const x = io[c]
        let pos = this.pos
        for (let i = 0; i < n; i++) {
          const v = x[i]
          x[i] = line[pos]
          line[pos] = v
          pos = pos + 1 === lat ? 0 : pos + 1
        }
      }
      this.pos = (this.pos + n) % lat
      return
    }
    let g = this.g
    let minG = this.minGain
    let quiet = this.quiet
    for (let i = 0; i < n; i++) {
      let req = 1
      if (T > 0) {
        for (let c = 0; c < nCh; c++) {
          const x = io[c][i]
          const a = x < 0 ? -x : x
          if (a > T) {
            const r = T / a
            if (r < req) req = r
          }
        }
      }
      quiet = req === 1 ? quiet + 1 : 0
      const s = this.box2.push(this.box1.push(this.min.push(req)))
      g = s < g ? s : g + (s - g) * this.relCoef
      if (g < minG) minG = g
      // Read before write: the line delays by exactly its length.
      for (let c = 0; c < nCh; c++) {
        const line = this.lines[c]
        const x = io[c][i]
        io[c][i] = line[this.pos] * g
        line[this.pos] = x
      }
      this.pos = this.pos + 1 === lat ? 0 : this.pos + 1
    }
    // Snap a gain that has relaxed to within float noise of 1, so an idle
    // limiter is exact again.
    this.g = g > 1 - 1e-9 ? 1 : g
    this.minGain = minG
    this.quiet = quiet
  }

  /** Lowest gain since the last call (1 = untouched). */
  takeMinGain() {
    const m = this.minGain
    this.minGain = 1
    return m
  }
}

/**
 * Run a fresh limiter over whole channels at `ceilingDb`, latency removed, so
 * the result lines up with `channels` — the measurements' offline copy of what
 * the kernel's limiter does to the same samples.
 */
export function limitChannels(channels, ceilingDb, sampleRate) {
  const lim = new LinkedPeakLimiter(sampleRate)
  // The kernel's own rounding (`VoxPressorKernel._ceilingLin`), so the two agree.
  lim.setThreshold(Number.isFinite(ceilingDb) ? float32AtOrBelow(Math.exp(ceilingDb * (Math.LN10 / 20))) : 0)
  const len = channels[0].length
  const L = lim.latencySamples
  const io = channels.map((c) => {
    const q = new Float32Array(len + L)
    q.set(c, 0)
    return q
  })
  lim.process(io, len + L)
  return io.map(c => c.subarray(L, L + len))
}
