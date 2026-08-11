/**
 * Polyphase halfband oversampling, for running a waveshaper above the base rate.
 *
 * Dependency-free — imported by AudioWorklet kernels (their loaders go through
 * `?worker&url`, which bundles imports; see eqWorkletLoader.js).
 *
 * WHY. A static nonlinearity generates harmonics without limit. At 44.1 kHz
 * every harmonic above Nyquist folds back into the audible band as an
 * inharmonic product, and unlike the harmonics themselves those products do not
 * sit in a musical relationship to the note that made them — they read as grit.
 * The compressors' tanh stages were measured at roughly -47 dBc (FET Punch,
 * default fetDrive) and -40 dBc (OptoSmooth, default tubeDrive with auto-makeup
 * engaged) on a 9 kHz tone, both squarely in the sibilance band that narration
 * lives in, and both growing about 6 dB per doubling of successive passes
 * because the products land at reproducible frequencies and add coherently.
 *
 * The fix is to run the nonlinearity at a higher rate, where the harmonics that
 * would have folded stay below the higher Nyquist and can be filtered off on the
 * way back down.
 *
 * STRUCTURE. Each stage doubles the rate using a halfband FIR, which is the
 * standard choice for 2x work: half of its taps are exactly zero, and with the
 * centre tap at an even index the even polyphase branch collapses to a pure
 * delay. Upsampling therefore passes the original samples through untouched and
 * only has to compute the samples in between.
 *
 * Cascading two stages for 4x is much cheaper than one direct 4x filter. Stage
 * one has to separate 20 kHz from 24.1 kHz and needs a long filter; stage two,
 * running at 88.2 kHz, only has to separate 20 kHz from 68.2 kHz and gets away
 * with a short one.
 *
 * LATENCY. These filters are linear phase, so they delay. Tap counts are chosen
 * to make every delay an exact integer number of base-rate samples — see
 * OVERSAMPLE_LATENCY_SAMPLES and UPSAMPLE_DELAY_SAMPLES — which is what lets
 * callers compensate exactly rather than approximately.
 *
 * The price is a gentle rolloff at the very top: the round trip is flat to
 * within 0.01 dB through 19 kHz, then -0.19 dB at 20 kHz and -2.3 dB at 21 kHz.
 * Widening the transition would cost taps and latency to protect content that
 * narration does not have and that a 128-192 kbps MP3 export discards anyway.
 */

/** Zeroth-order modified Bessel function of the first kind, for the Kaiser window. */
function besselI0(x) {
  let sum = 1
  let term = 1
  const halfXSq = (x / 2) * (x / 2)
  for (let k = 1; k < 64; k++) {
    term *= halfXSq / (k * k)
    sum += term
    if (term < sum * 1e-17) break
  }
  return sum
}

/**
 * Kaiser-windowed halfband lowpass, cutoff at a quarter of the rate it runs at.
 *
 * `length` must be ≡ 1 (mod 4). That puts the centre tap at an even index,
 * which is what makes every other tap vanish and the even polyphase branch
 * reduce to a delay — the whole efficiency argument for halfband filters.
 *
 * @param {number} length odd, ≡ 1 (mod 4)
 * @param {number} beta Kaiser shape parameter; higher = more stopband rejection,
 *   wider transition
 * @returns {Float64Array} taps, normalised to unity DC gain
 */
export function halfbandTaps(length, beta) {
  if (length % 4 !== 1) {
    throw new Error(`halfband length must be ≡ 1 (mod 4), got ${length}`)
  }
  const M = (length - 1) / 2
  const taps = new Float64Array(length)
  const denom = besselI0(beta)

  for (let i = 0; i < length; i++) {
    const k = i - M
    // Ideal lowpass at wc = pi/2 → 0.5 * sinc(k/2); the zeros at even k are
    // what make this a halfband.
    const ideal = k === 0 ? 0.5 : Math.sin((Math.PI * k) / 2) / (Math.PI * k)
    const r = (2 * i) / (length - 1) - 1
    const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom
    taps[i] = ideal * window
  }

  // Force the structural zeros exactly to zero — the window leaves them at
  // ~1e-18, and the polyphase form assumes they are gone.
  for (let i = 0; i < length; i++) {
    if (i !== M && (i - M) % 2 === 0) taps[i] = 0
  }

  // Normalise the two polyphase branches separately rather than scaling the
  // whole filter by its sum. An ideal halfband has h[M] = 0.5 with the odd taps
  // summing to 0.5, and the polyphase code below relies on the first of those
  // exactly — it hard-codes the even branch as a delay with a 0.5 coefficient
  // instead of running it. Windowing perturbs the sum slightly, and scaling
  // everything to fix it would drag h[M] off 0.5 and leave the two branches
  // disagreeing by ~0.001 dB. Pinning h[M] and scaling only the odd taps gives
  // unity DC gain and an exactly-correct structure at the same time.
  taps[M] = 0.5
  let oddSum = 0
  for (let i = 1; i < length; i += 2) oddSum += taps[i]
  const oddScale = 0.5 / oddSum
  for (let i = 1; i < length; i += 2) taps[i] *= oddScale
  return taps
}

