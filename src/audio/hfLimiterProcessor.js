/**
 * HF Limiter — worklet kernel.
 *
 * Warmth → Shelf. WARMTH is two Saturation Bench layers (dsp/saturationLayers.js,
 * quartic then tanh, voiced in hfLimiterParams.WARMTH_LAYERS), 4x oversampled,
 * a pure delay at 0, then its AUTO makeup gain (ahead of the shelf, so the
 * file-relative Threshold sees a level-matched signal). SHELF, from
 * dsp/hfLimit.js (read that file for the design), is a lookahead
 * dynamic shelf that holds the band above the corner at the threshold, down to
 * a Range floor — brightness and harshness, in the HiFal / Limiter 6 HF / Fatso
 * family — with a TIGHT or WARM split, an optional Tail release stage, and a
 * transient softener that deepens the same cut on sudden onsets (Transient,
 * 0 = off) — all gain on one band, so the shelf needs no oversampling.
 *
 * Bit-transparent below threshold, and a constant latency (see
 * `hfLimiterLatencySamples`).
 *
 * This file is BOTH a normal ES module and an AudioWorklet module (registers
 * 'hf-limiter-processor'); it imports from ./dsp/, so its loader goes through
 * `?worker&url` like the others.
 */

import { ShelfLimiterStage } from './dsp/hfLimit.js'
import { SaturationBenchKernel } from './dsp/saturationLayers.js'
import { WarmthPeakGuard } from './dsp/warmthGuard.js'
import { toKernelParams, HF_LIMITER_DEFAULTS, WARMTH_LAYERS } from './hfLimiterParams.js'

export const HF_LIMITER_KERNEL_DEFAULTS = toKernelParams(HF_LIMITER_DEFAULTS)

const LN10_OVER_20 = Math.LN10 / 20
const dbToLin = db => Math.exp(db * LN10_OVER_20)

/** AUTO makeup glides to a new value over about this long (one-pole). */
const MAKEUP_SMOOTH_MS = 20

/** Meter posts every this many 128-sample quanta (~23 ms at 44.1 kHz). */
const METER_QUANTA = 8

const toDbCut = g => (g < 1 ? -20 * Math.log10(Math.max(g, 1e-6)) : 0)

