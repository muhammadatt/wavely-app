/**
 * Band-split lookahead limiter — the fix for the broadband limiter's one
 * measured cost.
 *
 * WHY IT EXISTS. LookaheadLimiter is a single gain envelope over the whole
 * signal, so anything within L of a peak is pulled down whether or not it is
 * itself over the threshold: measured on three narrators at a -14 dBFS
 * threshold with 2 ms of lookahead, 24-36% of the SUB-threshold samples are
 * gain-reduced, by 2.2-5.4 dB on average and up to 13 dB. That was reported by
 * ear as a tonal change below the threshold, and the reading was right — the
 * peaks that drive a voice's envelope are overwhelmingly low-frequency
 * (plosives, vowel onsets), and a broadband envelope hands their gain reduction
 * to the sibilants and the air as well.
 *
 * Splitting the signal first and giving each band its own envelope confines the
 * ducking to the band that caused it. A 120 Hz plosive then ducks 120 Hz.
 *
 * WHAT IT COSTS, and it is not nothing:
 *
 *  1. THE NO-OVERSHOOT GUARANTEE WEAKENS FROM STRUCTURAL TO MEASURED. Each band
 *     is held to T by LookaheadLimiter's own proof, but N bands each at T can
 *     sum to N*T — +9.5 dB at three bands. In practice the bands peak at
 *     different instants and the real overshoot is far smaller (measured on
 *     real narration; see CLAUDE.md), and the soft clip curve downstream is
 *     there to catch exactly this. But "you cannot beat it" is gone, so a
 *     `safety` pass is available: one broadband LookaheadLimiter on the sum,
 *     which restores the guarantee for another 2L of latency. It only ever acts
 *     on what the split failed to control, so its own ducking is rare.
 *
 *  2. RECONSTRUCTION IS MAGNITUDE-FLAT, NOT SAMPLE-EXACT. The crossover is
 *     Linkwitz-Riley 4th order, whose LP and HP sum to a 2nd-order ALLPASS
 *     rather than to unity. Magnitude is flat to within float error; phase is
 *     not. That is acceptable here for one specific reason: the whole limiter
 *     is bypassed at Limiter 0, so the shipped default patch never sees the
 *     crossover and stays bit-identical. A subtractive split (x - LP) would
 *     reconstruct exactly and is not used, because at LR4 the subtraction leaves
 *     a +3.5 dB bump at the crossover in the upper band — an exact sum of two
 *     wrong bands, which is worse for a limiter whose whole job is per-band
 *     level.
 *
 *  3. Three envelopes and six biquad sections per channel instead of one
 *     envelope.
 *
 * THE THREE-WAY SPLIT NEEDS AN ALLPASS CORRECTION and leaving it out is the
 * classic bug. Splitting at f1 then splitting the upper half at f2 puts the mid
 * and high bands through f2's allpass sum while the low band skips it, so the
 * low band arrives with the wrong phase and the reconstruction develops a dip
 * at f1. The low band is therefore passed through AP(f2) explicitly, and the
 * sum is then AP(f2)*AP(f1) applied to the input — allpass, as intended.
 */

import { LookaheadLimiter } from './lookaheadLimiter.js'

/** Direct-form-II transposed biquad. */
class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0
    this.b1 = b1
    this.b2 = b2
    this.a1 = a1
    this.a2 = a2
    this.z1 = 0
    this.z2 = 0
  }

  reset() {
    this.z1 = 0
    this.z2 = 0
  }

  process(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

const BUTTER_Q = Math.SQRT1_2

function lowpass(fc, sampleRate) {
  const w0 = (2 * Math.PI * fc) / sampleRate
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * BUTTER_Q)
  const a0 = 1 + alpha
  const b = (1 - cw) / 2
  return new Biquad(b / a0, (1 - cw) / a0, b / a0, (-2 * cw) / a0, (1 - alpha) / a0)
}

function highpass(fc, sampleRate) {
  const w0 = (2 * Math.PI * fc) / sampleRate
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * BUTTER_Q)
  const a0 = 1 + alpha
  const b = (1 + cw) / 2
  return new Biquad(b / a0, (-(1 + cw)) / a0, b / a0, (-2 * cw) / a0, (1 - alpha) / a0)
}

/**
 * 2nd-order allpass at the same corner and Q — this is exactly what an LR4 pair
 * sums to, which is why it is the correction the lower band needs.
 */