/**
 * One 2x halfband stage for a single channel, holding its own filter state.
 *
 * Both directions share the odd-phase taps. Writing them out:
 *
 *   up:   y[2i]   = x[i - M/2]                     (even branch is a delay)
 *         y[2i+1] = 2 * Σ p1[j] x[i - j]
 *   down: y[i]    = 0.5 * u[2(i - M/2)] + Σ p1[j] u[2(i - 1 - j) + 1]
 *
 * The factor of 2 on the up path restores the amplitude lost to zero-stuffing.
 * Group delay is M samples at the doubled rate either way, i.e. M/2 base-rate
 * samples per direction.
 */
class HalfbandStage {
  /** @param {Float64Array} taps from `halfbandTaps` */
  constructor(taps) {
    const M = (taps.length - 1) / 2
    this.M = M
    this.halfM = M / 2 // integer because length ≡ 1 (mod 4)

    // Odd-phase taps: h[1], h[3], … h[2M-1].
    this.p1 = new Float64Array(M)
    for (let j = 0; j < M; j++) this.p1[j] = taps[2 * j + 1]

    // Histories are indexed [0] = most recent. Long enough for the deepest
    // reach of either direction.
    this.upHist = new Float64Array(M + this.halfM + 1)
    this.downEvenHist = new Float64Array(this.halfM + 1)
    this.downOddHist = new Float64Array(M + 1)
  }

  reset() {
    this.upHist.fill(0)
    this.downEvenHist.fill(0)
    this.downOddHist.fill(0)
  }

  /**
   * Upsample `n` samples to `2n`.
   * @param {Float32Array|Float64Array} input
   * @param {Float64Array} output at least 2n long
   * @param {number} n
   */
  up(input, output, n) {
    const { p1, M, halfM, upHist } = this
    const histLen = upHist.length

    for (let i = 0; i < n; i++) {
      // Shift newest sample in at [0].
      for (let k = histLen - 1; k > 0; k--) upHist[k] = upHist[k - 1]
      upHist[0] = input[i]

      output[2 * i] = upHist[halfM]

      let acc = 0
      for (let j = 0; j < M; j++) acc += p1[j] * upHist[j]
      output[2 * i + 1] = 2 * acc
    }
  }

  /**
   * Downsample `2n` samples to `n`.
   * @param {Float64Array} input at least 2n long
   * @param {Float64Array} output at least n long
   * @param {number} n output sample count
   */
  down(input, output, n) {
    const { p1, M, halfM, downEvenHist, downOddHist } = this
    const evenLen = downEvenHist.length
    const oddLen = downOddHist.length

    for (let i = 0; i < n; i++) {
      for (let k = evenLen - 1; k > 0; k--) downEvenHist[k] = downEvenHist[k - 1]
      downEvenHist[0] = input[2 * i]
      for (let k = oddLen - 1; k > 0; k--) downOddHist[k] = downOddHist[k - 1]
      downOddHist[0] = input[2 * i + 1]

      let acc = 0.5 * downEvenHist[halfM]
      // u_odd[i - 1 - j] is one further back than u_odd[i - j].
      for (let j = 0; j < M; j++) acc += p1[j] * downOddHist[j + 1]
      output[i] = acc
    }
  }
}

// Stage tap counts. Both are ≡ 1 (mod 4).
//
// Stage 1 runs base↔2x and carries the whole burden: it has to pass 20 kHz and
// stop the image of 20 kHz at 24.1 kHz, a 4 kHz transition at 88.2 kHz. Stage 2
// runs 2x↔4x, where the same passband edge only has to be separated from 68.2
// kHz, so it is short.
//
// STAGE2_TAPS ≡ 1 (mod 8) additionally, so that its contribution to the
// upsample-path delay lands on a whole base-rate sample and the gain envelope
// can be aligned exactly rather than rounded.
const STAGE1_TAPS = 93
const STAGE1_BETA = 9.5
const STAGE2_TAPS = 17
const STAGE2_BETA = 7.0

