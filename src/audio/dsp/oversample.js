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
 * A FIR history that pushes in O(1) and still reads contiguously.
 *
 * The obvious implementation — shift every element up by one on each new sample
 * — costs O(taps) per sample on top of the O(taps) convolution, which roughly
 * doubles the work in a loop that runs at four times the sample rate on every
 * channel. A plain circular buffer fixes the push but puts a modulo in the
 * inner loop, which is its own tax.
 *
 * So the buffer is stored twice, back to back, and every sample is written to
 * both copies. The write position walks backwards, which makes `buf[pos + j]`
 * the sample `j` pushes ago for any j in [0, length) with no wrapping test at
 * all: pos < length and j < length, so pos + j never leaves the doubled array.
 * The convolution reads a straight run of memory, which is also the layout a
 * prefetcher likes.
 */
class RingHistory {
  constructor(length) {
    this.length = length
    this.buf = new Float64Array(2 * length)
    this.pos = 0
  }

  reset() {
    this.buf.fill(0)
    this.pos = 0
  }

  push(x) {
    const p = this.pos === 0 ? this.length - 1 : this.pos - 1
    this.pos = p
    this.buf[p] = x
    this.buf[p + this.length] = x
  }
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

    // Histories read [pos + k] = the sample k pushes ago. Each is sized to the
    // deepest index its direction actually reaches: the up path wants
    // p1[0..M-1] and the even-branch delay at halfM; the down path wants the
    // even delay at halfM and the odd taps one step further back, at 1..M.
    this.upHist = new RingHistory(Math.max(M, this.halfM + 1))
    this.downEvenHist = new RingHistory(this.halfM + 1)
    this.downOddHist = new RingHistory(M + 1)
  }

  reset() {
    this.upHist.reset()
    this.downEvenHist.reset()
    this.downOddHist.reset()
  }

  /**
   * Upsample `n` samples to `2n`.
   * @param {Float32Array|Float64Array} input
   * @param {Float64Array} output at least 2n long
   * @param {number} n
   */
  up(input, output, n) {
    const { p1, M, halfM, upHist } = this
    const buf = upHist.buf

    for (let i = 0; i < n; i++) {
      upHist.push(input[i])
      const base = upHist.pos

      // Even branch is a pure delay — the halfband's zero taps mean there is
      // nothing to compute here.
      output[2 * i] = buf[base + halfM]

      let acc = 0
      for (let j = 0; j < M; j++) acc += p1[j] * buf[base + j]
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
    const evenBuf = downEvenHist.buf
    const oddBuf = downOddHist.buf

    for (let i = 0; i < n; i++) {
      downEvenHist.push(input[2 * i])
      downOddHist.push(input[2 * i + 1])
      const evenBase = downEvenHist.pos
      const oddBase = downOddHist.pos + 1 // u_odd[i-1-j] is one further back

      let acc = 0.5 * evenBuf[evenBase + halfM]
      for (let j = 0; j < M; j++) acc += p1[j] * oddBuf[oddBase + j]
      output[i] = acc
    }
  }
}

/**
 * Build an oversampling profile: the filters for each stage plus the delays
 * they imply.
 *
 * Profiles exist because the two callers want different trade-offs from the
 * same machinery. A compressor's waveshaper needs a lot of headroom above the
 * band and does not care much what happens in the last kilohertz; an EQ is a
 * transparent path that has to hand back what it was given everywhere the user
 * can hear, so it wants a longer stage-1 filter and can settle for less
 * headroom. Encoding that as a profile keeps one implementation and lets each
 * caller state its own requirement.
 *
 * Stage 1 runs base↔2x and carries the burden: it must pass the audible band
 * and stop that band's image, reflected around the base sample rate. Stage 2,
 * where a profile uses one, runs 2x↔4x with a far wider relative transition and
 * is correspondingly short.
 *
 * Both tap counts must be ≡ 1 (mod 4) — see `halfbandTaps`. A 4x profile
 * additionally needs stage 2 ≡ 1 (mod 8), so its share of the upsample-path
 * delay lands on a whole base-rate sample; the constructor rejects anything
 * that would leave a fractional delay, since a control signal generated at the
 * base rate could then never be aligned exactly with the audio.
 */
