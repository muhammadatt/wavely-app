/**
 * Envelope / smoothing primitives.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Note there are two coefficient conventions in this codebase and they are NOT
 * interchangeable. Both are provided under explicit names so ports stay honest:
 *
 *   decayCoeff  — `exp(-period / tau)`, the weight kept on the PREVIOUS value.
 *                 Used as `y = c*y + (1-c)*x`. This is what the Python stages
 *                 use (resonance_suppressor.py `_time_to_coeff`,
 *                 air_boost_masked.py `build_frame_envelope`), applied at the
 *                 STFT frame rate rather than per sample.
 *
 *   riseCoeff   — `1 - exp(-period / tau)`, the weight applied to the NEW value.
 *                 Used as `y += c * (x - y)`. This is what the existing
 *                 compressor kernels use (la2aProcessor.js, fet1176Processor.js).
 *
 * riseCoeff(t) === 1 - decayCoeff(t); mixing them up inverts attack and release.
 */

/** Weight kept on the previous value. Period and tau in the same units. */
export function decayCoeff(tauMs, periodMs) {
  if (tauMs <= 0 || periodMs <= 0) return 0
  return Math.exp(-periodMs / tauMs)
}

/** Weight applied to the new value, per sample. */
export function riseCoeff(tauMs, sampleRate) {
  if (tauMs <= 0) return 1
  return 1 - Math.exp(-1 / (sampleRate * (tauMs / 1000)))
}

/**
 * One-pole RMS follower.
 *
 * Stands in for the whole-file RMS normalisation in vocal_saturation.py, which
 * computes `sqrt(dot(x,x)/len(x))` over the entire array — not something a
 * streaming effect can do. A ~300 ms time constant tracks programme level
 * without audibly pumping on speech.
 *
 * `floorLinear` clamps the reported value so silence cannot blow up a
 * downstream `dryRms / wetRms` division.
 */
export class RmsFollower {
  /**
   * @param {number} sampleRate
   * @param {number} [tauMs=300]
   * @param {number} [floorLinear=1e-6] clamp on the reported value, so the
   *   follower is safe to divide by
   */
  constructor(sampleRate, tauMs = 300, floorLinear = 1e-6) {
    this.coeff = riseCoeff(tauMs, sampleRate)
    this.floorLinear = floorLinear
    // Warm up with a cumulative mean over roughly one time constant before
    // handing over to the exponential average. Starting the IIR from zero
    // makes the first ~tau read far too quiet, which matters wherever this
    // stands in for a whole-file measurement: a gain derived from it would
    // swing over the opening moments and leave an audible step at a region
    // boundary. Seeding from a single sample is not enough either — a tone
    // that happens to start at a zero crossing seeds zero.
    this.warmupTarget = Math.max(1, Math.round(sampleRate * (tauMs / 1000)))
    this.warmupCount = 0
    this.meanSq = 0
  }

  reset() {
    this.meanSq = 0
    this.warmupCount = 0
  }

  /** Seed the estimate directly and skip the warmup. */
  prime(meanSq) {
    this.meanSq = meanSq
    this.warmupCount = this.warmupTarget
  }

  /** Feed one sample; returns the current RMS estimate. */
  process(x) {
    const sq = x * x
    if (this.warmupCount < this.warmupTarget) {
      this.warmupCount++
      this.meanSq += (sq - this.meanSq) / this.warmupCount
    } else {
      this.meanSq += this.coeff * (sq - this.meanSq)
    }
    return this.value
  }

  /** Feed a block, returning the RMS estimate after the last sample. */
  processBlock(input, n) {
    for (let i = 0; i < n; i++) this.process(input[i])
    return this.value
  }

  get value() {
    return Math.max(Math.sqrt(this.meanSq), this.floorLinear)
  }

  get db() {
    return 20 * Math.log10(this.value)
  }
}

/**
 * Attack/release peak follower — asymmetric one-pole, per-sample.
 * Shared shape with the compressor kernels' detectors.
 */
export class AttackReleaseFollower {
  constructor(sampleRate, attackMs, releaseMs) {
    this.setTimes(sampleRate, attackMs, releaseMs)
    this.value = 0
  }

  setTimes(sampleRate, attackMs, releaseMs) {
    this.attack = riseCoeff(attackMs, sampleRate)
    this.release = riseCoeff(releaseMs, sampleRate)
  }

  reset() {
    this.value = 0
  }

  process(x) {
    const c = x > this.value ? this.attack : this.release
    this.value += c * (x - this.value)
    return this.value
  }
}

export function linToDb(x) {
  return 20 * Math.log10(Math.max(x, 1e-12))
}

export function dbToLin(db) {
  return Math.pow(10, db / 20)
}
