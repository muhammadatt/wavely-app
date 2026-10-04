/**
 * HF Limiter — the Warmth PEAK GUARD: a lookahead limiter on what the Warmth
 * stage ADDS, never on the voice.
 *
 * WHY. The Warmth layers live on the low band, so what they add peaks with the
 * bass peaks — the added signal lines up with the source at exactly the moments
 * the source is loudest, and the sum overshoots ("doubling up"). A compressor
 * answers the wrong question (energy over whole syllables, no promise about the
 * peak); a gain on the whole output spends the entire file's level on a few
 * peaks. This turns down only the added signal, only around the samples where
 * the sum would pass the ceiling.
 *
 *   x  = the input, aligned to the Warmth output    a = y − x (what was added)
 *   C  = max(ceiling, |x|)   — never past the ceiling, and never past a sample
 *        that is already above it (preview can play louder than the selection)
 *   gReq = the largest g in [0, 1] with |x + g·a| ≤ C
 *   out = x + g·a, g ≤ gReq at every sample
 *
 * THE NO-OVERSHOOT GUARANTEE IS lookaheadLimiter.js's, carried over. |x + g·a|
 * is convex in g and ≤ C at g = 0 and at g = gReq, so ANY g ≤ gReq is safe;
 * the centred running min + triangular smoother of the same half-width makes
 * g ≤ gReq (see that file's proof), and the release one-pole only ever lags
 * UPWARD, taking the smoothed value whenever it falls — so it keeps g ≤ gReq
 * too. Linked across channels: the stereo image is not moved.
 *
 * LATENCY is 2L, constant: off, the guard is a pure delay (gReq ≡ 1 and the
 * smoother's running sums of exact ones stay exactly one).
 */

import { RunningMin, Boxcar } from './lookaheadLimiter.js'

/** Half-width L of the lookahead, ms: the gain is fully down 2L after it starts. */
export const WARMTH_GUARD_HALF_MS = 1.5
/** Release back up once the peak has passed, ms (one-pole). Reasoned, not auditioned. */
export const WARMTH_GUARD_RELEASE_MS = 60

export function warmthGuardHalfWidth(sampleRate) {
  return Math.max(1, Math.round((WARMTH_GUARD_HALF_MS / 1000) * sampleRate))
}

/** The guard's latency, samples (constant, on or off). */
export function warmthGuardLatencySamples(sampleRate) {
  return 2 * warmthGuardHalfWidth(sampleRate)
}

/** Largest g in [0, 1] with |x + g·a| ≤ c, given |x| ≤ c. */
function requiredGain(x, a, c) {
  const s = x + a
  if (s <= c && s >= -c) return 1
  const t = a > 0 ? (c - x) / a : (-c - x) / a
  return t <= 0 ? 0 : t >= 1 ? 1 : t
}

export class WarmthPeakGuard {
  /**
   * @param {number} sampleRate
   * @param {number} dryDelay how far the Warmth output lags the input, samples:
   *   the input is delayed this much to line up with it.
   */
  constructor(sampleRate, dryDelay = 0) {
    const L = warmthGuardHalfWidth(sampleRate)
    this.L = L
    this.latencySamples = 2 * L
    this.dryDelay = dryDelay
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    this.relCoef = 1 - Math.exp(-1 / ((WARMTH_GUARD_RELEASE_MS / 1000) * sampleRate))
    this.g = 1
    this.on = false
    this.ceiling = Infinity
    this.ch = [] // per channel: dry delay, x and a delay lines
    this.pos = 0
    this.dryPos = 0
    this.minGain = 1
  }

  /** `on`; `ceilingDb` — the source's own peak, dBFS (null: no ceiling). */
  setParams({ on, ceilingDb } = {}) {
    if (on !== undefined) this.on = !!on
    if (ceilingDb !== undefined) {
      this.ceiling = Number.isFinite(ceilingDb) ? 10 ** (ceilingDb / 20) : Infinity
    }
  }

  _ensure(nCh) {
    while (this.ch.length < nCh) {
      this.ch.push({
        dry: new Float32Array(Math.max(1, this.dryDelay)),
        x: new Float32Array(this.latencySamples),
        a: new Float32Array(this.latencySamples),
      })
    }
  }

  /**
   * @param {Float32Array[]} input the stage's INPUT, undelayed
   * @param {Float32Array[]} io the Warmth output, guarded in place (delayed by `latencySamples`)
   */
  process(input, io, n) {
    const nCh = io.length
    const nIn = input.length
    this._ensure(nCh)
    const D = this.dryDelay
    const lat = this.latencySamples
    const guarded = this.on && this.ceiling < Infinity
    let minG = this.minGain
    for (let i = 0; i < n; i++) {
      let req = 1
      for (let c = 0; c < nCh; c++) {
        const st = this.ch[c]
        const raw = input[c < nIn ? c : nIn - 1][i]
        let x = raw
        if (D > 0) {
          x = st.dry[this.dryPos]
          st.dry[this.dryPos] = raw
        }
        const a = io[c][i] - x
        if (guarded) {
          const ax = x < 0 ? -x : x
          const r = requiredGain(x, a, ax > this.ceiling ? ax : this.ceiling)
          if (r < req) req = r
        }
        // Hold x and a for the lookahead; read before write delays by exactly `lat`.
        st.ox = st.x[this.pos]
        st.oa = st.a[this.pos]
        st.x[this.pos] = x
        st.a[this.pos] = a
      }
      const s = this.box2.push(this.box1.push(this.min.push(req)))
      // Release: lag upward only; take the smoothed value whenever it falls.
      this.g = s < this.g ? s : this.g + (s - this.g) * this.relCoef
      if (this.g < minG) minG = this.g
      for (let c = 0; c < nCh; c++) {
        const st = this.ch[c]
        io[c][i] = st.ox + this.g * st.oa
      }
      this.pos = this.pos + 1 === lat ? 0 : this.pos + 1
      if (D > 0) this.dryPos = this.dryPos + 1 === D ? 0 : this.dryPos + 1
    }
    this.minGain = minG
  }

  /** Lowest gain on the added signal since the last call (1 = untouched). */
  takeMinGain() {
    const m = this.minGain
    this.minGain = 1
    return m
  }
}
