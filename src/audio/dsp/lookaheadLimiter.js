/**
 * Lookahead peak limiter — the gain-reduction half of the soft clipper's
 * hybrid peak control.
 *
 * WHY IT EXISTS. The soft clipper takes peaks down by reshaping individual
 * samples, which generates harmonics: measured on real narration, the residual
 * runs -16 dBc at 13 dB of drive, and it is genuine in-band distortion rather
 * than fold-back (8x oversampling changes it by nothing — see
 * COMPRESSOR_OVERSAMPLE_8X). A lookahead limiter takes the same peaks down with
 * a smooth GAIN ENVELOPE instead, so its error is intermodulation and slight
 * pumping rather than a harmonic series sitting on top of the voice. The two
 * are meant to work together: the limiter does the bulk of the peak control and
 * the curve catches what slips past, so most of the reduction stops passing
 * through the distortion-generating path at all.
 *
 * THE NO-OVERSHOOT GUARANTEE IS STRUCTURAL, NOT MEASURED, and the construction
 * is chosen for that reason. A limiter you can beat is not a limiter, and the
 * usual failure — smoothing a gain envelope until it no longer reaches its
 * target at the peak — is silent.
 *
 *   gReq[n]  = min(1, T / |x[n]|)                       required gain
 *   gMin[n]  = min of gReq over [n-L, n+L]              centred running min
 *   g[n]     = triangular smoother of gMin, support [n-L, n+L]
 *
 * Then g[n] <= gReq[n] for every n, and the proof is one line: g[n] is a convex
 * combination of gMin[k] for k in [n-L, n+L], and every such gMin[k] is a min
 * over a window that CONTAINS n, so every term is <= gReq[n]. A convex
 * combination of things no greater than gReq[n] is no greater than gReq[n].
 *
 * That is why the min window and the smoother share the same half-width. Widen
 * the smoother past the min window and the guarantee is gone.
 *
 * LATENCY is 2L samples: L of lookahead for the centred min, and L more for the
 * smoother's group delay. The audio is delayed to match.
 *
 * The triangular smoother is two cascaded boxcars, which is what makes the
 * whole thing O(1) per sample — running sums for the boxcars and a monotonic
 * deque for the min.
 */

/**
 * Running minimum over a sliding window, O(1) amortised.
 *
 * A monotonic deque: indices are kept in increasing order of value, so the
 * front is always the window's minimum. Anything larger than an arriving
 * sample can never be the minimum again while that sample is in the window,
 * so it is dropped.
 */
class RunningMin {
  constructor(window) {
    this.window = window
    this.idx = new Int32Array(window + 1)
    this.val = new Float32Array(window + 1)
    this.head = 0
    this.tail = 0
    this.n = 0
  }

  reset() {
    // The stale index/value arrays cannot change the answer — the deque is
    // empty and every entry is rewritten before it is read — but clearing them
    // makes a reset instance genuinely identical to a fresh one, which is what
    // the test asserts and what makes a reset trustworthy.
    this.idx.fill(0)
    this.val.fill(0)
    this.head = 0
    this.tail = 0
    this.n = 0
  }

  /** Push one sample; returns the minimum over the last `window` samples. */
  push(v) {
    const cap = this.idx.length
    while (this.tail !== this.head) {
      const back = (this.tail - 1 + cap) % cap
      if (this.val[back] >= v) this.tail = back
      else break
    }
    this.idx[this.tail] = this.n
    this.val[this.tail] = v
    this.tail = (this.tail + 1) % cap
    // Drop anything that has fallen out of the window.
    while (this.idx[this.head] <= this.n - this.window) this.head = (this.head + 1) % cap
    this.n++
    return this.val[this.head]
  }
}

/** Boxcar average of a fixed length, via a running sum. */
class Boxcar {
  constructor(length) {
    this.length = length
    this.buf = new Float64Array(length)
    this.pos = 0
    this.sum = 0
    this.fill(1)
  }

  /** Prime the history with a value, so the first samples are not a ramp. */
  fill(v) {
    this.buf.fill(v)
    this.sum = v * this.length
    this.pos = 0
  }

  push(v) {
    this.sum -= this.buf[this.pos]
    this.buf[this.pos] = v
    this.sum += v
    this.pos = this.pos + 1 === this.length ? 0 : this.pos + 1
    return this.sum / this.length
  }
}

export class LookaheadLimiter {
  /**
   * @param {number} halfWidth L, in samples. Latency is 2L; the min window is
   *   2L+1 and the smoother's support is the same.
   */
  constructor(halfWidth) {
    const L = Math.max(1, Math.round(halfWidth))
    this.L = L
    this.latencySamples = 2 * L
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    // The audio is held back by the full latency so the envelope lands on the
    // sample it was computed for.
    //
    // ⚠ LENGTH 2L, NOT 2L+1. A circular buffer that is read before it is
    // written delays by exactly its LENGTH, so sizing it 2L+1 put the envelope
    // one sample off the peak it was computed for — which on a bare impulse is
    // the whole error: measured, it overshot the threshold by 0.2%. Small
    // enough to read as float noise and large enough to break the guarantee.
    this.delay = new Float32Array(2 * L)
    this.delayPos = 0
    this.lastGain = 1
  }

  reset() {
    this.min.reset()
    this.box1.fill(1)
    this.box2.fill(1)
    this.delay.fill(0)
    this.delayPos = 0
    this.lastGain = 1
  }

  /**
   * One sample in, one delayed-and-limited sample out.
   *
   * `threshold` is per-sample so it can follow the stage's adaptive T. It is
   * read at the time the REQUIRED gain is computed — i.e. against the sample
   * arriving now, which is `latencySamples` ahead of the one coming out.
   */
  processSample(x, threshold) {
    const a = x < 0 ? -x : x
    const req = a > threshold && a > 0 ? threshold / a : 1
    const g = this.box2.push(this.box1.push(this.min.push(req)))
    this.lastGain = g

    const out = this.delay[this.delayPos]
    this.delay[this.delayPos] = x
    this.delayPos = this.delayPos + 1 === this.delay.length ? 0 : this.delayPos + 1
    return out * g
  }

  /** Gain applied to the most recent output sample, linear. */
  get gain() {
    return this.lastGain
  }
}
