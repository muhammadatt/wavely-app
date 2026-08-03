/**
 * Air Band — worklet kernel.
 *
 * A realtime port of the server's `airBoost` stage
 * (server/pipeline/airBoost.js), which models the Maag EQ4's Air Band as five
 * overlapping parametric bells plus a wide high shelf. The Maag shape is a
 * sigmoid on the log-frequency axis that transitions over roughly four
 * octaves, which no single shelf reproduces — the bells' skirts sum to it, and
 * the three negative bell gains pull the shelf's plateau down into the curve.
 *
 * This file is BOTH a normal ES module (exports AirBandKernel and
 * processAirBandBuffer) AND an AudioWorklet module (registers
 * 'air-band-processor' inside an AudioWorkletGlobalScope). Unlike the two
 * compressor kernels it imports from ../audio/dsp/, which is why its loader
 * pulls it through `?worker&url` — see airBandWorkletLoader.js.
 *
 * Deliberately NOT ported from the server stage:
 *
 *   - the sibilant mask (air_boost_masked.py), which needs a whole-file
 *     sibilance event map;
 *   - the predictive precut (air_boost_precut.py), which needs a corpus
 *     reference curve;
 *   - the ACX noise-floor compliance loop in computeAirBoostParams, which
 *     iteratively re-measures the file and steps `gainDb` down.
 *
 * All three are mastering-chain concerns that need whole-file analysis. What
 * remains is a pure, stateless-per-sample filter chain: six biquads whose
 * gains all scale from one knob. Zero latency.
 */

import { peaking, highShelf, BiquadCascade } from './dsp/biquad.js'

// Per-band gains are quoted at this plateau and scaled linearly from it, so
// the fitted constants below stay identical to server/pipeline/airBoost.js.
const REFERENCE_PLATEAU_DB = 12.5932

const BANDS = [
  // Parametric bells, Q = 0.5. The 2.4/4.8/9.6 kHz gains are negative: they
  // are corrective shaping that pulls the shelf's broad plateau down into the
  // Maag's slower sigmoid, not audible cuts. The summed response is
  // non-negative at every frequency.
  { freqHz: 600, type: 'bell', q: 0.5, gRef: -0.02733 },
  { freqHz: 1200, type: 'bell', q: 0.5, gRef: -0.30754 },
  { freqHz: 2400, type: 'bell', q: 0.5, gRef: -1.18676 },
  { freqHz: 4800, type: 'bell', q: 0.5, gRef: -0.90883 },
  { freqHz: 9600, type: 'bell', q: 0.5, gRef: 0.91883 },
  // Wide high shelf carrying the bulk of the lift. 3.023 octaves ≈ Q 0.4 —
  // far gentler than the S = 1 a stock BiquadFilterNode highshelf would give,
  // which is why the coefficients are built here rather than delegated.
  { freqHz: 14000, type: 'shelf', wOct: 3.023, gRef: 22.54678 },
]

export const AIR_BAND_KERNEL_DEFAULTS = {
  gainDb: 6, // matches the acx_audiobook preset's airBoost.gainDb
  outputGainDb: 0,
}

const LN10_OVER_20 = Math.LN10 / 20

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Band coefficients for a given air gain — shared with the curve display. */
export function airBandSections(sampleRate, gainDb) {
  const scale = gainDb / REFERENCE_PLATEAU_DB
  return BANDS.map(b =>
    b.type === 'bell'
      ? peaking(sampleRate, b.freqHz, b.q, b.gRef * scale, 'q')
      : highShelf(sampleRate, b.freqHz, b.wOct, b.gRef * scale, 'octaves'),
  )
}

export class AirBandKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.cascade = new BiquadCascade(BANDS.length, 2)
    this.params = { ...AIR_BAND_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and rebuild coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p
    this.gainDb = clamp(p.gainDb, 0, 24)
    this.cascade.setSections(airBandSections(this.sampleRate, this.gainDb))
    this.outputLin = Math.exp(p.outputGainDb * LN10_OVER_20)
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

    this.cascade.ensureChannels(nOut)

    const outputLin = this.outputLin
    for (let ch = 0; ch < nOut; ch++) {
      // Channels beyond the input count reuse the last one, matching the
      // convention in la2aProcessor.js / fet1176Processor.js.
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      this.cascade.process(input, out, n, ch)
      if (outputLin !== 1) {
        for (let i = 0; i < n; i++) out[i] *= outputLin
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by verification scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share the same code path.
 */
export function processAirBandBuffer(channelData, sampleRate, params = {}) {
  const kernel = new AirBandKernel(sampleRate)
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
  return { channelData: output }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class AirBandWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new AirBandKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
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
      return true
    }
  }

  registerProcessor('air-band-processor', AirBandWorkletProcessor)
}
