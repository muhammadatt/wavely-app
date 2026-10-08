/**
 * PHAT*SS — worklet kernel.
 *
 * [head bump → tape compression →] TAPE (full-band cubic) → makeup → Warmth → Guard → Tape shelf (with Soften
 * on its own band) → Output.
 *
 * TAPE comes FIRST (owner's call): Warmth then shapes the already-rounded
 * signal, and TAPE's input is the untouched source, so its makeup depends on
 * nothing else in the plugin and can be measured fast (phatassTapeMakeup.js).
 * The makeup puts the voice's peak back on the selection's own, which is the
 * guard's ceiling, so the "Warmth never raises the peak" guarantee holds
 * through the reorder unchanged.
 *
 * WARMTH is up to four Saturation Bench layers (dsp/saturationLayers.js,
 * voiced in phatassParams.WARMTH_LAYERS), a pure delay at 0. Its PEAK
 * GUARD (dsp/warmthGuard.js) is pinned on: what Warmth adds is turned down
 * wherever the sum would pass the selection's own peak, so Warmth adds density
 * but never peak level. The TAPE SHELF is the HF Limiter's lookahead dynamic
 * shelf (dsp/hfLimit.js) with its shape and timing pinned (phatassParams
 * .TAPE_SHELF) and its corner / threshold / range set by the Tame and Tone
 * macros. TAPE is one more bench layer, full band, calibrated on the
 * selection's peak so its knob reads in dB of peak reduction (phatassParams
 * `tapeLayer`).
 *
 * Constant latency (see `phatassLatencySamples`), bit-transparent with Warmth,
 * Soften and Tame at 0. SOFTEN is the shelf's Transient detector with its own
 * band (`transientCornerHz`), deeper than the HF Limiter's, at no extra latency.
 *
 * This file is BOTH a normal ES module and an AudioWorklet module (registers
 * 'phatass-processor'); it imports from ./dsp/, so its loader goes through
 * `?worker&url` like the others.
 */

import { ShelfLimiterStage } from './dsp/hfLimit.js'
import { SaturationBenchKernel } from './dsp/saturationLayers.js'
import { WarmthPeakGuard } from './dsp/warmthGuard.js'
import { DelayLine } from './dsp/oversample.js'
import { BiquadCascade, lowShelf } from './dsp/biquad.js'
import { TapeCompressor } from './dsp/tapeComp.js'
import { toKernelParams, PHATASS_DEFAULTS, WARMTH_LAYERS, slotOversample, TAPE_HEAD_BUMP_HZ, TAPE_HEAD_BUMP_Q } from './phatassParams.js'

export const PHATASS_KERNEL_DEFAULTS = toKernelParams(PHATASS_DEFAULTS)

const LN10_OVER_20 = Math.LN10 / 20
/** The worklet posts the saturation meter's sums every this many 128-sample quanta. */
const METER_POST_QUANTA = 8
const dbToLin = db => Math.exp(db * LN10_OVER_20)

