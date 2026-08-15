/**
 * Scheps Parallel — worklet kernel.
 *
 * Andrew Scheps' vocal trick, as one effect: a Pultec EQP-1A push into an LA-2A
 * into a second Pultec that roughly undoes the push, the whole thing blended
 * back against the untouched signal.
 *
 *   dry ─────────────────────── delay ────────────────┐
 *                                                     ├─ equal-power mix ─ out
 *   wet ─ Pultec(pre) ─ OptoSmooth ─ Pultec(post) ─ trim ┘
 *
 * WHAT THE PRE STAGE IS FOR. It is not a tone control. Cutting the lows before
 * the compressor takes the plosives and the chest thump out of the sidechain,
 * so the opto cell stops ducking the whole voice every time a "p" lands; the
 * 8 kHz lift does the same in reverse, handing the cell the presence band so it
 * rides that instead. The LA-2A's own R37 emphasis is pinned wide open here for
 * the same reason — on the hardware that is the HF knob turned all the way up,
 * and it is the single setting the trick is named for.
 *
 * WHY THE POST STAGE IS NOT AN EXACT INVERSE. It is measured, not derived: the
 * curves in data/pultec_curves/ are what a passive EQP-1A actually does, and its
 * boost and cut at the same nominal frequency are different shapes. The net of
 * the two stages is therefore a real curve — Thick nets +4 dB at 30 Hz and
 * -4.6 dB at 20 kHz — and that residue is a large part of the sound. See
 * src/audio/dsp/pultec.js.
 *
 * WHY THE PARALLEL BLEND LIVES INSIDE THE KERNEL. The wet path is delayed by the
 * LA-2A's oversampling latency. Splitting the blend across two Web Audio nodes
 * would put an undelayed dry signal against a delayed wet one and comb-filter
 * the result — audibly, since the two are near-identical below 1 kHz. Here the
 * dry side runs through a delay line of exactly the compressor's latency, so the
 * two arrive sample-aligned, and the plugin reports that latency once for the
 * offline apply path to trim.
 *
 * This file is BOTH a normal ES module (exports SchepsKernel,
 * processSchepsBuffer and computeSchepsAutoTrim) AND an AudioWorklet module
 * (registers 'scheps-processor'). Its loader goes through `?worker&url` so Vite
 * bundles the DSP it imports — see schepsWorkletLoader.js.
 */

import { LA2AKernel } from './la2aProcessor.js'
import { DelayLine } from './dsp/oversample.js'
import { BiquadCascade } from './dsp/biquad.js'
import { pultecSections, PULTEC_STAGES } from './dsp/pultec.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * LA-2A settings the trick fixes, and why none of them is on the panel.
 *
 * `emphasis: 1` is the trick. `mode: 'compress'` because this is levelling, not
 * limiting. `gainDb: 0` because makeup here would drive the tube stage — the
 * Gain knob sits before it on the hardware — and the wet path already has a
 * measured trim after the post EQ, which is the right place for it. `mix: 1`
 * because the parallel blend is ours, not the compressor's.
 */
const LA2A_FIXED = {
  mode: 'compress',
  emphasis: 1,
  gainDb: 0,
  tubeDrive: 0.3,
  mix: 1,
}

