/**
 * Scheps Parallel — worklet kernel.
 *
 * Andrew Scheps' vocal trick, as one effect: a Pultec EQP-1A push into an LA-2A
 * into a second Pultec that roughly undoes the push, the whole thing blended
 * back against the untouched signal.
 *
 *   dry ─────────────────────── delay ────────────────┐
 *                                                     ├─ equal-power mix ─ out
 *   wet ─ Pultec(pre) ─ OptoSmooth(+makeup) ─ Pultec(post) ─┘
 *
 * WHAT THE PRE STAGE IS FOR. It is not a tone control. Cutting the lows before
 * the compressor takes the plosives and the chest thump out of the sidechain,
 * so the opto cell stops ducking the whole voice every time a "p" lands; the
 * 8 kHz lift does the same in reverse, handing the cell the presence band so it
 * rides that instead. The LA-2A's own R37 trimmer is pinned fully counter-
 * clockwise here for the same reason, and it is the single setting the trick is
 * named for.
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
import { BiquadCascade, highpass, lowpass } from './dsp/biquad.js'
import { pultecSections, PULTEC_STAGES } from './dsp/pultec.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * LA-2A settings the trick fixes, and why none of them is on the panel.
 *
 * `r37: 0` is the trick: the trimmer wound fully counter-clockwise, which is
 * what "turn the HF knob all the way up" means on a unit whose factory position
 * is clockwise and flat. `mode: 'compress'` because this is levelling, not
 * limiting. `mix: 1` because the parallel blend is ours, not the compressor's.
 *
 * `gainDb` is NOT here: the wet path's makeup is handed to the compressor as
 * its own Gain, in `setParams` below. It used to be pinned to zero with the
 * makeup applied after the post EQ instead, which was the wrong stage. On the
 * hardware the Gain knob feeds the output amplifier and the second Pultec sits
 * after it, so makeup drives the tube rather than bypassing it — measured at
 * about 1 dB more harmonic content, which is small because our post EQ is a
 * linear biquad cascade with no gain stage of its own to be driven. The reason
 * to get it right anyway is structural: the makeup now flows through the
 * compressor's own machinery, so every change to how OptoSmooth computes makeup
 * reaches this plugin instead of having to be mirrored into it.
 */
const LA2A_FIXED = {
  mode: 'compress',
  r37: 0,
  tubeDrive: 0.3,
  mix: 1,
}

