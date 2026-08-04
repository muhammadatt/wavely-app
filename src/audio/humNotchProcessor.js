/**
 * Hum Remover — worklet kernel.
 *
 * The apply half of the server's `humDetect` stage (server/pipeline/stages.js:404),
 * which builds an FFmpeg chain of narrow peaking cuts:
 *
 *   equalizer=f=<hz>:width_type=q:width=30:g=-18
 *
 * Nothing more than that — a handful of very narrow biquads at the mains
 * frequency and its harmonics. Zero latency, no analysis of its own: which
 * frequencies to notch comes from src/audio/dsp/humDetect.js, run once behind
 * the panel's Analyze button.
 *
 * This file is BOTH a normal ES module (exports HumNotchKernel and
 * processHumNotchBuffer) AND an AudioWorklet module (registers
 * 'hum-notch-processor'). It imports from ./dsp/, so its loader pulls it
 * through `?worker&url` — see humNotchWorkletLoader.js.
 *
 * Section count is fixed at MAX_NOTCHES and unused slots are set to a
 * pass-through biquad rather than reallocating the cascade. Rebuilding it on
 * every change to the notch list would reset filter state and click.
 */

import { peaking, BiquadCascade } from './dsp/biquad.js'

/** Enough for a mains fundamental plus harmonics well past the useful range. */
export const MAX_NOTCHES = 8

// Server constants: HUM_NOTCH_Q and HUM_NOTCH_DEPTH_DB in stages.js.
export const HUM_NOTCH_KERNEL_DEFAULTS = {
  frequencies: [],
  q: 30,
  depthDb: 18,
}

/** Unity biquad, for slots with no notch assigned. */
const PASS_THROUGH = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Coefficients for a notch set — shared with the response curve in the panel.
 *
 * The server uses FFmpeg's `equalizer` (a peaking filter at negative gain)
 * rather than a true notch, so a finite depth is reproduced rather than an
 * infinitely deep null. Matching that matters: an 18 dB cut leaves the
 * surrounding spectrum far more intact than a true null would.
 */
export function humNotchSections(sampleRate, frequencies, q, depthDb) {
  const nyquist = sampleRate / 2
  const sections = []
  for (const f of frequencies.slice(0, MAX_NOTCHES)) {
    if (!Number.isFinite(f) || f <= 0 || f >= nyquist) continue
    // A peaking filter at negative gain, which is exactly what FFmpeg's
    // `equalizer` realises — not a true notch, so the cut has finite depth and
    // leaves the surrounding spectrum far more intact than a null would.
    sections.push(peaking(sampleRate, f, q, -depthDb, 'q'))
  }
  return sections
}

export class HumNotchKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.cascade = new BiquadCascade(MAX_NOTCHES, 2)
    this.params = { ...HUM_NOTCH_KERNEL_DEFAULTS }
    this.activeCount = 0
    this.setParams({})
  }

  /** Merge a partial param update and rebuild coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const q = clamp(p.q, 0.5, 100)
    const depthDb = clamp(p.depthDb, 0, 60)
    const sections = humNotchSections(this.sampleRate, p.frequencies ?? [], q, depthDb)
    this.activeCount = sections.length

    for (let i = 0; i < MAX_NOTCHES; i++) {
      this.cascade.setSection(i, i < sections.length ? sections[i] : PASS_THROUGH)
    }
  }

  /** True when at least one notch is active — drives the panel's status text. */
  get isActive() {
    return this.activeCount > 0
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

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      if (this.activeCount === 0) {
        // Nothing selected — copy rather than running eight unity biquads.
        for (let i = 0; i < n; i++) out[i] = input[i]
      } else {
        this.cascade.process(input, out, n, ch)
      }
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by verification scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share the same code path.
 */
export function processHumNotchBuffer(channelData, sampleRate, params = {}) {
  const kernel = new HumNotchKernel(sampleRate)
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
  class HumNotchWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new HumNotchKernel(sampleRate)
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

  registerProcessor('hum-notch-processor', HumNotchWorkletProcessor)
}
