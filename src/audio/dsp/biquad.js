/**
 * RBJ biquad coefficients and a direct-form II transposed processor.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Two deliberate choices about parameterisation:
 *
 * 1. Width is expressed the way FFmpeg's `af_biquads.c` expresses it ('q',
 *    'octaves' or 'slope'), because several preset constants in this codebase
 *    were fitted against FFmpeg's realisation. The Maag air-band shelf in
 *    server/pipeline/airBoost.js is declared as `width_type=o, w=3.023`, and
 *    its per-band gains come out of fit_airboost_bands.py — so reproducing the
 *    octave→alpha conversion is what makes those constants transfer unchanged.
 *
 * 2. Shelves are built here rather than delegated to Web Audio's
 *    BiquadFilterNode, whose 'highshelf' ignores Q and hard-codes slope S = 1.
 *    The Maag shelf is ~3 octaves wide (Q ≈ 0.4) — far gentler than S = 1 — so
 *    the stock node would visibly change the curve, not merely round it off.
 *
 * Coefficients are returned pre-normalised by a0, in the shape
 * `{ b0, b1, b2, a1, a2 }`, so the difference equation is
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */

/** Convert a bandwidth in octaves to an equivalent Q (RBJ cookbook). */
export function octavesToQ(octaves) {
  const s = Math.sinh((Math.LN2 / 2) * octaves)
  return s === 0 ? Infinity : 1 / (2 * s)
}

/** Convert a Q to an equivalent bandwidth in octaves. */
export function qToOctaves(q) {
  return (2 / Math.LN2) * Math.asinh(1 / (2 * q))
}

/**
 * FFmpeg's width → alpha mapping.
 * @param {number} w0 normalised angular frequency
 * @param {number} width
 * @param {'q'|'octaves'|'slope'} widthType
 * @param {number} A linear amplitude sqrt(gain); only used by 'slope'
 */
function alphaFor(w0, width, widthType, A) {
  const sinW0 = Math.sin(w0)
  switch (widthType) {
    case 'q':
      return sinW0 / (2 * width)
    case 'octaves':
      // Guard w0/sin(w0) at DC where sin(w0) → 0.
      return sinW0 * Math.sinh(((Math.LN2 / 2) * width * w0) / (sinW0 || 1e-20))
    case 'slope':
      return (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / width - 1) + 2)
    default:
      throw new Error(`unknown widthType: ${widthType}`)
  }
}

function normalise(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Parametric peaking (bell) filter. Matches FFmpeg `equalizer`. */
export function peaking(sampleRate, freqHz, width, gainDb, widthType = 'q') {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = alphaFor(w0, width, widthType, A)
  return normalise(
    1 + alpha * A, -2 * cosW0, 1 - alpha * A,
    1 + alpha / A, -2 * cosW0, 1 - alpha / A,
  )
}

/** High-shelf. Matches FFmpeg `highshelf`. */
export function highShelf(sampleRate, freqHz, width, gainDb, widthType = 'q') {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = alphaFor(w0, width, widthType, A)
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
  return normalise(
    A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha),
    -2 * A * (A - 1 + (A + 1) * cosW0),
    A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha),
    A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha,
    2 * (A - 1 - (A + 1) * cosW0),
    A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha,
  )
}

/** Low-shelf. Matches FFmpeg `lowshelf`. */
export function lowShelf(sampleRate, freqHz, width, gainDb, widthType = 'q') {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = alphaFor(w0, width, widthType, A)
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
  return normalise(
    A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha),
    2 * A * (A - 1 - (A + 1) * cosW0),
    A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha),
    A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha,
    -2 * (A - 1 + (A + 1) * cosW0),
    A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha,
  )
}

export function lowpass(sampleRate, freqHz, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const b1 = 1 - cosW0
  return normalise(b1 / 2, b1, b1 / 2, 1 + alpha, -2 * cosW0, 1 - alpha)
}

export function highpass(sampleRate, freqHz, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const b0 = (1 + cosW0) / 2
  return normalise(b0, -(1 + cosW0), b0, 1 + alpha, -2 * cosW0, 1 - alpha)
}

