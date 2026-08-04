/**
 * Resonance Suppressor — worklet kernel.
 *
 * A realtime port of the server's `resonanceSuppressor` stage
 * (server/scripts/resonance_suppressor.py). Soothe-style dynamic suppression:
 * per STFT frame, build a reference envelope that sits at the inter-harmonic
 * floor, treat whatever protrudes above it as a resonance, and duck it.
 *
 * This file is BOTH a normal ES module (exports ResonanceKernel and
 * processResonanceBuffer) AND an AudioWorklet module (registers
 * 'resonance-processor').
 *
 * THE ALGORITHM IS ALREADY CAUSAL. That is the whole reason this port is
 * possible without an analysis pass. Per frame:
 *
 *   1. magnitude in dB
 *   2. cepstral lifter → reference envelope at the inter-harmonic floor
 *   3. spike = magnitude − envelope, thresholded at `selectivity`, soft-kneed,
 *      scaled by `depth`, clipped to `maxReductionDb`
 *   4. harmonic-protected bins zeroed, Gaussian spread along the bin axis,
 *      zeroed again, out-of-band zeroed
 *   5. per-bin attack/release IIR at the frame rate
 *   6. gain applied to the complex spectrum, inverse FFT, overlap-add
 *
 * The 1394-line Python is mostly machinery this port does not need: multi-pass
 * chains, `sibilant_only` gating, band-summary reporting, and the pitch
 * transition detector (a ±5-frame lookahead that would cost another 58 ms of
 * latency and is outside the core parameter set).
 *
 * HARMONIC PROTECTION IS NOT OPTIONAL. Cepstral liftering puts the reference at
 * the inter-harmonic floor, so vocal harmonics protrude above it and read as
 * resonances. Without the mask the suppressor eats the voice — the server
 * refuses to run the stage at all when `preserve_harmonics` is on and no F0 is
 * available. Here F0Tracker supplies a per-frame pitch, which is what makes the
 * mask possible live.
 *
 * THREE APPROXIMATIONS vs. the server, all consequences of streaming:
 *
 *   - Lifter cutoff comes from a rolling median pitch rather than the whole
 *     file's median.
 *   - Voicing comes from the pitch tracker's correlation gate plus an absolute
 *     energy floor, in place of Silero labels. Non-voiced frames get a zero
 *     target so the IIR decays through them.
 *   - The cepstral reference is computed over the full spectrum rather than the
 *     server's band-restricted variant. Band restriction exists for passes with
 *     a very small lifter cutoff (L≈3, the sibilant-only passes), where the
 *     kept coefficients collapse onto the band mean; at the cutoffs this
 *     parameter set produces (L≈150–300) it makes little difference, and the
 *     band-restricted transform length is not a power of two. Detection and
 *     reduction are still band-limited — only the reference differs, and only
 *     for frequency ranges much narrower than the default 40 Hz–20 kHz.
 */

import { StftProcessor } from './dsp/stft.js'
import { F0Tracker } from './dsp/f0.js'
import { getFFT } from './dsp/fft.js'

const FFT_SIZE = 2048
const HOP_SIZE = 512

/** Matches `eps` in resonance_suppressor.py's process(). */
const MAG_EPS = 1e-10

/** Lifter cutoff before any pitch has been measured. */
const DEFAULT_F0_HZ = 60

// Harmonic protection geometry — DEFAULT_PARAMS in resonance_suppressor.py.
const HARMONIC_WIDTH_BINS = 2
const HARMONIC_WIDTH_PCT = 0.01
const MAX_HARMONIC = 100

/** Bound the per-pitch mask cache so a long session cannot grow it forever. */
const MASK_CACHE_LIMIT = 256

/**
 * Absolute energy floor for the voicing decision, in dB of frame mean-square.
 *
 * Voicing is decided by F0Tracker's correlation-ratio gate, which already
 * rejects noise and silence; this only stops the tracker chasing a pitch in
 * near-silence. It is deliberately absolute rather than relative to a measured
 * noise floor: a floor tracker rises toward the signal, so on continuous speech
 * with no silence in it the floor converges on the speech level and the gate
 * never opens at all.
 */
const VOICING_FLOOR_DB = -60