export const SCHEPS_KERNEL_DEFAULTS = {
  character: 'thick', // 'thick' | 'presence'
  /**
   * Drives the LA-2A's Peak Reduction, 0–100. Parallel compression wants far
   * more of this than a series insert would — the squashed copy is a layer, not
   * the signal.
   */
  squash: 65,
  mix: 0.35, // 0–1 wet
  /**
   * Wet-path gain, applied after the post EQ and BEFORE the mix sums. Measured
   * by computeSchepsAutoTrim so that pushing Mix changes character rather than
   * loudness. Zero means unmeasured, not "no trim needed".
   */
  wetTrimDb: 0,
  /**
   * Zero-lag correlation between the dry signal and the level-matched wet one,
   * -1 to 1, also from computeSchepsAutoTrim. Corrects the mix law — see
   * `_updateMix`. Zero gives a textbook equal-power crossfade.
   */
  correlation: 0,
  outputDb: 0, // manual trim on the summed output
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Dry and wet gains for a mix position, plus the compensation that keeps the
 * sum's level constant across the whole sweep.
 *
 * Equal power (cos/sin) is the right law here and a linear blend is not: at the
 * halfway point a linear blend is 6 dB down on each path and audibly dips. But
 * equal power assumes the two paths are uncorrelated, and these two are the same
 * voice — below a kilohertz they are nearly the same waveform. Summing them at
 * cos/sin therefore lands up to 3 dB HOT in the middle of the sweep, which is
 * the same loudness bias the auto trim exists to remove, arriving by a different
 * door.
 *
 * With the wet path level-matched to the dry one, the sum's power is
 * `1 + rho*sin(2*theta)` — exactly 1 when the two are uncorrelated, and up to
 * `1 + rho` when they track each other. Dividing by its square root makes the
 * blend loudness-flat end to end for a measured rho, and degenerates to plain
 * equal power when rho is 0.
 *
 * Exported for the tests and the panel readout.
 */
export function mixGains(mix, correlation = 0) {
  const theta = clamp(mix, 0, 1) * (Math.PI / 2)
  const dry = Math.cos(theta)
  const wet = Math.sin(theta)
  const rho = clamp(correlation, -0.98, 0.98)
  // sin(2*theta) is 2*dry*wet; both are non-negative here, so the radicand
  // cannot go below 1 - 0.98 and needs no further guarding.
  const compensation = 1 / Math.sqrt(1 + rho * 2 * dry * wet)
  return { dry, wet, compensation }
}

export class SchepsKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.la2a = new LA2AKernel(sampleRate)

    this.preEq = null
    this.postEq = null
    this.dryLines = [] // one per channel, grown on demand
    this.wetScratch = []

    this.params = { ...SCHEPS_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and rebuild coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const character = PULTEC_STAGES[p.character] ? p.character : SCHEPS_KERNEL_DEFAULTS.character
    const pre = pultecSections(this.sampleRate, character, 'pre')
    const post = pultecSections(this.sampleRate, character, 'post')
    // Rebuilt rather than resized when the character changes: the two curves
    // can differ in section count, and a cascade's state is meaningless across
    // a topology change anyway.
    if (!this.preEq || this.preEq.sectionCount !== pre.length) {
      this.preEq = new BiquadCascade(pre.length, Math.max(1, this.dryLines.length))
    }
    if (!this.postEq || this.postEq.sectionCount !== post.length) {
      this.postEq = new BiquadCascade(post.length, Math.max(1, this.dryLines.length))
    }
    this.preEq.setSections(pre)
    this.postEq.setSections(post)

    this.la2a.setParams({
      ...LA2A_FIXED,
      peakReduction: clamp(p.squash, 0, 100),
      // Measurement mode propagates through: with oversampling off the whole
      // wet path is latency-free, and the dry delay below follows it to zero.
      oversample: p.oversample !== false,
    })

    this.wetTrimLin = Math.exp(clamp(p.wetTrimDb, -36, 36) * LN10_OVER_20)
    this.outputLin = Math.exp(clamp(p.outputDb, -24, 24) * LN10_OVER_20)
    this._updateMix()

    // The dry delay has to match the wet path's latency exactly; rebuild it if
    // the compressor's latency moved (it only does between measurement mode and
    // the audible path, which never happens on a running preview).
    const latency = this.la2a.latencySamples
    if (this.dryLatency !== latency) {
      this.dryLatency = latency
      this.dryLines = this.dryLines.map(() => new DelayLine(latency))
    }
  }

  _updateMix() {
    const { dry, wet, compensation } = mixGains(this.params.mix, this.params.correlation)
    this.dryGain = dry * compensation
    this.wetGain = wet * compensation
  }

  /** Algorithmic latency, in samples — the compressor's, since the EQs are IIR. */
  get latencySamples() {
    return this.la2a.latencySamples
  }

  /** Current gain reduction, in dB (positive). */
  getReduction() {
    return this.la2a.getMetering().grDb
  }

  _ensureChannels(count) {
    this.preEq.ensureChannels(count)
    this.postEq.ensureChannels(count)
    while (this.dryLines.length < count) this.dryLines.push(new DelayLine(this.dryLatency))
    while (this.wetScratch.length < count) this.wetScratch.push(new Float32Array(128))
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
    for (let ch = 0; ch < nOut; ch++) {
      if (this.wetScratch[ch].length < n) this.wetScratch[ch] = new Float32Array(n)
    }

    // Pre EQ into the wet scratch. Channels beyond the input count reuse the
    // last one, matching the convention in la2aProcessor.js.
    const wet = []
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const w = this.wetScratch[ch].subarray(0, n)
      this.preEq.process(src, w, n, ch)
      wet.push(w)
    }

    // One compressor across the whole wet bus: its detector is shared between
    // channels by design, so a stereo file's two sides move together.
    this.la2a.process(wet, wet, n)

    const { dryGain, wetGain, wetTrimLin, outputLin } = this
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const w = wet[ch]
      const out = outputChannels[ch]
      this.postEq.process(w, w, n, ch)

      const line = this.dryLines[ch]
      const wetScale = wetGain * wetTrimLin
      for (let i = 0; i < n; i++) {
        // Read the dry sample before writing the output, so an in-place caller
        // (input and output the same array) still works.
        const dry = line.push(src[i])
        out[i] = (dry * dryGain + w[i] * wetScale) * outputLin
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by the tests and by the trim measurement below; the app renders through
 * an OfflineAudioContext running the worklet, so preview and apply share the
 * same code path.
 */
export function processSchepsBuffer(channelData, sampleRate, params = {}) {
  const kernel = new SchepsKernel(sampleRate)
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

/**
 * Render the wet path alone — pre EQ, compressor, post EQ, no blend and no
 * trim. Separate from `process` because the measurement needs the wet signal
 * before it is mixed with anything.
 */
function renderWetPath(channelData, sampleRate, params) {
  const kernel = new SchepsKernel(sampleRate)
  kernel.setParams({
    ...params,
    mix: 1,
    correlation: 0,
    wetTrimDb: 0,
    outputDb: 0,
    // Base rate: the question is what the wet path's level and shape are, and
    // oversampling moves neither by anything measurable. It also makes the wet
    // output latency-free, so it lines up with the dry input sample for sample
    // — which the correlation below depends on.
    oversample: false,
  })

  const n = channelData[0].length
  const out = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      out.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return out
}

/**
 * Measure the two numbers the blend needs from the audio itself.
 *
 * `trimDb` is the wet-path gain that puts the compressed copy at the dry
 * signal's RMS. Without it the wet path arrives however loud the chain happens
 * to leave it — Thick's net curve alone is +4 dB in the low end — and the Mix
 * knob becomes a volume control, which decides an A/B before the user has heard
 * anything. RMS rather than peak: squashing peaks is the entire point of the
 * wet path, so peak matching would over-boost it badly.
 *
 * `correlation` is the zero-lag Pearson correlation between the dry signal and
 * the level-matched wet one. It is what makes the equal-power law hold for two
 * paths carrying the same voice — see `mixGains`.
 *
 * Both are measured over the region the user has selected, so they follow the
 * material rather than a table of assumptions about it.
 */
export function computeSchepsAutoTrim(channelData, sampleRate, params = {}) {
  const wet = renderWetPath(channelData, sampleRate, params)

  let dryEnergy = 0
  let wetEnergy = 0
  let crossEnergy = 0
  for (let ch = 0; ch < channelData.length; ch++) {
    const d = channelData[ch]
    const w = wet[ch]
    for (let i = 0; i < d.length; i++) {
      dryEnergy += d[i] * d[i]
      wetEnergy += w[i] * w[i]
      crossEnergy += d[i] * w[i]
    }
  }

  if (dryEnergy <= 0 || wetEnergy <= 0) return { trimDb: 0, correlation: 0 }

  // Trim is clamped to the same travel the panel's readout shows, so the value
  // in effect and the value displayed can never disagree.
  const trimDb = clamp(10 * Math.log10(dryEnergy / wetEnergy), -24, 24)
  // Scaling the wet path by a positive gain cannot change a normalised
  // correlation, so this is computed on the unscaled wet signal.
  const correlation = clamp(crossEnergy / Math.sqrt(dryEnergy * wetEnergy), -1, 1)
  return { trimDb, correlation }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class SchepsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SchepsKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
      }
      this.frame = 0
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

      // Gain reduction for the panel's meter, at roughly 60 Hz.
      this.frame += n
      if (this.frame >= 735) {
        this.frame = 0
        this.port.postMessage({ type: 'gr', grDb: this.kernel.getReduction() })
      }
      return true
    }
  }

  registerProcessor('scheps-processor', SchepsWorkletProcessor)
}