export const SCHEPS_KERNEL_DEFAULTS = {
  character: 'thick', // 'thick' | 'presence'
  /**
   * Drives the LA-2A's Peak Reduction, 0–100. Parallel compression wants far
   * more of this than a series insert would — the squashed copy is a layer, not
   * the signal.
   *
   * Set high because the side-chain arrives twice-filtered: the pre EQ takes
   * ~4.7 dB out of the lows and R37 fully counter-clockwise takes 10 dB more
   * below 1 kHz, so
   * the cell is looking at far less than the raw signal. On speech at nominal
   * level this lands around 7 dB of gain reduction on the wet path; the same
   * number on the Opto Comp panel, with a flat side-chain, would be about 13.
   */
  squash: 80,
  mix: 0.35, // 0–1 wet
  /**
   * The wet path's makeup, handed to the compressor as its own Gain — so it
   * sits before the tube stage and before the post EQ, where the hardware puts
   * it. Measured by computeSchepsAutoTrim. Zero means unmeasured, not "no
   * makeup needed".
   */
  wetTrimDb: 0,
  /**
   * Zero-lag correlation between the dry signal and the level-matched wet one,
   * -1 to 1, also from computeSchepsAutoTrim. Corrects the mix law — see
   * `_updateMix`. Zero gives a textbook equal-power crossfade.
   */
  correlation: 0,
  /**
   * How much louder the wet copy's average is than the dry one's once its loud
   * parts are level — the compression's yield, from computeSchepsAutoTrim. The
   * mix law passes it through instead of flattening it, so Mix gently raises
   * loudness. Zero means unmeasured.
   */
  densityDb: 0,
  outputDb: 0, // manual trim on the summed output
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Clamp, but reject anything that is not a finite number.
 *
 * Params reach this kernel over a message port from UI state, so one undefined
 * or NaN is always one bug away — and since the makeup is now the compressor's
 * own Gain, a NaN no longer stays local. It enters the T4 cell's envelope and
 * memory, which are persistent, and the kernel then outputs NaN forever: the
 * effect goes silent and stays silent until the page is reloaded. Measured
 * exactly that way — one bad push, then twenty blocks of good params, still all
 * non-finite.
 *
 * `clamp` alone cannot catch it: `undefined < lo` and `undefined > hi` are both
 * false, so it returns undefined unchanged.
 */
function finite(v, fallback, lo, hi) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback
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
export function mixGains(mix, correlation = 0, densityDb = 0) {
  const theta = finite(mix, 0, 0, 1) * (Math.PI / 2)
  const dry = Math.cos(theta)
  const wet = Math.sin(theta)
  const rho = finite(correlation, 0, -0.98, 0.98)
  const r = Math.exp(finite(densityDb, 0, -12, 12) * LN10_OVER_20)

  // What the sum WOULD be if the two paths were independent. This is the target
  // rather than unity, and the difference is the point: the wet copy is louder
  // on average than the dry one by `densityDb`, because its loud parts were
  // pulled down and handed back. That gain is the compression's yield and has
  // to survive the blend — flattening it is what left the plugin unable to make
  // anything louder.
  const target = dry * dry + r * r * wet * wet
  // What it actually is, with the interference term the correlation creates.
  const actual = target + 2 * rho * r * dry * wet
  const compensation = Math.sqrt(target / Math.max(actual, 1e-6))
  // `r` shapes the compensation only. It is not applied as a gain: the wet path
  // is ALREADY that much louder on average, because the trim put its loud parts
  // level and compression raised everything underneath them. Multiplying by it
  // here would count the same density twice.
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
      peakReduction: finite(p.squash, SCHEPS_KERNEL_DEFAULTS.squash, 0, 100),
      // The wet path's makeup, at the stage the hardware puts it — before the
      // tube, after the cell, and therefore before the post EQ.
      gainDb: finite(p.wetTrimDb, 0, -36, 36),
      // Measurement mode propagates through: with oversampling off the whole
      // wet path is latency-free, and the dry delay below follows it to zero.
      oversample: p.oversample !== false,
    })

    this.outputLin = Math.exp(finite(p.outputDb, 0, -24, 24) * LN10_OVER_20)
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
    const { dry, wet, compensation } = mixGains(
      this.params.mix, this.params.correlation, this.params.densityDb,
    )
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

    const { dryGain, wetGain, outputLin } = this
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const w = wet[ch]
      const out = outputChannels[ch]
      this.postEq.process(w, w, n, ch)

      const line = this.dryLines[ch]
      for (let i = 0; i < n; i++) {
        // Read the dry sample before writing the output, so an in-place caller
        // (input and output the same array) still works.
        const dry = line.push(src[i])
        out[i] = (dry * dryGain + w[i] * wetGain) * outputLin
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
 * Render the wet path alone — pre EQ, compressor at the given makeup, post EQ,
 * no blend. Separate from `process` because the measurement needs the wet
 * signal before it is mixed with anything.
 */
function renderWetPath(channelData, sampleRate, params, wetTrimDb = 0) {
  const kernel = new SchepsKernel(sampleRate)
  kernel.setParams({
    ...params,
    mix: 1,
    correlation: 0,
    wetTrimDb,
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
 * Speech band, in Hz, for the trim measurement — see `speechWeight`.
 */
const SPEECH_BAND_HZ = [300, 4000]

/**
 * Band-limit a copy of a signal to the speech range, for measurement only.
 *
 * BROADBAND RMS CANNOT MEASURE A VOICE'S LOUDNESS, and the failure is not
 * marginal. Measured on a real narrator recording: **81% of the file's total
 * energy sits between 125 and 500 Hz**, and 2–8 kHz carries **1.6%**. So a
 * broadband RMS match is, to within a rounding error, a match of the
 * fundamental region alone — which is the one part of the spectrum Thick's net
 * curve raises. The trim therefore read "already loud enough" while the entire
 * intelligibility range came out 3 dB down, and the file sounded quieter with
 * the meters saying it was level.
 *
 * K-weighting is not enough to fix it: its shelf is +4 dB above 1.7 kHz, and on
 * a band carrying 1.6% of the energy that moved the answer by 0.34 dB against a
 * 3 dB deficit. Measured, not assumed.
 *
 * A flat band-pass over the speech range is blunt, but it puts the measurement
 * where the ear decides loudness for a voice, and it is explicable in one line —
 * which a weighting curve fitted to this one recording would not be.
 */
function speechWeight(x, sampleRate) {
  const cascade = new BiquadCascade(2, 1)
  cascade.setSections([
    highpass(sampleRate, SPEECH_BAND_HZ[0], Math.SQRT1_2),
    lowpass(sampleRate, Math.min(SPEECH_BAND_HZ[1], sampleRate * 0.45), Math.SQRT1_2),
  ])
  const y = new Float32Array(x.length)
  cascade.process(x, y, x.length, 0)
  return y
}

/**
 * Level of the LOUD PARTS: the 95th percentile of 100 ms block levels, in dB.
 *
 * This is what makeup gain has always been referenced to, and it is not the
 * same as the average. A compressor earns loudness by pulling the loud moments
 * down and then handing back roughly what it took: the loud parts land back
 * where they started, everything quieter comes up by the full makeup, and the
 * average rises. Restoring the AVERAGE instead gives back only what was lost on
 * average, which by construction leaves the file exactly as loud as it started
 * — a compressor that cannot make anything louder.
 *
 * Blocks more than 40 dB below the loudest are dropped, so pauses and room tone
 * cannot drag the percentile down on a sparsely-voiced take.
 */
function loudPartDb(x, sampleRate) {
  const W = Math.round(sampleRate * 0.1)
  if (x.length < W * 4) {
    // Too short to have a level distribution; fall back to plain RMS.
    let s = 0
    for (let i = 0; i < x.length; i++) s += x[i] * x[i]
    return 10 * Math.log10(s / Math.max(1, x.length) + 1e-30)
  }
  const blocks = []
  for (let off = 0; off + W <= x.length; off += W) {
    let s = 0
    for (let i = 0; i < W; i++) s += x[off + i] * x[off + i]
    blocks.push(10 * Math.log10(s / W + 1e-30))
  }
  const loudest = Math.max(...blocks)
  const voiced = blocks.filter(v => v > loudest - 40)
  voiced.sort((a, b) => a - b)
  return voiced[Math.floor((voiced.length - 1) * 0.95)]
}

/**
 * Measure the three numbers the blend needs from the audio itself.
 *
 * `trimDb` is the wet-path makeup: the gain that puts the compressed copy's
 * LOUD PARTS back where the dry signal's are. See `loudPartDb` for why the loud
 * parts and not the average — matching the average is what made this plugin
 * incapable of making anything louder, which is not what a compressor is for.
 *
 * `densityDb` is what that buys: how much louder the wet copy's average is than
 * the dry one's, once its loud parts are level. It is the compression's actual
 * yield, and it is modest here — 0.6 to 0.8 dB on real speech — because an opto
 * cell with a multi-second release applies nearly constant gain reduction
 * rather than selectively ducking peaks. A fast peak compressor would hand back
 * far more. The mix law passes this through rather than flattening it, so
 * pushing Mix does gently increase loudness, which is the whole point of
 * blending a compressed copy in.
 *
 * ALL THREE ARE MEASURED IN THE SPEECH BAND, not broadband — see `speechWeight`
 * for the measurement that forced that. Broadband energy is free to rise faster
 * than `densityDb`, because the character adds weight underneath the voice, and
 * making that weight pay for itself out of the midrange is what went wrong
 * before.
 *
 * `correlation` is the zero-lag Pearson correlation between dry and wet, in the
 * same band, so the mix law's compensation holds the same quantity the trim
 * does — see `mixGains`.
 *
 * All are measured over the region the user has selected, so they follow the
 * material rather than a table of assumptions about it.
 */
export function computeSchepsAutoTrim(channelData, sampleRate, params = {}) {
  const dryBand = channelData.map(c => speechWeight(c, sampleRate))
  const dryLoudDb = loudPartDb(dryBand[0], sampleRate)

  let dryEnergy = 0
  for (const d of dryBand) for (let i = 0; i < d.length; i++) dryEnergy += d[i] * d[i]
  if (dryEnergy <= 0) return { trimDb: 0, correlation: 0, densityDb: 0 }

  // ITERATED, because the makeup is now the compressor's own Gain and that sits
  // BEFORE the tube stage, as on the hardware. Raising it drives the tube a
  // little harder, which moves the output level, so each pass re-measures at
  // the corrected operating point. Same reason and the same shape as
  // computeAutoMakeupDb; two passes is normally enough.
  let trimDb = 0
  let wet = null
  for (let pass = 0; pass < 4; pass++) {
    const rendered = renderWetPath(channelData, sampleRate, params, trimDb)
    wet = rendered.map(c => speechWeight(c, sampleRate))
    const wetLoudDb = loudPartDb(wet[0], sampleRate)
    if (!Number.isFinite(wetLoudDb)) break
    const correctionDb = dryLoudDb - wetLoudDb
    trimDb = clamp(trimDb + correctionDb, -24, 24)
    if (Math.abs(correctionDb) < 0.05) break
  }

  let wetEnergy = 0
  let crossEnergy = 0
  for (let ch = 0; ch < dryBand.length; ch++) {
    const d = dryBand[ch]
    const w = wet[ch]
    for (let i = 0; i < d.length; i++) {
      wetEnergy += w[i] * w[i]
      crossEnergy += d[i] * w[i]
    }
  }
  if (wetEnergy <= 0) return { trimDb: 0, correlation: 0, densityDb: 0 }

  // The rendered wet path ALREADY carries the makeup, so the density is the
  // straight energy ratio — no trim term to add back, unlike when the makeup
  // was a separate multiply after the post EQ.
  const densityDb = clamp(10 * Math.log10(wetEnergy / dryEnergy), -12, 12)
  // Scaling by a positive gain cannot change a normalised correlation.
  const correlation = clamp(crossEnergy / Math.sqrt(dryEnergy * wetEnergy), -1, 1)
  return { trimDb, correlation, densityDb }
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