export class HFLimiterKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.shelf = new ShelfLimiterStage(sampleRate)
    this.warmth = new SaturationBenchKernel(sampleRate, { slots: WARMTH_LAYERS.length })
    this.warmthInit = false
    // Lined up against the Warmth output, so its dry is the input delayed by that.
    this.guard = new WarmthPeakGuard(sampleRate, this.warmth.latencySamples)
    this.makeupLin = 1
    this.makeupTarget = 1
    this.makeupCoef = 1 - Math.exp(-1 / ((MAKEUP_SMOOTH_MS / 1000) * sampleRate))
    this.latencySamples = this.warmth.latencySamples + this.guard.latencySamples + this.shelf.latencySamples
    this.listen = 'off'
    this.dryDelays = []
    this.dry = []
    this.params = { ...HF_LIMITER_KERNEL_DEFAULTS }
    this.setParams({}, true)
  }

  /**
   * `immediate` jumps the Warmth layers' ramps to the new values. ⚠ THE FIRST
   * REAL PARAMS MUST BE IMMEDIATE: the constructor has already set the
   * defaults (Warmth off), so a ramped first set glided the Warmth amount in
   * over the first 20 ms from 0 dB — a render from rest started louder than
   * the setting (+0.4 dB of peak on narration at Warmth 3).
   */
  setParams(partial, immediate = false) {
    const p = { ...this.params, ...partial }
    this.params = p
    this.shelf.setParams({
      cornerHz: p.cornerHz,
      thresholdLin: dbToLin(p.thresholdDb),
      floorLin: dbToLin(-Math.max(0, p.rangeDb)),
      releaseMs: p.releaseMs,
      shape: p.shape,
      tailMs: p.tailMs,
      transientDb: p.transientDb,
    })
    if (p.warmthLayers) {
      // Ramped like the bench's own knobs, except an immediate set.
      this.warmth.setParams({ layers: p.warmthLayers }, immediate || !this.warmthInit)
      this.warmthInit = true
    }
    if (p.warmthGuard) this.guard.setParams(p.warmthGuard)
    this.makeupTarget = dbToLin(p.warmthMakeupDb || 0)
    if (immediate) this.makeupLin = this.makeupTarget
    this.outputLin = dbToLin(p.outputGainDb)
  }

  /** 'off' | 'delta' — delta is what was removed, for monitoring only. */
  setListen(mode) {
    this.listen = mode === 'delta' ? 'delta' : 'off'
  }

  _ensureDry(nCh) {
    while (this.dryDelays.length < nCh) {
      this.dryDelays.push(new Float64Array(Math.max(1, this.latencySamples)))
      this.dry.push({ pos: 0 })
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
    const delta = this.listen === 'delta'
    // The delta needs the input aligned to the output; kept only while asked.
    if (delta) this._ensureDry(nOut)

    // In place: the kernel reads each input sample before it writes that output.
    this.warmth.process(outputChannels, outputChannels, n)
    this.guard.process(inputChannels, outputChannels, n)
    this._makeup(outputChannels, nOut, n)
    this.shelf.process(outputChannels, n)

    const g = this.outputLin
    for (let ch = 0; ch < nOut; ch++) {
      const out = outputChannels[ch]
      if (delta) {
        const buf = this.dryDelays[ch]
        const st = this.dry[ch]
        const input = inputChannels[ch < nIn ? ch : nIn - 1]
        for (let i = 0; i < n; i++) {
          const d = buf[st.pos]
          buf[st.pos] = input[i]
          st.pos = st.pos + 1 === buf.length ? 0 : st.pos + 1
          out[i] = d - out[i]
        }
      } else if (g !== 1) {
        for (let i = 0; i < n; i++) out[i] *= g
      }
    }
  }

  /** The Warmth stage's AUTO makeup, gliding to its target; unity costs nothing. */
  _makeup(chs, nCh, n) {
    const t = this.makeupTarget
    let m = this.makeupLin
    if (m === t) {
      if (t !== 1) for (let ch = 0; ch < nCh; ch++) { const c = chs[ch]; for (let i = 0; i < n; i++) c[i] *= t }
      return
    }
    const k = this.makeupCoef
    for (let i = 0; i < n; i++) {
      m += (t - m) * k
      for (let ch = 0; ch < nCh; ch++) chs[ch][i] *= m
    }
    this.makeupLin = Math.abs(m - t) < 1e-7 ? t : m
  }

  /** Meter readings since the last call: shelf and transient depth, dB (positive). */
  takeMeters() {
    const m = this.shelf.takeMinGain()
    return {
      reductionDb: m < 1 ? -20 * Math.log10(Math.max(m, 1e-6)) : 0,
      gainDb: this.shelf.gain < 1 ? 20 * Math.log10(Math.max(this.shelf.gain, 1e-6)) : 0,
      transientDb: toDbCut(this.shelf.takeMinTransientGain()),
      // How far the peak guard turned the Warmth's added signal down, dB (positive).
      guardDb: toDbCut(this.guard.takeMinGain()),
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by tests and scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share one code path. The output is
 * delayed by the kernel's latency, like the worklet's.
 */
export function processHFLimiterBuffer(channelData, sampleRate, kernelParams = {}) {
  const kernel = new HFLimiterKernel(sampleRate)
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
  class HFLimiterWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new HFLimiterKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params, true)
      }
      this.quanta = 0
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'listen') this.kernel.setListen(e.data.mode)
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
      if (++this.quanta >= METER_QUANTA) {
        this.quanta = 0
        this.port.postMessage({ type: 'gr', ...this.kernel.takeMeters() })
      }
      return true
    }
  }

  registerProcessor('hf-limiter-processor', HFLimiterWorkletProcessor)
}
