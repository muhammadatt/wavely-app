/**
 * VOCAL CHAIN — DYNAMICS SECTION, worklet kernel.
 *
 * The serial dynamics block of the client vocal chain
 * (`docs/instant_polish_vocal_chain_spec.md`), as ONE kernel:
 *
 *   in ─▶ Soft Clip ─▶ FET Punch ─▶ ┌─ dry ──── delay(50) ────────────────┐
 *         limiter 0     scHpf on    │                                     ├─ Mix ─▶
 *         (into the     (fast grab) └─ wet ─ Pultec pre ─ Opto ─ Pultec post ┘
 *          detectors)
 *
 * WHY THIS ORDER. The canonical 1176-into-LA-2A order, for the canonical
 * reason: the opto's attack is too slow to catch transients, so anything after
 * it still has to deal with them. Leading with the opto would have it level a
 * signal that still carries full peak range and leave the FET cleaning up.
 *
 * ⚠ THE CLIPPER IS NOT PEAK CONTROL HERE. It runs FIRST, and its job is to
 * shave the spikes so neither compressor's detector is triggered by transients
 * it cannot musically respond to — "clipping into the detectors". Peak control
 * belongs to the chain's delivery solve, which is why nothing in this kernel
 * holds a ceiling.
 *
 * ⚠ THE BLEND IS LOCAL TO THE OPTO BLOCK AND ITS DRY SIDE IS THE POST-FET
 * SIGNAL. A dry path running parallel to the whole section would mean a knob
 * position where nothing happens at all, which is not what a chain is. This way
 * Mix 0 is clip → FET with no opto and no Pultec — a real fast-and-dry voicing
 * — and the section is serial end to end.
 *
 * ⚠ IT HOLDS THE THREE KERNELS RATHER THAN COPYING THEM, the same arrangement
 * `schepsProcessor.js` uses and for the same reason: every module constant —
 * tapers, ballistics, cell and tube laws, the clipper's shape table — reaches
 * this composite with no conforming change.
 *
 * ⚠ AND IT REBUILDS SCHEPS' TOPOLOGY RATHER THAN NESTING SchepsKernel. Nesting
 * would mean two parallel blends and two delay lines, and would drag in an
 * output ceiling that sits at what is mid-chain here — precisely the mistake
 * Scheps' own source warns about for its embedded LA-2A.
 *
 * ⚠ EVERY STAGE MUST BE ALIGNED AT ITS OWN INPUT, NOT AT THE SECTION'S, AND
 * THAT CONSTRAINS THE SOLVE RATHER THAN THIS KERNEL.
 *
 * Both compressors drive a fixed internal threshold, so each needs its input
 * brought to nominal or its knob means nothing — see `dsp/inputAlign.js`. In a
 * SERIAL chain the two do not share an input: the FET's Input attenuator drops
 * the audio path by about 1 dB at drive 50 and its own gain reduction takes
 * more, so the signal arriving at the opto sits roughly 6 dB lower in gated
 * terms than the signal arriving at the section.
 *
 * Measured on narration at -6 dBFS peak with the clip at -9:
 *
 *   section input      gated align  -1.69 dB
 *   post-clip          gated align  -1.12 dB
 *   post-FET (opto in) gated align  +4.42 dB
 *
 * and the opto's peak reduction at `squash: 40` is 0.25 dB aligned from the raw
 * file against 2.98 dB aligned from its own input — twelve times, from the same
 * knob. So a solve cannot measure once at the front and hand the same number to
 * both; it has to render the head stage by stage and measure where each stage
 * actually sits. `dynamicsComposite.test.js` pins the gap.
 *
 * ⚠ AND 2.98 dB IS ITSELF EVIDENCE THAT `squash: 40` DOES NOT TRANSFER. Scheps
 * lands 7.64 dB of peak reduction at that value; here the cell sees a signal
 * already clipped and already FET-compressed, so there is less left to grab.
 * The default carried over is a placeholder that runs, not a calibration.
 *
 * This file is BOTH a normal ES module (exports DynamicsKernel and
 * processDynamicsBuffer) AND an AudioWorklet module (registers
 * 'dynamics-processor'). Its loader goes through `?worker&url` so Vite bundles
 * the DSP it imports.
 *
 * ⚠ THE WORKLET REGISTRATION IS NOT HERE YET — this ships as the kernel and its
 * tests only. The worklet wrapper, the crest solve, the apply path and the
 * panel are the next increments.
 */

