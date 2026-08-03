/**
 * Radix-2 FFT with precomputed tables.
 *
 * Dependency-free by design: this module is imported by AudioWorklet kernels,
 * which are bundled into self-contained chunks via `?worker&url`. Nothing here
 * may reach for a DOM, Node, or Web Audio global.
 *
 * Why not reuse `fftInPlace` from server/pipeline/humEQ.js verbatim: that
 * implementation recomputes each butterfly's twiddle factor by repeated complex
 * multiplication, which both costs trig per call and accumulates rounding error
 * across long inner loops. The realtime path runs hundreds of transforms per
 * second, so twiddles and the bit-reversal permutation are precomputed once per
 * size and cached.
 *
 * Conventions match numpy so ports from the Python stages stay readable:
 *   - `rfft`  takes N real samples  → N/2+1 complex bins, unscaled
 *   - `irfft` takes N/2+1 complex bins → N real samples, scaled by 1/N
 */

const cache = new Map()

/** Get a memoized FFT instance for a power-of-two size. */
export function getFFT(size) {
  let fft = cache.get(size)
  if (!fft) {
    fft = new FFT(size)
    cache.set(size, fft)
  }
  return fft
}

export class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`)
    }
    this.size = size
    this.half = size >>> 1

    // Bit-reversal permutation table.
    this.rev = new Uint32Array(size)
    let j = 0
    for (let i = 1; i < size; i++) {
      let bit = size >>> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      this.rev[i] = j
    }

    // Twiddle tables, one contiguous block per stage.
    // Stage with half-length `h` occupies [offset, offset + h).
    this.cos = new Float64Array(size)
    this.sin = new Float64Array(size)
    let offset = 0
    for (let len = 2; len <= size; len <<= 1) {
      const h = len >>> 1
      const ang = (-2 * Math.PI) / len
      for (let k = 0; k < h; k++) {
        this.cos[offset + k] = Math.cos(ang * k)
        this.sin[offset + k] = Math.sin(ang * k)
      }
      offset += h
    }

    // Scratch for the real-input helpers, so steady-state processing allocates
    // nothing on the audio thread.
    this._re = new Float64Array(size)
    this._im = new Float64Array(size)
  }

  /**
   * In-place complex forward transform. No scaling.
   * @param {Float64Array} re length === size
   * @param {Float64Array} im length === size
   */
  forward(re, im) {
    const { size, rev, cos, sin } = this

    for (let i = 1; i < size; i++) {
      const j = rev[i]
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }

    let offset = 0
    for (let len = 2; len <= size; len <<= 1) {
      const h = len >>> 1
      for (let i = 0; i < size; i += len) {
        for (let k = 0; k < h; k++) {
          const wRe = cos[offset + k]
          const wIm = sin[offset + k]
          const a = i + k
          const b = a + h
          const vRe = re[b] * wRe - im[b] * wIm
          const vIm = re[b] * wIm + im[b] * wRe
          re[b] = re[a] - vRe
          im[b] = im[a] - vIm
          re[a] += vRe
          im[a] += vIm
        }
      }
      offset += h
    }
  }

  /**
   * In-place complex inverse transform, scaled by 1/size.
   * Implemented via the conjugate identity: ifft(x) = conj(fft(conj(x))) / N.
   */
  inverse(re, im) {
    const { size } = this
    for (let i = 0; i < size; i++) im[i] = -im[i]
    this.forward(re, im)
    const scale = 1 / size
    for (let i = 0; i < size; i++) {
      re[i] *= scale
      im[i] = -im[i] * scale
    }
  }

  /**
   * Real-input forward transform (numpy `rfft`).
   *
   * @param {ArrayLike<number>} input  length === size (shorter input is zero-padded)
   * @param {Float64Array} outRe  length >= size/2+1
   * @param {Float64Array} outIm  length >= size/2+1
   */
  rfft(input, outRe, outIm) {
    const { size, half, _re, _im } = this
    const n = Math.min(input.length, size)
    for (let i = 0; i < n; i++) _re[i] = input[i]
    for (let i = n; i < size; i++) _re[i] = 0
    _im.fill(0)

    this.forward(_re, _im)

    for (let k = 0; k <= half; k++) {
      outRe[k] = _re[k]
      outIm[k] = _im[k]
    }
  }

  /**
   * Real-output inverse transform (numpy `irfft`).
   *
   * Rebuilds the Hermitian-symmetric full spectrum from the half spectrum, so
   * bins above Nyquist do not need to be supplied. `inIm` may be null, which is
   * how the cepstral lifter uses it — a real-valued half spectrum inverts to a
   * real, symmetric sequence.
   *
   * @param {ArrayLike<number>} inRe  length >= size/2+1
   * @param {ArrayLike<number>|null} inIm  length >= size/2+1, or null for zeros
   * @param {Float64Array} output  length >= size
   */
  irfft(inRe, inIm, output) {
    const { size, half, _re, _im } = this

    for (let k = 0; k <= half; k++) {
      _re[k] = inRe[k]
      _im[k] = inIm ? inIm[k] : 0
    }
    // Hermitian mirror for bins above Nyquist.
    for (let k = half + 1; k < size; k++) {
      _re[k] = _re[size - k]
      _im[k] = -_im[size - k]
    }

    this.inverse(_re, _im)

    for (let i = 0; i < size; i++) output[i] = _re[i]
  }
}

/** Number of bins a real FFT of this size produces. */
export function rfftBinCount(size) {
  return (size >>> 1) + 1
}

/** Centre frequency of each rfft bin, in Hz (numpy `rfftfreq`). */
export function rfftFreqs(size, sampleRate) {
  const bins = rfftBinCount(size)
  const out = new Float64Array(bins)
  for (let k = 0; k < bins; k++) out[k] = (k * sampleRate) / size
  return out
}