export class PhatassKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.tape = new SaturationBenchKernel(sampleRate, { slots: 1 })
    // TAPE's head bump (bench only): a low shelf ahead of TAPE, kept in the
    // output; the meter's clean reference runs through its own copy, so a
    // linear lift never reads as saturation. Zero latency.
    this.bump = new BiquadCascade(1, 2)
    this.meterBump = new BiquadCascade(1, 2)
    this.bumpDb = 0
    // Tape compression (bench only): after the bump, before the curve. Zero latency.
    this.comp = new TapeCompressor(sampleRate)
    this.tapeInit = false
    this.warmth = new SaturationBenchKernel(sampleRate, { slots: WARMTH_LAYERS.length, oversample: slotOversample() })
    this.warmthInit = false
    // Lined up against the Warmth output, so its dry is Warmth's input (TAPE's
    // output after makeup) delayed by that.
    this.guard = new WarmthPeakGuard(sampleRate, this.warmth.latencySamples)
    this.warmthIn = []
    this.shelf = new ShelfLimiterStage(sampleRate)
    this.latencySamples = this.tape.latencySamples + this.warmth.latencySamples
      + this.guard.latencySamples + this.shelf.latencySamples
    this.params = { ...PHATASS_KERNEL_DEFAULTS }
    this.setParams({}, true)
    // SATURATION METER (off unless `enableMeter`, so offline renders skip it):
    // the energy of what TAPE and Warmth ADD, read before the shelf, against the
    // energy of the clean input as it would arrive there — scaled by the makeup
    // and delayed by TAPE + Warmth + guard. The shelf and Output are gains, not
    // saturation, so they stay out of both sums.
    this.meterOn = false
    this.meterLag = this.tape.latencySamples + this.warmth.latencySamples + this.guard.latencySamples
    this.meterDelays = []
    this.meterIn = []
    this.meterAdded = 0
    this.meterClean = 0
    this.meterCount = 0
  }

  /** Start accumulating the saturation meter's energies (the worklet does). */
  enableMeter() {
    this.meterOn = true
  }

  /**
   * The meter's energy sums since the last call, summed over channels:
   * `added` is what TAPE and Warmth added, `clean` the makeup-scaled input,
   * `count` the samples summed (frames × channels).
   */
  takeMeter() {
    const r = { added: this.meterAdded, clean: this.meterClean, count: this.meterCount }
    this.meterAdded = 0
    this.meterClean = 0
    this.meterCount = 0
    return r
  }

  /**
   * `immediate` jumps the Warmth layers' ramps to the new values. ⚠ THE FIRST
   * REAL PARAMS MUST BE IMMEDIATE: the constructor has already set the
   * defaults, so a ramped first set glides Warmth from them over the first
   * 20 ms — a render from rest started +0.4 dB hot when this lived in the HF
   * Limiter.
   */
  setParams(partial, immediate = false) {
    const p = { ...this.params, ...partial }
    this.params = p
    if (p.warmthLayers) {
      // Ramped like the bench's own knobs, except an immediate set.
      this.warmth.setParams({ layers: p.warmthLayers }, immediate || !this.warmthInit)
      this.warmthInit = true
    }
    if (p.warmthGuard) this.guard.setParams(p.warmthGuard)
    if (p.tapeComp) this.comp.setParams(p.tapeComp)
    if (p.tapeLayer) {
      this.tape.setParams({ layers: [p.tapeLayer] }, immediate || !this.tapeInit)
      this.tapeInit = true
    }
    this.shelf.setParams({
      cornerHz: p.cornerHz,
      thresholdLin: dbToLin(p.thresholdDb),
      floorLin: dbToLin(-Math.max(0, p.rangeDb)),
      releaseMs: p.releaseMs,
      shape: p.shape,
      tailMs: p.tailMs,
      transientDb: p.transientDb,
      transientCornerHz: p.transientCornerHz,
      transientSlope: p.transientSlope,
      transientGateLin: Number.isFinite(p.transientGateDb) ? dbToLin(p.transientGateDb) : null,
      detectCornerHz: p.detectCornerHz,
    })
    this.outputLin = dbToLin(p.outputGainDb + (Number.isFinite(p.outputMakeupDb) ? p.outputMakeupDb : 0))
    this.tapeMakeupLin = dbToLin(Number.isFinite(p.tapeMakeupDb) ? p.tapeMakeupDb : 0)
    if (p.headBumpPos !== this.bumpPos) {
      this.bump.reset()
      this.bumpPos = p.headBumpPos
    }
    const bump = Number.isFinite(p.headBumpDb) ? p.headBumpDb : 0
    if (bump !== this.bumpDb) {
      // Coefficients only: the filter state carries over, so a change is a step in gain, not a click from rest.
      if (bump > 0) {
        const c = lowShelf(this.sampleRate, TAPE_HEAD_BUMP_HZ, TAPE_HEAD_BUMP_Q, bump)
        this.bump.setSection(0, c)
        this.meterBump.setSection(0, c)
      }
      if (!(this.bumpDb > 0)) { this.bump.reset(); this.meterBump.reset() }
      this.bumpDb = bump
    }
  }

  applyBump(chs, n) {
    this.bump.ensureChannels(chs.length)
    for (let ch = 0; ch < chs.length; ch++) this.bump.process(chs[ch], chs[ch], n, ch)
  }

  /** The head bump (pre or post), tape compression (if on), TAPE, then its makeup gain, in place. */
  tapeAndMakeup(chs, n) {
    const post = this.params.headBumpPos === 'post'
    if (this.bumpDb > 0 && !post) this.applyBump(chs, n)
    this.comp.process(chs, n)
    this.tape.process(chs, chs, n)
    // Post: where a playback head puts it, after the curve and before the makeup.
    if (this.bumpDb > 0 && post) this.applyBump(chs, n)
    const mk = this.tapeMakeupLin
    if (mk === 1) return
    for (const out of chs) {
      for (let i = 0; i < n; i++) out[i] *= mk
    }
  }

  /**
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
    for (let ch = 0; ch < nOut; ch++) {
      outputChannels[ch].set(inputChannels[ch < nIn ? ch : nIn - 1].subarray(0, n))
    }
    // In place: each stage reads a sample before it writes that output.
    // `tapeOrder` 'first' (shipping): TAPE → makeup → Warmth → guard. 'last'
    // (the order before October 2026, kept to audition): Warmth → guard → TAPE
    // → makeup. Same stages, so the latency is the same either way.
    const mk = this.tapeMakeupLin
    const tapeLast = this.params.tapeOrder === 'last'
    if (!tapeLast) this.tapeAndMakeup(outputChannels, n)
    // The guard needs Warmth's input as well as its output.
    while (this.warmthIn.length < nOut) this.warmthIn.push(new Float32Array(n))
    const wIn = this.warmthIn
    for (let ch = 0; ch < nOut; ch++) {
      if (wIn[ch].length < n) wIn[ch] = new Float32Array(n)
      wIn[ch].set(outputChannels[ch].subarray(0, n))
    }
    this.warmth.process(outputChannels, outputChannels, n)
    this.guard.process(wIn, outputChannels, n)
    if (tapeLast) this.tapeAndMakeup(outputChannels, n)
    if (this.meterOn) {
      while (this.meterDelays.length < nOut) this.meterDelays.push(new DelayLine(this.meterLag))
      let added = 0
      let clean = 0
      const bumped = this.bumpDb > 0
      // The compressor's gain is a gain, not saturation: the clean reference
      // follows it (sample-aligned before the delay; valid in TAPE-first order).
      const comped = this.comp.p.on && !tapeLast
      if (bumped || comped) {
        this.meterBump.ensureChannels(nOut)
        while (this.meterIn.length < nOut) this.meterIn.push(new Float32Array(n))
      }
      for (let ch = 0; ch < nOut; ch++) {
        const d = this.meterDelays[ch]
        let x = inputChannels[ch < nIn ? ch : nIn - 1]
        if (bumped || comped) {
          if (this.meterIn[ch].length < n) this.meterIn[ch] = new Float32Array(n)
          const m = this.meterIn[ch]
          if (bumped) this.meterBump.process(x, m, n, ch)
          else m.set(x.subarray(0, n))
          if (comped) { const gs = this.comp.gains; for (let i = 0; i < n; i++) m[i] *= gs[i] }
          x = m
        }
        const y = outputChannels[ch]
        for (let i = 0; i < n; i++) {
          const c = mk * d.push(x[i])
          const a = y[i] - c
          added += a * a
          clean += c * c
        }
      }
      this.meterAdded += added
      this.meterClean += clean
      this.meterCount += n * nOut
    }
    this.shelf.process(outputChannels, n)
    const g = this.outputLin
    if (g !== 1) {
      for (let ch = 0; ch < nOut; ch++) {
        const out = outputChannels[ch]
        for (let i = 0; i < n; i++) out[i] *= g
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by tests and scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share one code path. The output is
 * delayed by the kernel's latency, like the worklet's.
 */
export function processPhatassBuffer(channelData, sampleRate, kernelParams = {}) {
  const kernel = new PhatassKernel(sampleRate)
  kernel.setParams(kernelParams, true)
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
  class PhatassWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new PhatassKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params, true)
      }
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
      }
      this.kernel.enableMeter()
      this.quanta = 0
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
      // Saturation meter: energy sums every METER_POST_QUANTA (~23 ms at 44.1 kHz).
      if (++this.quanta >= METER_POST_QUANTA) {
        this.quanta = 0
        this.port.postMessage({ type: 'sat', frames: METER_POST_QUANTA * n, ...this.kernel.takeMeter() })
      }
      return true
    }
  }

  registerProcessor('phatass-processor', PhatassWorkletProcessor)
}