export const RESONANCE_KERNEL_DEFAULTS = {
  depth: 0.67,
  sharpness: 0.8,
  selectivity: 8,
  attackMs: 15,
  releaseMs: 80,
  maxReductionDb: 36,
  freqFloorHz: 40,
  freqCeilHz: 20000,
  mode: 'soft', // 'soft' | 'hard'
  preserveHarmonics: true,
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export class ResonanceKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.binCount = (FFT_SIZE >>> 1) + 1
    this.binWidth = sampleRate / FFT_SIZE
    this.frameRateMs = (HOP_SIZE / sampleRate) * 1000

    this.fft = getFFT(FFT_SIZE)
    this.f0 = new F0Tracker({
      sampleRate,
      frameSize: FFT_SIZE,
      defaultF0: DEFAULT_F0_HZ,
    })

    // One STFT per channel. Detection runs on channel 0 and the resulting gain
    // is applied to every channel: a spectral cut computed independently per
    // channel would move the stereo image around on correlated material, and
    // for mono — what narrators actually record — it is identical to the
    // server either way.
    this.stfts = []

    const bins = this.binCount
    this.magDb = new Float64Array(bins)
    this.envDb = new Float64Array(bins)
    this.cepstrum = new Float64Array(FFT_SIZE)
    this.envRe = new Float64Array(bins)
    this.envIm = new Float64Array(bins)
    this.reduction = new Float64Array(bins)
    this.spread = new Float64Array(bins)
    this.prevGr = new Float64Array(bins)
    this.gain = new Float64Array(bins)
    this.activeBins = new Uint8Array(bins)

    this.maskCache = new Map()
    this.currentMask = null

    this.frameIndex = 0

    // Metering — peak reduction seen since the last read.
    this.maxReductionSeen = 0

    // Bound once so the hot path passes a stable reference rather than
    // allocating a closure per block.
    this._analyzeAndApply = (re, im, bins) => {
      this._analyzeFrame(re, im)
      this._applyGain(re, im, bins)
    }
    this._applyGain = (re, im, bins) => {
      const g = this.gain
      for (let k = 0; k < bins; k++) {
        re[k] *= g[k]
        im[k] *= g[k]
      }
    }

    this.params = { ...RESONANCE_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Algorithmic latency, in samples. Reported to the offline apply path. */
  get latencySamples() {
    return FFT_SIZE
  }

  /** Merge a partial param update and recompute derived state. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    this.depth = clamp(p.depth, 0, 1)
    this.selectivity = Math.max(0, p.selectivity)
    this.maxReductionDb = Math.max(0, p.maxReductionDb)
    this.softKnee = p.mode !== 'hard'
    this.kneeWidth = Math.max(this.selectivity * 0.5, 1e-6)
    this.preserveHarmonics = !!p.preserveHarmonics

    const nyquist = this.sampleRate / 2
    this.freqFloorHz = clamp(p.freqFloorHz, 0, nyquist)
    this.freqCeilHz = clamp(p.freqCeilHz, this.freqFloorHz, nyquist)
    for (let k = 0; k < this.binCount; k++) {
      const f = k * this.binWidth
      this.activeBins[k] = f >= this.freqFloorHz && f <= this.freqCeilHz ? 1 : 0
    }

    // Gaussian spread kernel, width set by sharpness.
    // spread_bins = int(30 * (1 - sharpness)); sigma = spread_bins / 3.
    const sharpness = clamp(p.sharpness, 0, 1)
    const spreadBins = Math.trunc(30 * (1 - sharpness))
    if (spreadBins >= 2) {
      const sigma = spreadBins / 3
      const half = spreadBins
      const kernel = new Float64Array(2 * half + 1)
      let peak = 0
      for (let i = -half; i <= half; i++) {
        const v = Math.exp(-0.5 * (i / sigma) ** 2)
        kernel[i + half] = v
        if (v > peak) peak = v
      }
      for (let i = 0; i < kernel.length; i++) kernel[i] /= peak
      this.spreadKernel = kernel
      this.spreadHalf = half
    } else {
      this.spreadKernel = null
      this.spreadHalf = 0
    }

    // Attack/release at the frame rate: exp(-frame_period / tau).
    this.attackCoeff = p.attackMs > 0
      ? Math.exp(-this.frameRateMs / p.attackMs)
      : 0
    this.releaseCoeff = p.releaseMs > 0
      ? Math.exp(-this.frameRateMs / p.releaseMs)
      : 0

    // Harmonic geometry changed, so cached masks no longer apply.
    this.maskCache.clear()
  }

  reset() {
    for (const s of this.stfts) s.reset()
    this.f0.reset()
    this.prevGr.fill(0)
    this.frameIndex = 0
    this.maskCache.clear()
  }

  /**
   * Boolean protection mask for one pitch: bins belonging to a harmonic of f0.
   * Cached per rounded pitch, as the Python does.
   */
  _harmonicMask(f0) {
    if (!f0 || f0 <= 0) return null
    const key = Math.round(f0)
    const cached = this.maskCache.get(key)
    if (cached) return cached

    if (this.maskCache.size >= MASK_CACHE_LIMIT) this.maskCache.clear()

    const mask = new Uint8Array(this.binCount)
    const nyquist = this.sampleRate / 2
    for (let h = 1; h <= MAX_HARMONIC; h++) {
      const freq = h * f0
      if (freq > this.freqCeilHz || freq >= nyquist) break
      const center = Math.round(freq / this.binWidth)
      const pctHalf = Math.round((freq * HARMONIC_WIDTH_PCT) / this.binWidth)
      const half = Math.max(HARMONIC_WIDTH_BINS, pctHalf)
      const lo = Math.max(0, center - half)
      const hi = Math.min(this.binCount - 1, center + half)
      for (let k = lo; k <= hi; k++) mask[k] = 1
    }
    this.maskCache.set(key, mask)
    return mask
  }

  /**
   * Cepstral reference envelope: treat the log-magnitude spectrum as a signal,
   * invert it, zero the high-quefrency middle (where the pitch peak and every
   * overtone live), and transform back. What is left sits at the inter-harmonic
   * floor rather than riding the harmonic peaks, so a resonance is visible at
   * its true prominence even when it sits next to a harmonic.
   */
  _cepstralEnvelope(lifterCutoff) {
    const { fft, magDb, cepstrum, envRe, envIm, envDb, binCount } = this

    fft.irfft(magDb, null, cepstrum)

    // Zero indices [L, FFT_SIZE - L] inclusive, matching
    // `liftered[:, L : n_fft - L + 1] = 0`.
    const L = Math.max(1, Math.min(lifterCutoff, FFT_SIZE >>> 1))
    for (let i = L; i <= FFT_SIZE - L; i++) cepstrum[i] = 0

    fft.rfft(cepstrum, envRe, envIm)
    for (let k = 0; k < binCount; k++) envDb[k] = envRe[k]
  }

  /** One analysis frame: measure, decide a per-bin gain, leave it in `gain`. */
  _analyzeFrame(specRe, specIm) {
    const {
      magDb, envDb, reduction, spread, prevGr, gain, activeBins, binCount,
      selectivity, depth, maxReductionDb, softKnee, kneeWidth,
    } = this

    for (let k = 0; k < binCount; k++) {
      const mag = Math.hypot(specRe[k], specIm[k])
      magDb[k] = 20 * Math.log10(mag + MAG_EPS)
    }

    // Pitch drives both the lifter cutoff and the protection mask, so it is
    // measured from the unwindowed frame the STFT kept for us.
    const raw = this.stfts[0].rawFrame
    let sumSq = 0
    for (let i = 0; i < FFT_SIZE; i++) sumSq += raw[i] * raw[i]
    const frameDb = 10 * Math.log10(sumSq / FFT_SIZE + 1e-20)

    const { f0, voiced } = this.f0.estimate(raw, frameDb > VOICING_FLOOR_DB)
    const medianF0 = this.f0.median ?? DEFAULT_F0_HZ

    // lifter_cutoff = max(20, int(0.40 * sr / f0))
    const lifterCutoff = medianF0 > 0
      ? Math.max(20, Math.trunc((0.4 * this.sampleRate) / medianF0))
      : 60

    this._cepstralEnvelope(lifterCutoff)

    const mask = this.preserveHarmonics && voiced ? this._harmonicMask(f0) : null

    // Spike detection → soft knee → depth → clip.
    for (let k = 0; k < binCount; k++) {
      if (!activeBins[k]) {
        reduction[k] = 0
        continue
      }
      const above = magDb[k] - envDb[k] - selectivity
      if (above <= 0) {
        reduction[k] = 0
        continue
      }
      const curve = softKnee && above < kneeWidth
        ? (above * above) / (2 * kneeWidth)
        : above
      const r = curve * depth
      reduction[k] = r > maxReductionDb ? maxReductionDb : r
    }

    // Harmonic protection, pre-spread: zero these before the kernel runs so a
    // harmonic's own prominence is never smeared into the gaps beside it.
    if (mask) {
      for (let k = 0; k < binCount; k++) if (mask[k]) reduction[k] = 0
    }

    // Gaussian spread along the bin axis.
    if (this.spreadKernel) {
      const kern = this.spreadKernel
      const half = this.spreadHalf
      for (let k = 0; k < binCount; k++) {
        let acc = 0
        const lo = Math.max(0, k - half)
        const hi = Math.min(binCount - 1, k + half)
        for (let j = lo; j <= hi; j++) acc += reduction[j] * kern[j - k + half]
        spread[k] = acc > maxReductionDb ? maxReductionDb : acc
      }
      // Post-spread: re-protect harmonics that neighbouring spikes bled into,
      // and hard-limit the reduction to the active band. Without a spread
      // kernel neither is needed — the pre-spread pass already zeroed the mask,
      // and the detection loop never wrote outside the active band.
      for (let k = 0; k < binCount; k++) {
        reduction[k] = (mask && mask[k]) || !activeBins[k] ? 0 : spread[k]
      }
    }

    // Non-voiced frames target zero, so the IIR decays through silence rather
    // than holding a cut across it.
    if (!voiced) reduction.fill(0)

    // Per-bin attack/release at the frame rate.
    const { attackCoeff, releaseCoeff } = this
    let frameMax = 0
    for (let k = 0; k < binCount; k++) {
      const target = reduction[k]
      const c = target >= prevGr[k] ? attackCoeff : releaseCoeff
      const v = c * prevGr[k] + (1 - c) * target
      prevGr[k] = v
      if (v > frameMax) frameMax = v
      gain[k] = Math.pow(10, -v / 20)
    }
    if (frameMax > this.maxReductionSeen) this.maxReductionSeen = frameMax

    this.frameIndex++
  }

  _ensureChannels(n) {
    while (this.stfts.length < n) {
      this.stfts.push(new StftProcessor({ fftSize: FFT_SIZE, hopSize: HOP_SIZE }))
    }
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels
   * @param {Float32Array[]} outputChannels
   * @param {number} n
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    this._ensureChannels(nOut)

    // Walk the block in pieces no longer than one hop, so at most one STFT
    // frame completes per piece. Channel 0 computes the gain for that frame and
    // the other channels reuse it; without the cap a block spanning two frames
    // would leave every channel but the first applying the LAST frame's gain to
    // both. Web Audio's 128-sample quantum never spans a frame, but the offline
    // path and any future caller are free to hand over larger blocks.
    let off = 0
    while (off < n) {
      const len = Math.min(HOP_SIZE, n - off)
      const whole = off === 0 && len === n
      for (let ch = 0; ch < nOut; ch++) {
        const source = inputChannels[ch < nIn ? ch : nIn - 1]
        const target = outputChannels[ch]
        this.stfts[ch].process(
          whole ? source : source.subarray(off, off + len),
          whole ? target : target.subarray(off, off + len),
          len,
          ch === 0 ? this._analyzeAndApply : this._applyGain,
        )
      }
      off += len
    }
  }

  /** Peak reduction since the last call, in dB. */
  readMetering() {
    const v = this.maxReductionSeen
    this.maxReductionSeen = 0
    return v
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 *
 * Note the output is delayed by `latencySamples` relative to the input, exactly
 * as the worklet's is — this returns the raw stream without trimming, so a
 * caller comparing against the worklet render sees the same thing.
 */
export function processResonanceBuffer(channelData, sampleRate, params = {}) {
  const kernel = new ResonanceKernel(sampleRate)
  kernel.setParams(params)

  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return { channelData: output, latencySamples: kernel.latencySamples }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  // ~21 ms at 44.1 kHz — enough for a smooth meter without flooding the port.
  const METER_INTERVAL_SAMPLES = 1024

  class ResonanceWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new ResonanceKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'reset') this.kernel.reset()
      }
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const output = outputs[0]
      if (!output || output.length === 0) return true

      const n = output[0].length
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0)
        return true
      }

      this.kernel.process(input, output, n)

      this.sinceMeter += n
      if (this.sinceMeter >= METER_INTERVAL_SAMPLES) {
        this.sinceMeter = 0
        this.port.postMessage({ type: 'gr', grDb: this.kernel.readMetering() })
      }
      return true
    }
  }

  registerProcessor('resonance-processor', ResonanceWorkletProcessor)
}