import { SoftClipperKernel, softClipperLatencySamples } from './softClipperProcessor.js'
import { FET1176Kernel, fet1176PreRollSeconds } from './fet1176Processor.js'
import { LA2AKernel, LA2A_PREROLL_S } from './la2aProcessor.js'
import { BiquadCascade } from './dsp/biquad.js'
import { pultecSections, PULTEC_STAGES } from './dsp/pultec.js'
import { DelayLine } from './dsp/oversample.js'
import { clamp, finite, mixGains } from './dsp/parallelMix.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * Soft-clipper settings this composite fixes, and why none is on the panel.
 *
 * ⚠ `limiter: 0` IS LOAD-BEARING TWICE OVER. It is what makes the stage a
 * CURVE rather than a limiter — the clipper is shaping transients for the
 * detectors, not policing an output ceiling — and it is what makes the latency
 * a constant 50 samples instead of a per-patch 226, which the dry delay and the
 * apply path both depend on.
 *
 * ⚠ `thresholdMode: 'fixed'` IS NOT A PREFERENCE. The kernel default is
 * `adaptive`, which `previewApplyConvergence.test.js` pins as still
 * history-dependent at a 2 s lead-in (~0.9 against OptoSmooth's exact zero) —
 * it has ~20 dB to travel on a 3 s time constant and no pre-roll converges it.
 * Importing that into the flagship chain would make the whole composite
 * preview/apply divergent. `fixed` has no tracker to be cold and is exactly
 * identical between the two.
 *
 * It also happens to be what the design wants: the clipper's depth is a solve
 * INPUT, set from the measured crest before the compressors are allocated, not
 * something for a tracker to decide at play time.
 *
 * `outputTrimDb: 0` because any makeup in this section belongs at its output,
 * after the blend, where one number can be reasoned about.
 */
const CLIP_FIXED = {
  limiter: 0,
  thresholdMode: 'fixed',
  outputTrimDb: 0,
}

/**
 * FET settings this composite fixes.
 *
 * `mix: 1` because the parallel blend is ours, not the compressor's, and it
 * belongs around the opto rather than around this stage.
 */
const FET_FIXED = {
  mix: 1,
  oversample: true,
}

/**
 * Opto settings this composite fixes.
 *
 * `r37: 0` is the Scheps trick — the trimmer fully counter-clockwise, which is
 * pre-emphasis into the side-chain so the cell rides the presence band.
 * `mode: 'compress'` because this is levelling. `mix: 1` because the blend is
 * ours. `lookaheadMs: 0` because lookahead would move `la2a.latencySamples`,
 * which the dry delay follows and this kernel's reported latency does not.
 *
 * ⚠ NO `ceilingDb`, DELIBERATELY AND UNLIKE SCHEPS. There the kernel IS the
 * last stage so its ceiling bounds what leaves. Here the whole section is
 * mid-chain — the chain's tone section and its delivery solve both come after —
 * so a ceiling anywhere in here would be undone downstream. It is also what
 * retires the knee cost Scheps records paying at low Mix.
 */
const OPTO_FIXED = {
  mode: 'compress',
  r37: 0,
  mix: 1,
  lookaheadMs: 0,
}

/**
 * Pre-roll for the offline apply path, seconds, for a given patch.
 *
 * ⚠ THE SLOWEST EMBEDDED ENVELOPE WINS, AND IT IS THE FET'S RELEASE TAIL — NOT
 * THE OPTO'S BALLISTICS. `LA2A_PREROLL_S` is 2 s and bit-exact; the FET's tail
 * runs to 6.6 s and asks for up to 26.4 s. Taking the opto's number because it
 * is the one this composite is "about" would under-roll the stage that actually
 * needs it.
 *
 * ⚠ AND THE COMPOSITE IS THEREFORE NOT BIT-EXACT, WHERE OPTOSMOOTH AND SCHEPS
 * ARE. The FET converges asymptotically — ~1e-4 at its wired pre-roll, not zero
 * — so this kernel inherits that bound. Stated here rather than discovered.
 */
export function dynamicsPreRollSeconds(params = {}) {
  return Math.max(
    LA2A_PREROLL_S,
    fet1176PreRollSeconds({ release: params.fetRelease, ratio: params.fetRatio }),
  )
}

export const DYNAMICS_KERNEL_DEFAULTS = {
  // ── Soft clip ────────────────────────────────────────────────────────────
  /**
   * Where the curve starts, dBFS. NULL BYPASSES THE STAGE ENTIRELY.
   *
   * ⚠ MEASURED, NOT DIALLED, AND THEREFORE NOT A PRESET KEY. It is set from the
   * region's own crest excess over the voicing's transient target, so it
   * describes the FILE. A patch carrying one would apply another recording's
   * peak structure to this one.
   */
  clipThresholdDb: null,
  clipShape: 'tanh4',

  // ── FET Punch ────────────────────────────────────────────────────────────
  fetDrive: 50, // 0-100 into the fixed internal threshold
  fetAttack: 4, // dial 1-7, 7 fastest
  fetRelease: 4,
  fetRatio: '4',
  fetSat: 0.35,
  /**
   * ⚠ OFF ZERO, UNLIKE THE STOCK PLUGIN. The FET is the one stage between the
   * clipper and the opto that can still be yanked by a plosive, and the
   * hardware's broadband detector has no defence. 80 Hz is a starting point to
   * be measured on narration, not a fitted value.
   */
  fetScHpfHz: 80,
  fetAlignDb: 0, // measured; see dsp/inputAlign.js

  // ── Opto block ───────────────────────────────────────────────────────────
  character: 'thick', // 'thick' | 'presence' — which Pultec curve pair
  /**
   * The opto's Peak Reduction, 0-100.
   *
   * ⚠ 33, NOT SCHEPS' 40, AND THE NUMBER IS ANCHORED ON A MEASURED OPERATING
   * POINT RATHER THAN COPIED. Scheps' calibrated layer depth is peak gain
   * reduction 7.64 dB / average 1.23; measured on real narration through this
   * chain's head, at the opto's own-input alignment, squash 33 gives 7.52 /
   * 1.23 and 40 gives 9.87 / 2.27. Scheps needs more knob because its cell sees
   * the raw signal; here it sees one already clipped and already FET-compressed,
   * so there is less left to grab.
   *
   * ⚠ THIS IS THE FALLBACK ONLY. In normal use the solve sets it from the
   * voicing, scaled by Density — see `VOICINGS` in dynamicsSolve.js.
   */
  squash: 33,
  optoAlignDb: 0, // measured

  // ── Blend and output ─────────────────────────────────────────────────────
  mix: 0.35, // 0-1 wet, against the POST-FET dry
  /**
   * Measured inputs to the blend law — see dsp/parallelMix.js. Zero means
   * UNMEASURED, not "no correction needed", and both must be measured against
   * THIS section's dry path (post-FET), never inherited from Scheps.
   */
  correlation: 0,
  densityDb: 0,
  outputDb: 0, // manual trim on the summed output
}

/**
 * ── THE STAGE PARAM BUILDERS ────────────────────────────────────────────────
 *
 * ⚠ EXPORTED, AND THE SOLVE USES THEM RATHER THAN REBUILDING THE MAPPING. The
 * solve has to render the head STAGE BY STAGE — see the note at the top of this
 * file on staged alignment — which means it constructs the same embedded
 * kernels this composite does. If it spelled their params out again, the pinned
 * decisions above (`limiter: 0`, `thresholdMode: 'fixed'`, `r37: 0`,
 * `lookaheadMs: 0`, no ceiling) would exist in two places, and the solve would
 * quietly be measuring a different compressor from the one that renders.
 */

/** True when a clip threshold has been measured; absent bypasses the stage. */
export function clipEnabled(p) {
  return Number.isFinite(p.clipThresholdDb)
}

export function clipParamsFor(p) {
  return {
    ...CLIP_FIXED,
    shape: p.clipShape ?? DYNAMICS_KERNEL_DEFAULTS.clipShape,
    fixedThresholdDb: finite(p.clipThresholdDb, -10, -60, 0),
  }
}

export function fetParamsFor(p) {
  return {
    ...FET_FIXED,
    inputDrive: finite(p.fetDrive, DYNAMICS_KERNEL_DEFAULTS.fetDrive, 0, 100),
    outputGainDb: 0,
    attack: finite(p.fetAttack, DYNAMICS_KERNEL_DEFAULTS.fetAttack, 1, 7),
    release: finite(p.fetRelease, DYNAMICS_KERNEL_DEFAULTS.fetRelease, 1, 7),
    ratio: p.fetRatio ?? DYNAMICS_KERNEL_DEFAULTS.fetRatio,
    fetDrive: finite(p.fetSat, DYNAMICS_KERNEL_DEFAULTS.fetSat, 0, 1),
    scHpfHz: finite(p.fetScHpfHz, DYNAMICS_KERNEL_DEFAULTS.fetScHpfHz, 0, 400),
    /**
     * ⚠ DETECTOR-ONLY ON THIS UNIT — its Input knob is an attenuator on the
     * audio path as well, so the alignment rides a separate coefficient. See
     * `inputAlignDb` in fet1176Processor.js.
     */
    inputAlignDb: finite(p.fetAlignDb, 0, -60, 60),
  }
}

export function optoParamsFor(p) {
  return {
    ...OPTO_FIXED,
    peakReduction: finite(p.squash, DYNAMICS_KERNEL_DEFAULTS.squash, 0, 100),
    // No makeup inside the block: the section's trim sits after the blend.
    gainDb: 0,
    oversample: p.oversample !== false,
    inputAlignDb: finite(p.optoAlignDb, 0, -60, 60),
  }
}

/** The Pultec pair the opto sits between, for a given character. */
export function pultecPairFor(p, sampleRate) {
  const character = PULTEC_STAGES[p.character]
    ? p.character : DYNAMICS_KERNEL_DEFAULTS.character
  return {
    pre: pultecSections(sampleRate, character, 'pre'),
    post: pultecSections(sampleRate, character, 'post'),
  }
}

export class DynamicsKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.clipper = new SoftClipperKernel(sampleRate)
    this.fet = new FET1176Kernel(sampleRate)
    this.la2a = new LA2AKernel(sampleRate)

    this.preEq = null
    this.postEq = null
    this.dryLines = [] // one per channel, grown on demand
    this.dryLatency = -1
    this.wetScratch = []
    this.stageScratch = []

    this.params = { ...DYNAMICS_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and rebuild every embedded stage. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    // Absent threshold means the stage is bypassed; see `clipThresholdDb`.
    this.clipOn = clipEnabled(p)
    this.clipper.setParams(clipParamsFor(p))
    this.fet.setParams(fetParamsFor(p))

    const { pre, post } = pultecPairFor(p, this.sampleRate)
    // Rebuilt rather than resized when the character changes: the two curves can
    // differ in section count, and a cascade's state is meaningless across a
    // topology change anyway.
    if (!this.preEq || this.preEq.sectionCount !== pre.length) {
      this.preEq = new BiquadCascade(pre.length, Math.max(1, this.dryLines.length))
    }
    if (!this.postEq || this.postEq.sectionCount !== post.length) {
      this.postEq = new BiquadCascade(post.length, Math.max(1, this.dryLines.length))
    }
    this.preEq.setSections(pre)
    this.postEq.setSections(post)

    this.la2a.setParams(optoParamsFor(p))

    this.outputLin = Math.exp(finite(p.outputDb, 0, -24, 24) * LN10_OVER_20)
    this._updateMix()

    /**
     * The dry delay matches the WET PATH'S latency, which is the opto's alone —
     * the Pultec cascades are IIR and the clip and FET are upstream of the tap.
     */
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

  /**
   * Algorithmic latency, in samples.
   *
   * ⚠ THE THREE STAGES ARE IN SERIES SO THEIR LATENCIES ADD, and the opto's is
   * counted ONCE even though the blend has two paths — the dry line delays by
   * exactly the opto's latency, so both arrive together.
   */
  get latencySamples() {
    return this.clipper.latencySamples + this.fet.latencySamples + this.la2a.latencySamples
  }

  /**
   * What each stage actually did, in dB (positive reduction).
   *
   * ⚠ THE PANEL MUST SHOW ALL THREE SEPARATELY. The section's macro sets a
   * crest target and a solve distributes it across the ladder; a single summed
   * meter would hide whether the clipper is being asked for more than its cap,
   * which is the one failure the design says must never happen silently.
   *
   * `peak` is the largest reduction seen since the kernel was constructed and
   * `now` is the current block's. Both, because they answer different
   * questions: a meter needs the instant, a report needs the worst case.
   */
  getMetering() {
    const fet = this.fet.getMetering()
    const opto = this.la2a.getMetering()
    const clip = this.clipOn ? this.clipper.getMetering() : null
    return {
      clip: { now: clip?.reductionDb ?? 0, peak: clip?.maxReductionDb ?? 0 },
      fet: { now: fet.grDb, peak: fet.maxGainReductionDb, avg: fet.avgGainReductionDb },
      opto: { now: opto.grDb, peak: opto.maxGainReductionDb ?? 0, avg: opto.avgGainReductionDb ?? 0 },
    }
  }

  _ensureChannels(count) {
    this.preEq.ensureChannels(count)
    this.postEq.ensureChannels(count)
    while (this.dryLines.length < count) this.dryLines.push(new DelayLine(this.dryLatency))
    while (this.wetScratch.length < count) this.wetScratch.push(new Float32Array(128))
    while (this.stageScratch.length < count) this.stageScratch.push(new Float32Array(128))
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
      if (this.stageScratch[ch].length < n) this.stageScratch[ch] = new Float32Array(n)
    }

    // Serial head: clip, then FET. Channels beyond the input count reuse the
    // last one, matching the convention in la2aProcessor.js.
    const stage = []
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[ch < nIn ? ch : nIn - 1]
      const s = this.stageScratch[ch].subarray(0, n)
      s.set(src.subarray(0, n))
      stage.push(s)
    }
    // ⚠ BOTH RUN ACROSS THE WHOLE BUS IN ONE CALL. Each has a detector shared
    // between channels by design, so a stereo file's two sides move together;
    // calling them per channel would let the sides drift apart.
    if (this.clipOn) this.clipper.process(stage, stage, n)
    this.fet.process(stage, stage, n)

    // The dry tap is HERE — post-FET, pre-Pultec. See the header.
    const wet = []
    for (let ch = 0; ch < nOut; ch++) {
      const w = this.wetScratch[ch].subarray(0, n)
      this.preEq.process(stage[ch], w, n, ch)
      wet.push(w)
    }
    this.la2a.process(wet, wet, n)

    const { dryGain, wetGain, outputLin } = this
    for (let ch = 0; ch < nOut; ch++) {
      const w = wet[ch]
      const out = outputChannels[ch]
      this.postEq.process(w, w, n, ch)

      const line = this.dryLines[ch]
      const s = stage[ch]
      for (let i = 0; i < n; i++) {
        // Read the dry sample before writing the output, so an in-place caller
        // (input and output the same array) still works.
        const dry = line.push(s[i])
        out[i] = (dry * dryGain + w[i] * wetGain) * outputLin
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by the tests and by measurement; the app renders through an
 * OfflineAudioContext running the worklet, so preview and apply share a path.
 */
export function processDynamicsBuffer(channelData, sampleRate, params = {}) {
  const kernel = new DynamicsKernel(sampleRate)
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
  return {
    channelData: output,
    latencySamples: kernel.latencySamples,
    metering: kernel.getMetering(),
  }
}

export { clamp }

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

/**
 * ⚠ GUARDED, AND SO ARE THE THREE KERNELS THIS CHUNK CONTAINS. `?worker&url`
 * bundles this file together with everything it imports — the clipper, the FET,
 * the LA-2A — so their own `registerProcessor` calls travel with it, and more
 * than one such chunk can end up in a single AudioContext. Each guard is what
 * stops the second load throwing on an already-registered name.
 */
if (typeof registerProcessor === 'function') {
  class DynamicsWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new DynamicsKernel(sampleRate)
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

      /**
       * ⚠ ALL THREE STAGES, NOT A SUM. The section's macro sets a target and a
       * solve distributes it across the ladder; one summed meter would hide
       * whether the clipper is being asked for more than its cap, which is the
       * one failure the design says must never happen silently.
       */
      this.frame += n
      if (this.frame >= 735) {
        this.frame = 0
        this.port.postMessage({ type: 'gr', metering: this.kernel.getMetering() })
      }
      return true
    }
  }

  registerProcessor('dynamics-processor', DynamicsWorkletProcessor)
}
