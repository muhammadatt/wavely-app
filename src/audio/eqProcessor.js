/**
 * Manual EQ — worklet kernel.
 *
 * A cascade of up to MAX_BANDS RBJ biquads whose parameters come straight from
 * the band pool. Zero latency, no analysis, no state beyond the filter memories.
 *
 * This file is BOTH a normal ES module (exports ManualEqKernel, eqSections and
 * processManualEqBuffer) AND an AudioWorklet module (registers
 * 'manual-eq-processor'). It imports from ./dsp/, so its loader pulls it through
 * `?worker&url` — see eqWorkletLoader.js.
 *
 * SECTION COUNT IS FIXED at MAX_BANDS and unused slots hold a pass-through
 * biquad, following humNotchProcessor.js. Reallocating the cascade whenever the
 * band list changes would reset every filter's state and click — and in a tool
 * whose entire premise is dragging controls while audio runs, that is the
 * difference between usable and not.
 *
 * Which is also why enable/disable maps to a pass-through slot rather than the
 * spec's suggested "set gain to 0, bypass-route the types with no gain"
 * (§11.3). That recipe exists to avoid rewiring a graph of BiquadFilterNodes;
 * with a single cascade there is no graph to rewire, and one uniform rule
 * covers peaking, shelves, HPF, LPF and notch alike.
 */

import {
  peaking, lowShelf, highShelf, highpass, lowpass, notch, bandpass, BiquadCascade,
} from './dsp/biquad.js'
import { MAX_BANDS } from './eqBands.js'

export { MAX_BANDS }

/** Unity biquad, for slots with no band assigned. */
const PASS_THROUGH = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }

export const MANUAL_EQ_KERNEL_DEFAULTS = {
  bands: [],
  outputGainDb: 0,
  /** Index into `bands` to monitor in isolation, or null. */
  soloIndex: null,
  /** A `{ type, frequencyHz, q }` region to monitor that has no band. */
  soloProbe: null,
}

const LN10_OVER_20 = Math.LN10 / 20

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Coefficients for one band.
 *
 * Frequency is held just below Nyquist rather than dropped: a band dragged to
 * the top of the range on a 44.1 kHz file must not vanish, and RBJ coefficients
 * go singular exactly at Nyquist.
 */
function sectionFor(sampleRate, band) {
  const nyquist = sampleRate / 2
  const f = clamp(band.frequencyHz, 1, nyquist * 0.999)
  const q = Math.max(band.q, 1e-3)
  const g = band.gainDb

  switch (band.type) {
    case 'lowshelf': return lowShelf(sampleRate, f, q, g, 'q')
    case 'highshelf': return highShelf(sampleRate, f, q, g, 'q')
    case 'highpass': return highpass(sampleRate, f, q)
    case 'lowpass': return lowpass(sampleRate, f, q)
    case 'notch': return notch(sampleRate, f, q)
    case 'peaking':
    default: return peaking(sampleRate, f, q, g, 'q')
  }
}

/**
 * The monitor filter for solo (spec §11.2): hear only the region a band acts on.
 *
 * A soloed peaking band is not its own monitor — a bell at +3 dB passes almost
 * everything, so soloing it would sound like the whole file. What the user
 * wants is a bandpass at the same place and width. Shelves have no band to
 * pass, so their monitor is the half of the spectrum they act on.
 */
function soloSectionFor(sampleRate, band) {
  const nyquist = sampleRate / 2
  const f = clamp(band.frequencyHz, 1, nyquist * 0.999)
  const q = Math.max(band.q, 1e-3)

  switch (band.type) {
    case 'lowshelf': return lowpass(sampleRate, f, q)
    case 'highshelf': return highpass(sampleRate, f, q)
    case 'highpass': return highpass(sampleRate, f, q)
    case 'lowpass': return lowpass(sampleRate, f, q)
    default: return bandpass(sampleRate, f, q)
  }
}

/**
 * Biquad sections for a band list — shared by the kernel and the UI curve, so
 * what is drawn is the filter that is running rather than a redrawn
 * approximation.
 *
 * Returns only the active sections. Feed the result to `magnitudeResponseDb`
 * for the composite response.
 *
 * Solo takes either form. `soloIndex` points into the band list and is what the
 * general EQ uses, where everything audible is a band. `soloProbe` carries the
 * shape directly — `{ type, frequencyHz, q }` — for auditioning a region that
 * has no band behind it yet: VoiceRx offers "hear what this control grabs"
 * before you have turned it up, and turning it up is exactly what creates the
 * band. The probe wins if both are given.
 *
 * @param {number} sampleRate
 * @param {Array<object>} bands
 * @param {{ soloIndex?: number|null, soloProbe?: object|null }} [options]
 */
export function eqSections(sampleRate, bands, { soloIndex = null, soloProbe = null } = {}) {
  if (soloProbe && Number.isFinite(soloProbe.frequencyHz)) {
    return [soloSectionFor(sampleRate, soloProbe)]
  }
  if (soloIndex !== null && bands[soloIndex]) {
    return [soloSectionFor(sampleRate, bands[soloIndex])]
  }
  const sections = []
  for (const band of bands.slice(0, MAX_BANDS)) {
    if (!band.enabled) continue
    if (!Number.isFinite(band.frequencyHz) || band.frequencyHz <= 0) continue
    sections.push(sectionFor(sampleRate, band))
  }
  return sections
}

export class ManualEqKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.cascade = new BiquadCascade(MAX_BANDS, 2)
    this.params = { ...MANUAL_EQ_KERNEL_DEFAULTS }
    this.activeCount = 0
    this.outputLin = 1
    this.setParams({})
  }

  /** Merge a partial param update and rebuild coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const sections = eqSections(this.sampleRate, p.bands ?? [], {
      soloIndex: p.soloIndex ?? null,
      soloProbe: p.soloProbe ?? null,
    })
    this.activeCount = sections.length

    for (let i = 0; i < MAX_BANDS; i++) {
      this.cascade.setSection(i, i < sections.length ? sections[i] : PASS_THROUGH)
    }

    this.outputLin = Math.exp((p.outputGainDb ?? 0) * LN10_OVER_20)
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
      // convention in la2aProcessor.js / airBandProcessor.js.
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]

      if (this.activeCount === 0) {
        // No bands — copy rather than running twelve unity biquads.
        for (let i = 0; i < n; i++) out[i] = input[i]
      } else {
        this.cascade.process(input, out, n, ch)
      }

      if (outputLin !== 1) {
        for (let i = 0; i < n; i++) out[i] *= outputLin
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by the tests; the app renders through an OfflineAudioContext running the
 * worklet so preview and apply share the same code path.
 */
export function processManualEqBuffer(channelData, sampleRate, params = {}) {
  const kernel = new ManualEqKernel(sampleRate)
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
  class ManualEqWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new ManualEqKernel(sampleRate)
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

  registerProcessor('manual-eq-processor', ManualEqWorkletProcessor)
}
