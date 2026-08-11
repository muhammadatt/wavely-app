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
 * 2. OVERSAMPLING IS UNCONDITIONAL, where the Python's is gated.
 *
 *    The Python runs each band's nonlinearity at 2x whenever that band's
 *    effective drive reaches 0.5 (`_OVERSAMPLE_DRIVE_THRESHOLD`), which at
 *    default settings is the low band alone — mid and high sit at 0.2. This
 *    kernel oversamples all three, always.
 *
 *    Not gating is what keeps latency constant. The apply path trims a fixed
 *    number of samples, so a threshold that engaged as a knob crossed it would
 *    move the whole region on the timeline mid-drag. The Python's gate exists
 *    to save CPU in a batch job that has no such constraint.
 *
 *    Unconditional also means this side never aliases more than the server,
 *    at any setting — which the gated version could not promise. Where the
 *    Python skips a band, this one is slightly cleaner; where it oversamples,
 *    the two agree.
 *
 *    THIS FILE PREVIOUSLY DID NOT OVERSAMPLE AT ALL, on the strength of
 *    measurements that ran to 2 kHz and stopped. That was sound for narration,
 *    where the hard drive is on the low band and its harmonics have room below
 *    Nyquist. It does not hold for bright material. On a 12 kHz tone the second
 *    harmonic folded to 20.1 kHz at -50 dBc at defaults and -36 dBc at full
 *    drive fully wet; those are now -102 and -93.
 *
 *    On DENSE bright material the gain is smaller and worth stating honestly:
 *    2 to 4 dB in the audible band, because most of the non-harmonic energy
 *    there is real intermodulation between partials, which oversampling
 *    neither can nor should remove. What it removes is the folded part, which
 *    is concentrated above 16 kHz and improves by 16 to 25 dB. The audible-band
 *    win is largest on sparse bright sources — a cymbal ringing out, a bell, a
 *    synth tone — where there is little else to mask a folded partial.
 *
 *    The other half of that decision was that latency "would make this a
 *    latent effect and force delay compensation through the offline apply
 *    path". That machinery now exists and carries three other plugins.
 *
 *    Cost: about 5.9% of one core for stereo, against 2.2% before. Most of it
 *    is the three upsamplers. If that ever needs to come down, the low and mid
 *    bands are band-limited well below the transition and would be served by a
 *    much shorter filter than the high band needs.
 *
 * The band split stays at the base rate, as it is in the Python. That is not
 * incidental: designing the 500 Hz Butterworth at 2x instead moves its stopband
 * by 18 dB at 16 kHz, which would be a different effect, not a cleaner one.
 * Only the three transfer curves run high.
 */

import { lowpass, highpass, butterworthQs, BiquadCascade } from './dsp/biquad.js'
import { Oversampler, DelayLine, VOCAL_SAT_OVERSAMPLE } from './dsp/oversample.js'
import { RmsFollower } from './dsp/envelope.js'

export const VOCAL_SAT_LATENCY_SAMPLES = VOCAL_SAT_OVERSAMPLE.latencySamples

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

/** Per-channel filter, follower, and resampler state. */
class ChannelState {
  constructor(sampleRate) {
    const qs = butterworthQs(4)
    this.lp = new BiquadCascade(qs.length, 1)
    this.hp = new BiquadCascade(qs.length, 1)
    this.dryRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.wetRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.outRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)

    // One upsampler per band, because each band is filtered at the base rate
    // and only then taken up. The three saturated bands are summed while still
    // at the high rate, so a single downsampler serves all of them.
    this.upLow = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upMid = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upHigh = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.downWet = new Oversampler(VOCAL_SAT_OVERSAMPLE)

    // The blend `x + wetDry * wet` is a sample-accurate sum, so the dry side
    // has to wait for the wet side to come back down.
    this.dryLine = new DelayLine(VOCAL_SAT_OVERSAMPLE.latencySamples)
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
    const L = VOCAL_SAT_OVERSAMPLE.factor

    const { low: lowBuf, high: highBuf, mid: midBuf, wet: wetBuf } = this._scratch(n)

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const st = this.channels[ch]

      // Band split at the base rate, as in vocal_saturation.py:
      //   low  = sosfilt(sos_lp, audio)
      //   high = sosfilt(sos_hp, audio)
      //   mid  = audio - low - high      (complementary — sums back exactly)
      st.lp.process(input, lowBuf, n, 0)
      st.hp.process(input, highBuf, n, 0)
      for (let i = 0; i < n; i++) midBuf[i] = input[i] - lowBuf[i] - highBuf[i]

      // Up to the high rate one band at a time. Upsampling is linear, so the
      // three still sum back to the input there — the complementary split is
      // preserved, and each band meets its own transfer curve with room above
      // it for the harmonics that curve creates.
      const lowUp = st.upLow.up(lowBuf, n)
      const midUp = st.upMid.up(midBuf, n)
      const highUp = st.upHigh.up(highBuf, n)

      const sum = st.downWet.scratch(n)
      for (let j = 0; j < n * L; j++) {
        sum[j] =
          applyTransfer(lowUp[j] * lowDrive + bias, softness, bias) +
          applyTransfer(midUp[j] * midDrive + bias, softness, bias) +
          applyTransfer(highUp[j] * highDrive + bias, softness, bias)
      }
      st.downWet.down(wetBuf, n)

      // Level matching and the blend stay at the base rate, where the Python
      // does them. The dry side is delayed to meet the wet side.
      for (let i = 0; i < n; i++) {
        const x = st.dryLine.push(input[i])
        const wet = wetBuf[i]

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
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims. Constant at every setting — see the note at the top
   * about why the Python's per-band gate is not reproduced here.
   */
  get latencySamples() {
    return VOCAL_SAT_LATENCY_SAMPLES
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
      this._midBuf = new Float64Array(n)
      this._wetBuf = new Float64Array(n)
    }
    return {
      low: this._lowBuf, high: this._highBuf, mid: this._midBuf, wet: this._wetBuf,
    }
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
  return { channelData: output, latencySamples: kernel.latencySamples }
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