/**
 * Constant-skirt-gain bandpass (RBJ, peak gain = Q).
 *
 * Only used for solo monitoring in the manual EQ, where the point is to hear
 * one band's region in isolation rather than to filter the signal path. The
 * constant-peak-gain variant would normalise the peak to unity and make a
 * narrow solo far quieter than a wide one; constant skirt gain keeps the
 * comparison between bands honest.
 */
export function bandpass(sampleRate, freqHz, q) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return normalise(alpha, 0, -alpha, 1 + alpha, -2 * cosW0, 1 - alpha)
}

export function notch(sampleRate, freqHz, q) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  return normalise(1, -2 * cosW0, 1, 1 + alpha, -2 * cosW0, 1 - alpha)
}

/**
 * Exact algebraic inverse of a normalised biquad: `H⁻¹(z) = 1 / H(z)`.
 *
 * For any `H(z) = (b0+b1z⁻¹+b2z⁻²) / (1+a1z⁻¹+a2z⁻²)`, the reciprocal is just
 * numerator and denominator swapped — `(1+a1z⁻¹+a2z⁻²) / (b0+b1z⁻¹+b2z⁻²)` —
 * renormalised so its own denominator's leading coefficient is 1. That swap is
 * exact for any biquad; it is not particular to shelving filters. What makes it
 * *usable* as a de-emphasis stage is that the result is only stable when the
 * original filter's zeros lie inside the unit circle (minimum phase) — see
 * `biquadZerosInsideUnitCircle`, meant to be checked before trusting this.
 *
 * Used by the soft clipper's de-emphasis stage: pre-emphasis is an RBJ high
 * shelf, and its inverse via this function is exact by construction rather
 * than a second shelf fitted to look like a cut.
 */
export function invertBiquad(c) {
  const { b0, b1, b2, a1, a2 } = c
  const invB0 = 1 / b0
  return {
    b0: invB0,
    b1: a1 * invB0,
    b2: a2 * invB0,
    a1: b1 * invB0,
    a2: b2 * invB0,
  }
}

/**
 * Whether a normalised biquad's ZEROS lie strictly inside the unit circle —
 * i.e. whether `invertBiquad(c)` would be stable.
 *
 * The zeros of `b0 + b1z⁻¹ + b2z⁻²` (as a function of z) are the roots of
 * `b0·z² + b1·z + b2 = 0`. Solved directly rather than via `Math.hypot` on a
 * generic complex root finder — this only ever runs at coefficient-update
 * time, not per sample, so clarity wins over cleverness.
 */
export function biquadZerosInsideUnitCircle(c) {
  const { b0, b1, b2 } = c
  if (b0 === 0) return false
  const A = b0, B = b1, C = b2
  const disc = B * B - 4 * A * C
  if (disc >= 0) {
    const sqrtDisc = Math.sqrt(disc)
    const r1 = (-B + sqrtDisc) / (2 * A)
    const r2 = (-B - sqrtDisc) / (2 * A)
    return Math.abs(r1) < 1 && Math.abs(r2) < 1
  }
  // Complex conjugate pair: both roots share the same magnitude, and their
  // product is C/A (the constant term over the leading coefficient) —
  // standard result for a monic-normalised quadratic's roots.
  return Math.sqrt(Math.abs(C / A)) < 1
}

/**
 * Q values for the biquad sections of a Butterworth cascade.
 *
 * `scipy.signal.butter(N, ..., output='sos')` produces ceil(N/2) sections; for
 * even N every section is a biquad with these Q values. Used by the vocal
 * saturation band split, which is `butter(4, ...)` → two sections.
 */
export function butterworthQs(order) {
  if (order % 2 !== 0) {
    throw new Error(`butterworthQs supports even orders only, got ${order}`)
  }
  const qs = []
  for (let k = 0; k < order / 2; k++) {
    qs.push(1 / (2 * Math.cos(((2 * k + 1) * Math.PI) / (2 * order))))
  }
  return qs
}

/**
 * Direct-form II transposed biquad cascade with per-channel state.
 *
 * DF-II-T is the standard choice for float audio: lower roundoff noise than
 * DF-I at the same cost, and only two state words per section per channel.
 */
