/**
 * Streaming STFT / overlap-add framework.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Mirrors the framing convention the Python spectral stages use
 * (resonance_suppressor.py, air_boost_masked.py, analyze_sibilance_events.py):
 * n_fft = 2048, hop = 512, periodic Hann, overlap-add normalised by the
 * accumulated window² rather than by a constant. Normalising by the actual
 * accumulated window makes reconstruction exact at the signal edges too, which
 * is what `window_accumulator` does in resonance_suppressor.py.
 *
 * Latency is exactly `fftSize` samples: an output position is emitted only once
 * every frame overlapping it has been accumulated, and the last such frame does
 * not complete until fftSize further input samples have arrived. Callers must
 * report this through the effect descriptor so the offline apply path can trim
 * it and the bypass path can delay-match for A/B.
 */

import { getFFT, rfftBinCount } from './fft.js'

/** Periodic Hann window — matches scipy `get_window('hann', N, fftbins=True)`. */
export function hannPeriodic(size) {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  }
  return w
}

export class StftProcessor {
  /**
   * @param {object} opts
   * @param {number} [opts.fftSize=2048]
   * @param {number} [opts.hopSize=512]
   */
  constructor({ fftSize = 2048, hopSize = 512 } = {}) {
    if (fftSize % hopSize !== 0) {
      throw new Error('fftSize must be an integer multiple of hopSize')
    }
    this.fftSize = fftSize
    this.hopSize = hopSize
    this.binCount = rfftBinCount(fftSize)
    this.fft = getFFT(fftSize)
    this.window = hannPeriodic(fftSize)

    // Input side: circular buffer holding the most recent fftSize samples.
    this.inRing = new Float64Array(fftSize)
    this.inWrite = 0
    this.sinceHop = 0

    // Scratch, so steady-state processing allocates nothing.
    this.frame = new Float64Array(fftSize)
    this.specRe = new Float64Array(this.binCount)
    this.specIm = new Float64Array(this.binCount)

    // Overlap-add accumulators. Index 0 tracks the start of the current frame.
    this.ola = new Float64Array(fftSize)
    this.olaWin = new Float64Array(fftSize)

    // Output FIFO. Pre-loaded with one hop of silence so a pop is always
    // available before the first frame completes; combined with the frame
    // scheduling this yields exactly fftSize samples of latency.
    this.outCap = fftSize + hopSize
    this.outRing = new Float64Array(this.outCap)
    this.outRead = 0
    this.outWrite = hopSize
    this.outCount = hopSize

    this.frameCount = 0
  }

  /** Algorithmic latency in samples. */
  get latencySamples() {
    return this.fftSize
  }

  reset() {
    this.inRing.fill(0)
    this.inWrite = 0
    this.sinceHop = 0
    this.ola.fill(0)
    this.olaWin.fill(0)
    this.outRing.fill(0)
    this.outRead = 0
    this.outWrite = this.hopSize
    this.outCount = this.hopSize
    this.frameCount = 0
  }

  /**
   * Push a block of input and pull the same number of output samples.
   *
   * `frameFn(specRe, specIm, binCount, ctx)` is invoked once per completed
   * frame and may modify the spectrum in place. Pass null for pass-through
   * (useful for measuring reconstruction error).
   *
   * @param {ArrayLike<number>} input
   * @param {{[i:number]: number}} output may alias `input`
   * @param {number} n
   * @param {((re:Float64Array, im:Float64Array, bins:number, self:StftProcessor)=>void)|null} frameFn
   */
  process(input, output, n, frameFn) {
    const { fftSize, hopSize } = this
    for (let i = 0; i < n; i++) {
      // Write input first, so a frame completing on this sample is pushed to
      // the FIFO before we pop — otherwise the FIFO underruns on the very
      // first frame boundary.
      this.inRing[this.inWrite] = input[i]
      this.inWrite = this.inWrite + 1 === fftSize ? 0 : this.inWrite + 1
      if (++this.sinceHop === hopSize) {
        this.sinceHop = 0
        this._processFrame(frameFn)
      }

      output[i] = this.outRing[this.outRead]
      this.outRead = this.outRead + 1 === this.outCap ? 0 : this.outRead + 1
      this.outCount--
    }
  }

  _processFrame(frameFn) {
    const { fftSize, hopSize, window, inRing, frame, ola, olaWin, specRe, specIm } =
      this

    // Gather the ring into linear order (oldest first) and window it.
    let r = this.inWrite // oldest sample sits at the write cursor
    for (let i = 0; i < fftSize; i++) {
      frame[i] = inRing[r] * window[i]
      r = r + 1 === fftSize ? 0 : r + 1
    }

    this.fft.rfft(frame, specRe, specIm)
    if (frameFn) frameFn(specRe, specIm, this.binCount, this)
    this.fft.irfft(specRe, specIm, frame)

    // Overlap-add, synthesis-windowed.
    for (let i = 0; i < fftSize; i++) {
      const w = window[i]
      ola[i] += frame[i] * w
      olaWin[i] += w * w
    }

    // Emit one hop: positions 0..hopSize are now fully accumulated.
    for (let i = 0; i < hopSize; i++) {
      const denom = olaWin[i]
      this.outRing[this.outWrite] = denom > 1e-12 ? ola[i] / denom : 0
      this.outWrite = this.outWrite + 1 === this.outCap ? 0 : this.outWrite + 1
      this.outCount++
    }

    // Slide the accumulators forward by one hop.
    ola.copyWithin(0, hopSize)
    ola.fill(0, fftSize - hopSize)
    olaWin.copyWithin(0, hopSize)
    olaWin.fill(0, fftSize - hopSize)

    this.frameCount++
  }
}
