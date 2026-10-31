/**
 * PARALLEL DE-ESSER — a dynamic top-band cut on VoxPressor's parallel COPY,
 * after its makeup and before the blend: the mixer's "heavy de-ess on the
 * parallel bus".
 *
 * WHY THE COPY NEEDS ITS OWN. Parallel compression lifts what is quiet, and a
 * quiet "s" — the tail of a phrase, a soft passage — is exactly what a
 * level-threshold de-esser upstream let through. The copy's makeup then
 * brings it up with everything else.
 *
 * THE DETECTOR IS LA VINTAGE 2A'S SIBILANCE GUARD's (`la2aProcessor.js`), its
 * constants COPIED, not imported (this module stays free of the kernel), and
 * pinned equal by a test: the share of the signal's energy above 4 kHz
 * (mean squares over 4 ms), mapped 0.25 → 0.6 through a smoothstep, 1 ms
 * attack / 30 ms release. ⚠ A RATIO, NOT A LEVEL, and that is the point: it
 * reads a quiet "s" exactly as a loud one, so the sibilants parallel lifts are
 * the ones it catches. It also makes the stage HOMOGENEOUS — scaling the input
 * scales the output and changes no gain — so a makeup applied before it
 * commutes with it, which the 1176's closed-form solve relies on.
 *
 * THE CUT is the complementary split `g·x + (1−g)·LP2(x)` (a Butterworth
 * low-pass at the split): unity where nothing is caught, and at full depth the
 * band above the split down by `depthDb`. Linked across channels, mono
 * detector. No lookahead, so no latency.
 *
 * ⚠ The guard does NOT de-ess: it lowers the LA-2A cell's DRIVE on an "s"
 * (grit), not its level. Only its detector is reused here.
 *
 * ⚠ No level gate: hiss in a pause reads as a high ratio too, and the cut
 * takes the top off the copy's lifted room noise — arguably welcome, and a
 * gate would cost the homogeneity above.
 */
import { BiquadCascade, highpass, lowpass } from './biquad.js'

export const PARALLEL_DEESS_DETECT_HZ = 4000
export const PARALLEL_DEESS_RATIO_LO = 0.25
export const PARALLEL_DEESS_RATIO_HI = 0.6
export const PARALLEL_DEESS_ENV_MS = 4
export const PARALLEL_DEESS_ATTACK_MS = 1
export const PARALLEL_DEESS_RELEASE_MS = 30
/** Where the cut starts: the split's low-pass corner. */
export const PARALLEL_DEESS_SPLIT_HZ = 4000
/** The cut at full scale of the 0–100 amount, dB. */
export const PARALLEL_DEESS_MAX_DB = 24

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export class ParallelDeEsser {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    const nyq = sampleRate * 0.45
    this.detHp = highpass(sampleRate, Math.min(PARALLEL_DEESS_DETECT_HZ, nyq))
    this.splitLp = lowpass(sampleRate, Math.min(PARALLEL_DEESS_SPLIT_HZ, nyq))
    this.envCoef = 1 - Math.exp(-1 / (sampleRate * (PARALLEL_DEESS_ENV_MS / 1000)))
    this.atkCoef = 1 - Math.exp(-1 / (sampleRate * (PARALLEL_DEESS_ATTACK_MS / 1000)))
    this.relCoef = 1 - Math.exp(-1 / (sampleRate * (PARALLEL_DEESS_RELEASE_MS / 1000)))
    this.depthDb = 0
    this.lps = []
    this.gainBuf = new Float32Array(0)
    this.mono = new Float32Array(0)
    /** The deepest cut since `takeCutDb`, dB (positive), for a meter. */
    this.cutHold = 0
    this.reset()
  }

  reset() {
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0
    this.eHigh = 0
    this.eAll = 0
    this.gain = 1
    for (const c of this.lps) c.reset()
  }

  /** Full-depth cut, dB (≥ 0). 0 makes `process` a no-op. */
  setDepthDb(depthDb) {
    this.depthDb = Number.isFinite(depthDb) ? Math.max(0, depthDb) : 0
  }

  get active() {
    return this.depthDb > 0
  }

  takeCutDb() {
    const c = this.cutHold
    this.cutHold = 0
    return c
  }

  /** De-ess `channels` in place, `n` samples. */
  process(channels, n) {
    if (!(this.depthDb > 0)) return
    const nCh = channels.length
    while (this.lps.length < nCh) {
      const c = new BiquadCascade(1, 1)
      c.setSections([this.splitLp])
      this.lps.push(c)
    }
    if (this.gainBuf.length < n) {
      this.gainBuf = new Float32Array(n)
      this.mono = new Float32Array(n)
    }
    const h = this.detHp
    const depthLn = this.depthDb * (Math.LN10 / 20)
    const scale = 1 / nCh
    let { x1, x2, y1, y2, eHigh, eAll, gain } = this
    let minGain = 1
    for (let i = 0; i < n; i++) {
      let x = channels[0][i]
      for (let ch = 1; ch < nCh; ch++) x += channels[ch][i]
      x *= scale
      const y = h.b0 * x + h.b1 * x1 + h.b2 * x2 - h.a1 * y1 - h.a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y
      eHigh += (y * y - eHigh) * this.envCoef
      eAll += (x * x - eAll) * this.envCoef
      const t = eAll > 1e-12
        ? clamp((eHigh / eAll - PARALLEL_DEESS_RATIO_LO) / (PARALLEL_DEESS_RATIO_HI - PARALLEL_DEESS_RATIO_LO), 0, 1)
        : 0
      const target = Math.exp(-depthLn * t * t * (3 - 2 * t))
      gain += (target - gain) * (target < gain ? this.atkCoef : this.relCoef)
      this.gainBuf[i] = gain
      if (gain < minGain) minGain = gain
    }
    Object.assign(this, { x1, x2, y1, y2, eHigh, eAll, gain })

    const g = this.gainBuf
    const lp = this.mono
    for (let ch = 0; ch < nCh; ch++) {
      const io = channels[ch]
      this.lps[ch].process(io, lp, n, 0)
      for (let i = 0; i < n; i++) io[i] = g[i] * io[i] + (1 - g[i]) * lp[i]
    }
    const cut = -20 * Math.log10(minGain)
    if (cut > this.cutHold) this.cutHold = cut
  }
}