export class BiquadCascade {
  /**
   * @param {number} sectionCount
   * @param {number} channelCount
   */
  constructor(sectionCount, channelCount = 1) {
    this.sectionCount = sectionCount
    this.channelCount = channelCount
    this.coeffs = new Float64Array(sectionCount * 5) // b0,b1,b2,a1,a2 per section
    // z1/z2 per section per channel, section-major.
    this.z1 = new Float64Array(sectionCount * channelCount)
    this.z2 = new Float64Array(sectionCount * channelCount)
  }

  /** Install coefficients for one section. Does not disturb filter state. */
  setSection(index, c) {
    const o = index * 5
    this.coeffs[o] = c.b0
    this.coeffs[o + 1] = c.b1
    this.coeffs[o + 2] = c.b2
    this.coeffs[o + 3] = c.a1
    this.coeffs[o + 4] = c.a2
  }

  /** Install every section from an array of coefficient objects. */
  setSections(sections) {
    if (sections.length !== this.sectionCount) {
      throw new Error(
        `expected ${this.sectionCount} sections, got ${sections.length}`,
      )
    }
    for (let i = 0; i < sections.length; i++) this.setSection(i, sections[i])
  }

  reset() {
    this.z1.fill(0)
    this.z2.fill(0)
  }

  /**
   * Grow the per-channel state to hold at least `n` channels, preserving the
   * state of channels that already exist.
   *
   * Worklet kernels do not learn their channel count until the first
   * `process()` call, and it can change if the graph is rewired, so the
   * cascade has to be able to widen in place.
   */
  ensureChannels(n) {
    if (n <= this.channelCount) return
    const z1 = new Float64Array(this.sectionCount * n)
    const z2 = new Float64Array(this.sectionCount * n)
    for (let s = 0; s < this.sectionCount; s++) {
      for (let c = 0; c < this.channelCount; c++) {
        z1[s * n + c] = this.z1[s * this.channelCount + c]
        z2[s * n + c] = this.z2[s * this.channelCount + c]
      }
    }
    this.z1 = z1
    this.z2 = z2
    this.channelCount = n
  }

  /**
   * Filter `n` samples of one channel in place (or into `output`).
   * @param {ArrayLike<number>} input
   * @param {{[i:number]: number}} output may alias `input`
   * @param {number} n
   * @param {number} channel
   */
  process(input, output, n, channel = 0) {
    const { sectionCount, channelCount, coeffs, z1, z2 } = this
    for (let i = 0; i < n; i++) {
      let x = input[i]
      for (let s = 0; s < sectionCount; s++) {
        const o = s * 5
        const si = s * channelCount + channel
        const y = coeffs[o] * x + z1[si]
        z1[si] = coeffs[o + 1] * x - coeffs[o + 3] * y + z2[si]
        z2[si] = coeffs[o + 2] * x - coeffs[o + 4] * y
        x = y
      }
      output[i] = x
    }
  }
}

/** |H(e^jw)|² of one normalised biquad section at a given frequency. */
export function sectionResponseSq(c, freqHz, sampleRate) {
  const w = (2 * Math.PI * freqHz) / sampleRate
  const cosW = Math.cos(w)
  const cos2W = Math.cos(2 * w)
  const { b0, b1, b2, a1, a2 } = c
  const num =
    b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * cosW + 2 * b0 * b2 * cos2W
  const den = 1 + a1 * a1 + a2 * a2 + 2 * (a1 + a1 * a2) * cosW + 2 * a2 * cos2W
  return num / den
}

/**
 * Magnitude response of a cascade, in dB, at each requested frequency.
 * Drives the EQ curve overlay and makes filter design testable without audio.
 *
 * @param {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>} sections
 * @param {ArrayLike<number>} freqsHz
 * @param {number} sampleRate
 * @returns {Float64Array}
 */
export function magnitudeResponseDb(sections, freqsHz, sampleRate) {
  const out = new Float64Array(freqsHz.length)
  for (let i = 0; i < freqsHz.length; i++) {
    let hSq = 1
    for (const s of sections) hSq *= sectionResponseSq(s, freqsHz[i], sampleRate)
    out[i] = 10 * Math.log10(Math.max(hSq, 1e-300))
  }
  return out
}