function buildProfile({ name, factor, stage1Taps, stage1Beta, stage2Taps, stage2Beta }) {
  if (factor !== 2 && factor !== 4) {
    throw new Error(`oversampling factor must be 2 or 4, got ${factor}`)
  }
  const stage1H = halfbandTaps(stage1Taps, stage1Beta)
  const stage2H = factor === 4 ? halfbandTaps(stage2Taps, stage2Beta) : null

  const m1 = (stage1Taps - 1) / 2
  const m2 = factor === 4 ? (stage2Taps - 1) / 2 : 0
  // Each stage delays by M samples at the rate it outputs, so the upsample path
  // costs m1/2 + m2/4 base-rate samples and the downsample path the same again.
  const upsampleDelaySamples = factor === 4 ? m1 / 2 + m2 / 4 : m1 / 2
  if (!Number.isInteger(upsampleDelaySamples)) {
    throw new Error(
      `${name}: oversampler delays must be whole base-rate samples, got ${upsampleDelaySamples}`,
    )
  }

  return {
    name,
    factor,
    stage1H,
    stage2H,
    upsampleDelaySamples,
    latencySamples: 2 * upsampleDelaySamples,
  }
}

/**
 * Compressor profile: 4x, with a stage-1 filter that passes 20 kHz and stops
 * the image of 20 kHz at 24.1 kHz.
 *
 * The waveshapers want the headroom of 4x more than they want the last
 * kilohertz of passband, and their material — narration, at 44.1 kHz — has
 * essentially nothing above 20 kHz.
 */
export const COMPRESSOR_OVERSAMPLE = buildProfile({
  name: 'compressor',
  factor: 4,
  stage1Taps: 93,
  stage1Beta: 9.5,
  stage2Taps: 17,
  stage2Beta: 7.0,
})

/**
 * EQ profile: 2x, with a much longer stage-1 filter.
 *
 * The two differences from the compressor profile both follow from the EQ being
 * a linear path rather than a nonlinear one.
 *
 * 2x rather than 4x: there is no harmonic generation to contain. Oversampling
 * here only pushes Nyquist away so the bilinear transform stops compressing the
 * top of the response — "cramping". 2x brings a wide high-frequency bell to
 * within 0.3 dB of its analog prototype across 8-16 kHz, against 1.5 dB at the
 * base rate; 4x would reach 0.07 dB for nearly twice the cost, which is far
 * below what anyone can hear on a filter curve.
 *
 * A longer stage 1: every signal through the EQ passes the resampling filters,
 * so their passband edge becomes the plugin's. The compressor profile is 0.17 dB
 * down at 20 kHz and 2.3 dB down at 21 kHz, which was a fair trade for narration
 * and is not one for music with cymbals and air in it. 125 taps brings 20 kHz to
 * 0.006 dB.
 *
 * 125 rather than more: the tap count buys passband edge and nothing else, and
 * past this it is buying it above 20 kHz. 185 taps would hold 20.5 kHz flat too,
 * for twice this one's CPU and half again its latency — spent entirely above
 * the range anyone can hear.
 */
const TRANSPARENT_2X = buildProfile({
  name: 'transparent-2x',
  factor: 2,
  stage1Taps: 125,
  stage1Beta: 10.0,
})

export const EQ_OVERSAMPLE = TRANSPARENT_2X

/**
 * The vocal saturator's profile — deliberately the same object as the EQ's.
 *
 * It wants exactly what the EQ wants: enough headroom to keep a mild
 * nonlinearity's products from folding, and a passband transparent enough that
 * a bright source does not lose its top just by passing through. Sharing the
 * profile keeps one set of filter tables and one latency figure; if the two ever
 * need to diverge, split this into its own buildProfile call.
 */
export const VOCAL_SAT_OVERSAMPLE = TRANSPARENT_2X

/** Back-compatible aliases for the compressor kernels, which predate profiles. */
export const OVERSAMPLE_FACTOR = COMPRESSOR_OVERSAMPLE.factor
export const UPSAMPLE_DELAY_SAMPLES = COMPRESSOR_OVERSAMPLE.upsampleDelaySamples
export const OVERSAMPLE_LATENCY_SAMPLES = COMPRESSOR_OVERSAMPLE.latencySamples

/**
 * A per-channel oversampler: `up()` a block, do nonlinear work on it, `down()`
 * it again.
 *
 * Scratch buffers are owned per instance and grown on demand, so `process` does
 * no allocation once the block size settles.
 */
export class Oversampler {
  /** @param {object} profile one of the *_OVERSAMPLE profiles above */
  constructor(profile = COMPRESSOR_OVERSAMPLE) {
    this.profile = profile
    this.factor = profile.factor
    this.stage1 = new HalfbandStage(profile.stage1H)
    this.stage2 = profile.stage2H ? new HalfbandStage(profile.stage2H) : null
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
   * The high-rate scratch buffer, sized for `n` base-rate samples.
   *
   * For callers that assemble a high-rate signal from somewhere other than this
   * instance's own `up()` — the vocal saturator sums three separately
   * upsampled bands and then needs one downsample of the total — fill this and
   * call `down()`.
   */
  scratch(n) {
    this._ensure(n)
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