function allpass(fc, sampleRate) {
  const w0 = (2 * Math.PI * fc) / sampleRate
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * BUTTER_Q)
  const a0 = 1 + alpha
  return new Biquad((1 - alpha) / a0, (-2 * cw) / a0, 1, (-2 * cw) / a0, (1 - alpha) / a0)
}

/** LR4 = two cascaded Butterworth 2nd-order sections of the same kind. */
class LR4 {
  constructor(make, fc, sampleRate) {
    this.a = make(fc, sampleRate)
    this.b = make(fc, sampleRate)
  }

  reset() {
    this.a.reset()
    this.b.reset()
  }

  process(x) {
    return this.b.process(this.a.process(x))
  }
}

export class BandSplitLimiter {
  /**
   * @param {number} halfWidth L in samples, as LookaheadLimiter.
   * @param {number[]} crossovers Ascending crossover frequencies in Hz. One
   *   entry gives two bands, two entries three, and so on.
   * @param {number} sampleRate
   * @param {{safety?: boolean, ceilingFactor?: number}} [options] `safety` adds
   *   a broadband limiter on the sum, restoring the no-overshoot guarantee for
   *   another 2L of latency. `ceilingFactor` scales each band's ceiling below T:
   *   at 1/nBands the sum is provably <= T with no safety pass at all, at the
   *   cost of limiting every band far harder than it needs.
   */
  constructor(halfWidth, crossovers, sampleRate, options = {}) {
    const L = Math.max(1, Math.round(halfWidth))
    this.L = L
    this.crossovers = crossovers.slice()
    this.nBands = crossovers.length + 1

    // Split stages, low to high. Stage k splits what is left above crossover
    // k-1 into "band k" and "the rest".
    this.stages = crossovers.map(fc => ({
      lp: new LR4(lowpass, fc, sampleRate),
      hp: new LR4(highpass, fc, sampleRate),
      // Every band completed BEFORE this stage must be carried through this
      // stage's allpass sum, or the reconstruction dips at the earlier
      // crossover. One allpass per already-finished band.
      corrections: [],
    }))
    for (let k = 0; k < this.stages.length; k++) {
      for (let j = 0; j < k; j++) {
        this.stages[k].corrections.push(allpass(crossovers[k], sampleRate))
      }
    }

    this.limiters = []
    for (let i = 0; i < this.nBands; i++) this.limiters.push(new LookaheadLimiter(L))
    this.bandGains = new Float64Array(this.nBands)
    this.bandScratch = new Float64Array(this.nBands)

    this.ceilingFactor = options.ceilingFactor ?? 1
    this.safety = options.safety === true ? new LookaheadLimiter(L) : null
    this.latencySamples = 2 * L + (this.safety ? 2 * L : 0)
    this.lastGain = 1
  }

  reset() {
    for (const s of this.stages) {
      s.lp.reset()
      s.hp.reset()
      for (const c of s.corrections) c.reset()
    }
    for (const l of this.limiters) l.reset()
    if (this.safety) this.safety.reset()
    this.bandGains.fill(1)
    this.lastGain = 1
  }

  /**
   * One sample in, one delayed-and-limited sample out.
   *
   * Every band is held to the same `threshold`. A band whose content never
   * reaches it is passed through untouched, which is the entire point: an HF
   * band that peaks 15 dB under the plosive that set the broadband envelope now
   * keeps its level.
   */
  processSample(x, threshold) {
    const bands = this.bandScratch
    let rest = x
    for (let k = 0; k < this.stages.length; k++) {
      const s = this.stages[k]
      const low = s.lp.process(rest)
      rest = s.hp.process(rest)
      // Carry the already-finished bands through this stage's allpass.
      for (let j = 0; j < k; j++) bands[j] = s.corrections[j].process(bands[j])
      bands[k] = low
    }
    bands[this.stages.length] = rest

    let sum = 0
    const bandCeiling = threshold * this.ceilingFactor
    for (let i = 0; i < this.nBands; i++) {
      const y = this.limiters[i].processSample(bands[i], bandCeiling)
      this.bandGains[i] = this.limiters[i].gain
      sum += y
    }

    if (this.safety) {
      const out = this.safety.processSample(sum, threshold)
      this.lastGain = this.safety.gain
      return out
    }
    this.lastGain = 1
    return sum
  }

  /** Gain the safety pass applied to the most recent output sample, linear. */
  get gain() {
    return this.lastGain
  }
}