const STAGE1_H = halfbandTaps(STAGE1_TAPS, STAGE1_BETA)
const STAGE2_H = halfbandTaps(STAGE2_TAPS, STAGE2_BETA)

/** Oversampling factor used by the compressor kernels. 2 or 4. */
export const OVERSAMPLE_FACTOR = 4

/**
 * Round-trip latency in base-rate samples, and the delay that must be applied
 * to a control signal generated at the base rate before it is used at the
 * oversampled rate.
 *
 * Derivation, with M1 = (STAGE1_TAPS-1)/2 and M2 = (STAGE2_TAPS-1)/2: each
 * stage delays by M samples at the rate it outputs, so the upsample path costs
 * M1/2 + M2/4 base-rate samples and the downsample path costs the same again.
 */
const M1 = (STAGE1_TAPS - 1) / 2
const M2 = (STAGE2_TAPS - 1) / 2

export const UPSAMPLE_DELAY_SAMPLES =
  OVERSAMPLE_FACTOR === 4 ? M1 / 2 + M2 / 4 : M1 / 2
export const OVERSAMPLE_LATENCY_SAMPLES = 2 * UPSAMPLE_DELAY_SAMPLES

if (!Number.isInteger(UPSAMPLE_DELAY_SAMPLES)) {
  throw new Error(
    `oversampler delays must be whole base-rate samples, got ${UPSAMPLE_DELAY_SAMPLES}`,
  )
}

/**
 * A per-channel oversampler: `up()` a block, do nonlinear work on it, `down()`
 * it again.
 *
 * Scratch buffers are owned per instance and grown on demand, so `process` does
 * no allocation once the block size settles.
 */
export class Oversampler {
  constructor(factor = OVERSAMPLE_FACTOR) {
    if (factor !== 2 && factor !== 4) {
      throw new Error(`oversampling factor must be 2 or 4, got ${factor}`)
    }
    this.factor = factor
    this.stage1 = new HalfbandStage(STAGE1_H)
    this.stage2 = factor === 4 ? new HalfbandStage(STAGE2_H) : null
    this.mid = new Float64Array(256)
    this.high = new Float64Array(512)
  }

  reset() {
    this.stage1.reset()
    this.stage2?.reset()
    this.mid.fill(0)
    this.high.fill(0)
  }

  _ensure(n) {
    if (this.mid.length < n * 2) this.mid = new Float64Array(n * 2)
    if (this.high.length < n * this.factor) this.high = new Float64Array(n * this.factor)
  }

  /**
   * Upsample `n` base-rate samples. Returns the internal high-rate buffer,
   * valid for `n * factor` samples until the next call.
   */
  up(input, n) {
    this._ensure(n)
    if (this.factor === 2) {
      this.stage1.up(input, this.high, n)
    } else {
      this.stage1.up(input, this.mid, n)
      this.stage2.up(this.mid, this.high, 2 * n)
    }
    return this.high
  }

  /**
   * Downsample the high-rate buffer (modified in place by the caller) back to
   * `n` base-rate samples, written into `output`.
   */
  down(output, n) {
    if (this.factor === 2) {
      this.stage1.down(this.high, output, n)
    } else {
      this.stage2.down(this.high, this.mid, 2 * n)
      this.stage1.down(this.mid, output, n)
    }
  }
}

/**
 * A whole-sample delay line, for holding a signal back to match the
 * oversampler's latency.
 *
 * The compressors need two of these: the dry side of the wet/dry blend has to
 * arrive alongside the processed side or a parallel setting combs, and the gain
 * envelope — computed at the base rate — has to be held back to meet the audio
 * where it emerges inside the oversampled section.
 */
export class DelayLine {
  constructor(length) {
    this.length = length
    this.buffer = new Float64Array(Math.max(1, length))
    this.pos = 0
  }

  reset() {
    this.buffer.fill(0)
    this.pos = 0
  }

  /** Push one sample, return the sample `length` pushes ago. */
  push(x) {
    if (this.length === 0) return x
    const out = this.buffer[this.pos]
    this.buffer[this.pos] = x
    this.pos = this.pos + 1 === this.length ? 0 : this.pos + 1
    return out
  }
}
