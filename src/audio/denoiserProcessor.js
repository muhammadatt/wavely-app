/**
 * Spectral Denoise — worklet kernel (prototype, browser-only, no server).
 *
 * Per STFT frame (2048 / 512, dsp/stft.js), against a noise profile learned
 * from room tone (dsp/spectralDenoise.js):
 *
 *   γ  = |X|² / (N · threshold)                     a posteriori SNR
 *   ξ  = α·Â²_prev/N' + (1−α)·max(γ−1, 0), ≥ ξmin   decision-directed a priori
 *   G  = MMSE-LSA(ξ, γ)                              Ephraim–Malah 1985
 *   G  → smoothed across frequency and time, but only where a LOCAL SNR
 *        (±~350 Hz) says noise dominates                         Smoothing
 *   G' = floor + (1 − floor)·G                       Reduction (dB of floor)
 *
 * G' multiplies every channel's spectrum. On more than one channel the gain is
 * DECIDED on the channel mean, the same signal the profile is learned from, so
 * the image never moves (the Reso Tame kernel's linked-detection pattern).
 * Without a profile the kernel is a pure delay of `latencySamples`.
 *
 * This file is BOTH a normal ES module and an AudioWorklet module (registers
 * 'denoiser-processor'); it imports ./dsp/, so its loader goes through
 * `?worker&url`.
 */

import { StftProcessor } from './dsp/stft.js'
import { rfftBinCount } from './dsp/fft.js'
import {
  DENOISE_FFT_SIZE, DENOISE_HOP_SIZE, DD_ALPHA, XI_MIN, lsaGain,
  DENOISE_DISPLAY_BANDS, displayBandMap,
} from './dsp/spectralDenoise.js'

export const DENOISER_LATENCY_SAMPLES = DENOISE_FFT_SIZE

/** Half-width of the local-SNR window that decides where smoothing acts: ±16 bins ≈ ±344 Hz at 44.1 kHz. */
const LOCAL_BINS = 16

/**
 * Pre-roll the apply path renders ahead of the region: the decision-directed
 * estimate remembers ~1 / (1 − α) = 50 frames (0.6 s), and the time smoothing a
 * few more.
 */
export const DENOISER_PREROLL_S = 1

