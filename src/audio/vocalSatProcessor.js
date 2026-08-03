/**
 * Vocal Saturation — worklet kernel.
 *
 * A realtime port of server/scripts/vocal_saturation.py: a complementary
 * three-band split, a blended tanh/arctan transfer with per-band drive, and a
 * gain-neutral parallel blend back against the dry signal.
 *
 * This file is BOTH a normal ES module (exports VocalSatKernel and
 * processVocalSatBuffer) AND an AudioWorklet module (registers
 * 'vocal-sat-processor'). It imports from ./dsp/, so its loader pulls it
 * through `?worker&url` — see vocalSatWorkletLoader.js.
 *
 * Two deliberate deviations from the Python, both consequences of the fact
 * that a streaming effect cannot see the whole file:
 *
 * 1. LEVEL MATCHING. The Python normalises twice against whole-file RMS —
 *    `wet *= dry_rms/wet_rms` then `output *= dry_rms/out_rms`. Here each of
 *    those three measurements is a one-pole follower (RMS_TAU_MS). The
 *    structure is identical; the values track programme level instead of being
 *    constant over the file. Followers are primed from the first sample so the
 *    opening of a region is not under-normalised.
 *
 * 2. NO OVERSAMPLING. The Python runs the nonlinearity at 2x via a 15-tap
 *    Kaiser half-band whenever a band's effective drive reaches 0.5 — at
 *    default settings the low band runs at 10 — relying on resample_poly to
 *    compensate group delay internally. A streaming 2x up/down pair costs
 *    exactly 7 samples of latency at the base rate, which would make this a
 *    latent effect and force delay compensation through the offline apply path.
 *
 *    Measured cost of leaving it out (test/dsp/vocalSat.test.js, bin-centred
 *    tones so spectral leakage is not mistaken for aliasing): alias-to-signal
 *    is -91.8 dB at defaults, -87.2 dB on a 122 Hz tone, -92.6 dB even at
 *    drive 5, and -79.1 dB fully wet. All far below audibility, so the effect
 *    stays genuinely zero-latency at no practical cost. Revisit only if a
 *    future band runs a much harder curve.
 */

import { lowpass, highpass, butterworthQs, BiquadCascade } from './dsp/biquad.js'
import { RmsFollower } from './dsp/envelope.js'

export const VOCAL_SAT_KERNEL_DEFAULTS = {
  drive: 2.0,
  wetDry: 0.3,
  bias: 0.5,
  softness: 0.3,
  lowCrossover: 500,
  midCrossover: 3500,
  lowDriveMult: 5.0,
  midDriveMult: 0.1,
  highDriveMult: 0.1,
}

/**
 * Time constant for the three level-matching followers. Long enough not to
 * pump on syllables, short enough to track a change of delivery.
 */
const RMS_TAU_MS = 300

// Matches the `+ 1e-8` in vocal_saturation.py's _rms, and keeps the two
// divisions below finite through silence.
const RMS_FLOOR = 1e-8

const TWO_OVER_PI = 2 / Math.PI

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Blended tanh/arctan transfer with the bias operating point removed.
 * Direct port of `_apply_transfer`.
 */
function applyTransfer(pre, softness, bias) {
  if (softness <= 0) return Math.tanh(pre) - Math.tanh(bias)
  if (softness >= 1) return TWO_OVER_PI * (Math.atan(pre) - Math.atan(bias))
  const yTanh = Math.tanh(pre)
  const yAtan = TWO_OVER_PI * Math.atan(pre)
  const biasRef =
    (1 - softness) * Math.tanh(bias) + softness * TWO_OVER_PI * Math.atan(bias)
  return (1 - softness) * yTanh + softness * yAtan - biasRef
}

/** Per-channel filter and follower state. */
class ChannelState {
  constructor(sampleRate) {
    const qs = butterworthQs(4)
    this.lp = new BiquadCascade(qs.length, 1)
    this.hp = new BiquadCascade(qs.length, 1)
    this.dryRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.wetRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.outRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
  }
}

export class VocalSatKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.butterQs = butterworthQs(4)
    this.channels = []
    this.params = { ...VOCAL_SAT_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived state. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const nyquist = this.sampleRate / 2
    this.lowCrossover = clamp(p.lowCrossover, 20, nyquist * 0.98)
    this.midCrossover = clamp(p.midCrossover, this.lowCrossover + 1, nyquist * 0.98)

    // butter(4, ...) → two biquad sections; sosfilt is causal, so a direct
    // cascade matches it.
    this.lpSections = this.butterQs.map(q => lowpass(this.sampleRate, this.lowCrossover, q))
    this.hpSections = this.butterQs.map(q => highpass(this.sampleRate, this.midCrossover, q))
    for (const c of this.channels) {
      c.lp.setSections(this.lpSections)
      c.hp.setSections(this.hpSections)
    }

    this.softness = clamp(p.softness, 0, 1)
    this.bias = p.bias
    this.wetDry = Math.max(0, p.wetDry)
    this.lowDrive = p.drive * p.lowDriveMult
    this.midDrive = p.drive * p.midDriveMult
    this.highDrive = p.drive * p.highDriveMult
  }

  _ensureChannels(n) {
    while (this.channels.length < n) {
      const c = new ChannelState(this.sampleRate)
      c.lp.setSections(this.lpSections)
      c.hp.setSections(this.hpSections)
      this.channels.push(c)
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

    const { softness, bias, wetDry, lowDrive, midDrive, highDrive } = this

    const { low: lowBuf, high: highBuf } = this._scratch(n)

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const st = this.channels[ch]

      // Band split, as in vocal_saturation.py:
      //   low  = sosfilt(sos_lp, audio)
      //   high = sosfilt(sos_hp, audio)
      //   mid  = audio - low - high      (complementary — sums back exactly)
      st.lp.process(input, lowBuf, n, 0)
      st.hp.process(input, highBuf, n, 0)

      for (let i = 0; i < n; i++) {
        const x = input[i]
        const low = lowBuf[i]
        const high = highBuf[i]
        const mid = x - low - high

        const wet =
          applyTransfer(low * lowDrive + bias, softness, bias) +
          applyTransfer(mid * midDrive + bias, softness, bias) +
          applyTransfer(high * highDrive + bias, softness, bias)

        const dryRms = st.dryRms.process(x)
        const wetRms = st.wetRms.process(wet)

        // wet *= dry_rms / wet_rms
        const wetMatched = wet * (dryRms / wetRms)
        // output = audio + wet_dry * wet
        const blended = x + wetDry * wetMatched
        // output *= dry_rms / out_rms
        const outRms = st.outRms.process(blended)
        const y = blended * (dryRms / outRms)

        out[i] = y > 1 ? 1 : y < -1 ? -1 : y
      }
    }
  }

  /**
   * Band scratch buffers, grown on demand. Float64 so the complementary
   * subtraction `mid = x - low - high` does not lose precision before the
   * nonlinearity sees it. Channels are processed sequentially, so one pair
   * serves all of them.
   */
  _scratch(n) {
    if (!this._lowBuf || this._lowBuf.length < n) {
      this._lowBuf = new Float64Array(n)
      this._highBuf = new Float64Array(n)
    }
    return { low: this._lowBuf, high: this._highBuf }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by verification scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share the same code path.
 */
export function processVocalSatBuffer(channelData, sampleRate, params = {}) {
  const kernel = new VocalSatKernel(sampleRate)
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
  class VocalSatWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new VocalSatKernel(sampleRate)
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

  registerProcessor('vocal-sat-processor', VocalSatWorkletProcessor)
}