export const DENOISER_KERNEL_DEFAULTS = {
  profile: null, // Float32Array of |X|² per bin, or null = pass through
  reductionDb: 12, // depth of the gain floor
  thresholdDb: 3, // the profile is scaled by this before the gain rule
  smoothing: 50, // 0–100
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export class DenoiserKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.fftSize = DENOISE_FFT_SIZE
    this.hopSize = DENOISE_HOP_SIZE
    this.binCount = rfftBinCount(this.fftSize)
    const bins = this.binCount

    this.params = { ...DENOISER_KERNEL_DEFAULTS }
    this.noise = null // Float64Array, profile × threshold
    this.floor = 1
    this.timeCoef = 0
    this.smoothAmount = 0
    this.noisePrefix = null
    this.halfWidth = new Uint8Array(bins)

    this.prevClean = new Float64Array(bins) // Â² of the last frame
    this.rawGain = new Float64Array(bins)
    this.smoothGain = new Float64Array(bins)
    this.gain = new Float64Array(bins).fill(1) // what is applied
    this.prefix = new Float64Array(bins + 1)
    this.delta = false

    this.stfts = []
    this.detStft = null
    this.detMix = null

    // Metering: power-weighted reduction and display spectra since the last read.
    this.bandMap = displayBandMap(sampleRate, this.fftSize)
    this.meterIn = new Float64Array(DENOISE_DISPLAY_BANDS)
    this.meterOut = new Float64Array(DENOISE_DISPLAY_BANDS)
    this.meterBandCount = new Uint16Array(DENOISE_DISPLAY_BANDS)
    for (let k = 0; k < bins; k++) if (this.bandMap[k] >= 0) this.meterBandCount[this.bandMap[k]]++
    this.meterP = 0
    this.meterGP = 0
    this.meterFrames = 0

    this._decideAndApply = (re, im, n) => { this._decide(re, im, n); this._apply(re, im, n) }
    this._decideOnly = (re, im, n) => this._decide(re, im, n)
    this._applyOnly = (re, im, n) => this._apply(re, im, n)

    this.setParams({})
  }

  get latencySamples() {
    return this.fftSize
  }

  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const prof = p.profile
    if (prof && prof.length === this.binCount) {
      const t = 10 ** (clamp(p.thresholdDb, -12, 24) / 10)
      if (!this.noise) this.noise = new Float64Array(this.binCount)
      for (let k = 0; k < this.binCount; k++) this.noise[k] = Math.max(prof[k] * t, 1e-20)
    } else {
      this.noise = null
      this.gain.fill(1)
    }
    this.floor = 10 ** (-clamp(p.reductionDb, 0, 60) / 20)

    // Smoothing: across frequency, a box of ±h bins that widens above 1 / 4 kHz
    // (where musical noise lives and the ear resolves least); across time, a
    // one-pole on the gain at the frame rate. Both are faded out where the
    // voice is (see _decide): a gain box wider than the harmonic spacing (6.5
    // bins at 140 Hz) fills the valleys between harmonics with noise and
    // shaves the peaks — measured on a synthetic voice, smoothing applied
    // everywhere took the in-phrase error from −8.1 to −0.6 dB.
    const s = clamp(p.smoothing, 0, 100) / 100
    this.smoothAmount = s
    this.timeCoef = 0.7
    const hzPerBin = this.sampleRate / this.fftSize
    for (let k = 0; k < this.binCount; k++) {
      const hz = k * hzPerBin
      this.halfWidth[k] = hz < 1000 ? 2 : hz < 4000 ? 4 : 8
    }
    if (this.noise) {
      const np = this.noisePrefix && this.noisePrefix.length === this.binCount + 1
        ? this.noisePrefix : (this.noisePrefix = new Float64Array(this.binCount + 1))
      np[0] = 0
      for (let k = 0; k < this.binCount; k++) np[k + 1] = np[k] + this.noise[k]
    }
  }

  /** DELTA monitor: hear only what is removed. Never a param (see effects/denoiser.js). */
  setDelta(on) {
    this.delta = !!on
  }

  reset() {
    for (const s of this.stfts) s.reset()
    this.detStft?.reset()
    this.prevClean.fill(0)
    this.smoothGain.fill(0)
    this.gain.fill(1)
  }

  /** Compute this frame's gain from the detection spectrum. */
  _decide(re, im, bins) {
    const noise = this.noise
    // Display/meter input spectrum, gain or no gain.
    const P = this.rawGain // reused as scratch for |X|² before the gain pass
    for (let k = 0; k < bins; k++) P[k] = re[k] * re[k] + im[k] * im[k]

    if (!noise) {
      this._meter(P)
      return
    }

    const { prevClean, smoothGain, gain, prefix, halfWidth, floor, timeCoef, noisePrefix } = this
    const amount = this.smoothAmount
    const powers = this._powers || (this._powers = new Float64Array(bins))
    const powerPrefix = this._powerPrefix || (this._powerPrefix = new Float64Array(bins + 1))
    powers.set(P)
    powerPrefix[0] = 0
    for (let k = 0; k < bins; k++) powerPrefix[k + 1] = powerPrefix[k] + powers[k]

    // 1. MMSE-LSA per bin, decision-directed a priori SNR.
    for (let k = 0; k < bins; k++) {
      const n = noise[k]
      const gamma = powers[k] / n
      let xi = DD_ALPHA * (prevClean[k] / n) + (1 - DD_ALPHA) * Math.max(gamma - 1, 0)
      if (xi < XI_MIN) xi = XI_MIN
      const g = lsaGain(xi, gamma)
      P[k] = g
      prevClean[k] = g * g * powers[k]
    }

    // 2. Smoothing, weighted by how noise-dominated the neighbourhood is.
    prefix[0] = 0
    for (let k = 0; k < bins; k++) prefix[k + 1] = prefix[k] + P[k]
    for (let k = 0; k < bins; k++) {
      const g = P[k]
      let w = 0
      if (amount > 0) {
        // Local SNR over ±LOCAL_BINS: 2 dB or less → all noise (w = amount),
        // 10 dB or more → voice (w = 0), linear in dB between.
        const lo = k - LOCAL_BINS < 0 ? 0 : k - LOCAL_BINS
        const hi = k + LOCAL_BINS >= bins ? bins - 1 : k + LOCAL_BINS
        const snr = (powerPrefix[hi + 1] - powerPrefix[lo]) / (noisePrefix[hi + 1] - noisePrefix[lo])
        const snrDb = 10 * Math.log10(snr + 1e-30)
        const presence = snrDb <= 2 ? 0 : snrDb >= 10 ? 1 : (snrDb - 2) / 8
        w = amount * (1 - presence)
      }
      let target = g
      if (w > 0) {
        const h = halfWidth[k]
        const lo = k - h < 0 ? 0 : k - h
        const hi = k + h >= bins ? bins - 1 : k + h
        const box = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
        target = w * box + (1 - w) * g
      }
      // Time: the one-pole holds a pop-up bin down for a few frames in noise,
      // and lets go at once where the voice is (w = 0).
      const c = timeCoef * w
      const sm = c * smoothGain[k] + (1 - c) * target
      smoothGain[k] = sm
      gain[k] = floor + (1 - floor) * sm
    }

    this._meter(powers)
  }

  _meter(powers) {
    const { gain, bandMap, meterIn, meterOut } = this
    for (let k = 0; k < powers.length; k++) {
      const p = powers[k]
      const gp = gain[k] * gain[k] * p
      this.meterP += p
      this.meterGP += gp
      const b = bandMap[k]
      if (b >= 0) {
        meterIn[b] += p
        meterOut[b] += gp
      }
    }
    this.meterFrames++
  }

  _apply(re, im, bins) {
    const gain = this.gain
    if (this.delta) {
      for (let k = 0; k < bins; k++) {
        const g = 1 - gain[k]
        re[k] *= g
        im[k] *= g
      }
    } else if (this.noise) {
      for (let k = 0; k < bins; k++) {
        re[k] *= gain[k]
        im[k] *= gain[k]
      }
    }
  }

  _ensureChannels(nOut, nIn) {
    while (this.stfts.length < nOut) {
      this.stfts.push(new StftProcessor({ fftSize: this.fftSize, hopSize: this.hopSize }))
    }
    if (nIn > 1 && !this.detStft) {
      this.detStft = new StftProcessor({ fftSize: this.fftSize, hopSize: this.hopSize })
      this.detMix = new Float64Array(this.hopSize)
    }
  }

  /**
   * Process one block. Walked in pieces of at most one hop so a single frame
   * boundary falls in each piece — the gain decided there is the one every
   * channel applies (see ResonanceKernel.process).
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }
    this._ensureChannels(nOut, nIn)

    let off = 0
    while (off < n) {
      const len = Math.min(this.hopSize, n - off)
      if (this.detStft) {
        const mix = this.detMix
        const scale = 1 / nIn
        for (let i = 0; i < len; i++) {
          let acc = 0
          for (let ch = 0; ch < nIn; ch++) acc += inputChannels[ch][off + i]
          mix[i] = acc * scale
        }
        this.detStft.analyze(mix, len, this._decideOnly)
      }
      for (let ch = 0; ch < nOut; ch++) {
        const src = inputChannels[ch < nIn ? ch : nIn - 1]
        this.stfts[ch].process(
          src.subarray(off, off + len),
          outputChannels[ch].subarray(off, off + len),
          len,
          ch === 0 && !this.detStft ? this._decideAndApply : this._applyOnly,
        )
      }
      off += len
    }
  }

  /**
   * Metering since the last read: the power-weighted reduction in dB (≥ 0) and
   * the input / output spectra on the display grid (mean power per band per
   * frame, unconverted). Null when no frame completed.
   */
  readMeter(inOut, outOut) {
    if (this.meterFrames === 0) return null
    const reductionDb = this.meterP > 0 ? -10 * Math.log10(Math.max(this.meterGP, 1e-30) / this.meterP) : 0
    const frames = this.meterFrames
    for (let b = 0; b < this.meterIn.length; b++) {
      const count = this.meterBandCount[b]
      // A low band narrower than one bin holds none: borrow the band below
      // (or, for the first, the first band with a bin) rather than read silence.
      if (count === 0) {
        let src = b - 1
        if (src < 0) { src = 0; while (src < this.meterIn.length - 1 && this.meterBandCount[src] === 0) src++ }
        if (src < b) { inOut[b] = inOut[src]; outOut[b] = outOut[src]; continue }
        const c = Math.max(1, this.meterBandCount[src]) * frames
        inOut[b] = this.meterIn[src] / c
        outOut[b] = this.meterOut[src] / c
        continue
      }
      const c = count * frames
      inOut[b] = this.meterIn[b] / c
      outOut[b] = this.meterOut[b] / c
    }
    this.meterIn.fill(0)
    this.meterOut.fill(0)
    this.meterP = 0
    this.meterGP = 0
    this.meterFrames = 0
    return reductionDb
  }
}

/**
 * One-shot offline convenience for tests and scripts: a whole buffer through a
 * fresh kernel, UNTRIMMED (output lags input by latencySamples, as the
 * worklet's does). The app renders through an OfflineAudioContext instead.
 */
export function processDenoiserBuffer(channelData, sampleRate, params = {}) {
  const kernel = new DenoiserKernel(sampleRate)
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
  // ~46 ms at 44.1 kHz: four frames per post.
  const METER_INTERVAL_SAMPLES = 2048

  class DenoiserWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new DenoiserKernel(sampleRate)
      if (options?.processorOptions?.params) this.kernel.setParams(options.processorOptions.params)
      this.sinceMeter = 0
      this.inBands = new Float32Array(DENOISE_DISPLAY_BANDS)
      this.outBands = new Float32Array(DENOISE_DISPLAY_BANDS)
      this.port.onmessage = (e) => {
        const d = e.data
        if (d?.type === 'params') this.kernel.setParams(d.params)
        else if (d?.type === 'delta') this.kernel.setDelta(d.on)
        else if (d?.type === 'reset') this.kernel.reset()
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
        const reductionDb = this.kernel.readMeter(this.inBands, this.outBands)
        if (reductionDb !== null) {
          this.port.postMessage({ type: 'meter', reductionDb, inBands: this.inBands, outBands: this.outBands })
        }
      }
      return true
    }
  }

  registerProcessor('denoiser-processor', DenoiserWorkletProcessor)
}
