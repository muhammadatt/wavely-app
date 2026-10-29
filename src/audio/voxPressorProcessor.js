/**
 * VoxPressor — worklet kernel. Stage 1: the voice detector and the
 * Peaks (1176) → Body (LA-2A) core. See docs/voxpressor_spec.md.
 *
 *   in ─┬─ VOICE DETECTOR (no plosive shelf) ─┐ sidechain
 *       │                                     ▼
 *       ├──────────────────────────── [PEAKS] FET1176Kernel (makeup on its Output)
 *       │                                     │
 *       │                              LIMITER (source peak, lookahead gain)
 *       │                                     │
 *       │      ┌─ VOICE DETECTOR (full) ◄─────┤ sidechain, read from the PEAKS stage's output
 *       │      ▼                              │
 *       │   [BODY] LA2AKernel (makeup on its Gain) ◄──┘
 *       │      │
 *       │   RESTORE → LIMITER (source peak, lookahead gain) → OUTPUT trim ─ out
 *
 * HOLDS THE KERNELS, NOT COPIES, as Scheps holds the LA-2A: every fitted
 * constant, ballistic law and saturation curve in either compressor reaches
 * this plugin with no conforming change. What is new here is only what they
 * LISTEN TO (`dsp/voiceDetector.js`, through each kernel's `sidechain`
 * argument) and how they are DRIVEN — the knobs are the compressors' own
 * (the 1176's Input, the LA-2A's Peak Reduction) on a detector-only offset
 * (`inputAlignDb`) set from the file's gated RMS, and the 1176's Output
 * cancels its Input, so neither stage's audio gain moves when a knob does.
 *
 * ⚠ THE BODY DETECTOR READS THE PEAKS OUTPUT, NOT THE INPUT. That is what
 * makes 76 → 2A work: the opto rides a signal whose onsets the FET has already
 * taken, so it is not yanked by them. Feeding it the input would put the
 * onsets back into the one detector they were taken out of.
 *
 * ⚠ CONSTANT LATENCY. Each compressor costs its oversampler's 50 samples; a
 * stage that is OFF is replaced by a delay line of the same length, so turning
 * Peaks or Body off never moves the audio. Off is a pure delay, bit for bit —
 * the kernels' oversampler round trip is not an identity, so "at 0 the stage
 * does nothing" has to be a bypass, not a setting.
 *
 * This file is BOTH a normal ES module (exports VoxPressorKernel and
 * processVoxPressorBuffer) AND an AudioWorklet module (registers
 * 'vox-pressor-processor'). Its loader goes through `?worker&url` so Vite
 * bundles the kernels it imports — see voxPressorWorkletLoader.js.
 */

import { FET1176Kernel, inputDriveDbForKnob } from './fet1176Processor.js'
import { LA2AKernel, la2aLatencySamples } from './la2aProcessor.js'
import { VoiceDetector, DEFAULT_CORNER_HZ } from './dsp/voiceDetector.js'
import { DelayLine, OVERSAMPLE_LATENCY_SAMPLES } from './dsp/oversample.js'
import { float32AtOrBelow } from './dsp/makeupReference.js'
import { LinkedPeakLimiter, peakLimiterLatencySamples } from './dsp/peakLimiter.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * The 1176 as a peak catcher. The Peaks knob IS its Input (`peaksInput`),
 * offset by the file's gated-RMS alignment as LA Classic 76's is; the rest is
 * pinned.
 *
 * ⚠ ALL REASONED, TO AUDITION:
 * - ratio 12 — limiting, not leveling. The moving threshold puts 12:1's
 *   threshold 2.7 dB above 4:1's.
 * - attack 6, release 6 (7 is fastest on both) — fast enough to take a
 *   consonant onset, one short of the end so a vowel's first cycle is not
 *   sliced and the release does not ride bass cycles.
 * - fetDrive 0 — a CLEAN peak trimmer. The colour in this plugin is the
 *   LA-2A's; a FET shaper running on every sample would colour the body the
 *   Peaks stage is promising to leave alone. On the bench.
 * - Output cancels the Input's drive, so the audio gain through the stage is
 *   unity before its makeup and the knob moves only the compression (and the
 *   knee, which reads the knob's drive: `kneeDbForDrive`).
 */
export const PEAKS_PATCH = Object.freeze({
  ratio: '12',
  attack: 6,
  release: 6,
  fetDrive: 0,
  mix: 1,
  scHpfHz: 0,
  ceilingDb: null,
})

/**
 * The LA-2A as the leveler. The Body knob IS its Peak Reduction
 * (`bodyPeakReduction`), offset by the file's alignment as LA Vintage 2A's is.
 * Everything else is the shipping LA Vintage 2A — including its quartic cell
 * and valve, which are this plugin's colour.
 */
export const BODY_PATCH = Object.freeze({
  mode: 'compress',
  gainDb: 0,
  mix: 1,
  lookaheadMs: 0,
  ceilingDb: null,
})

/** Makeup and output smoothing, as the kernels' own Gain / Output (8 ms). */
const GAIN_SMOOTH_MS = 8

export const VOX_KERNEL_DEFAULTS = {
  /** Stage on/off. Off is a pure delay of the stage's latency. */
  peaksOn: true,
  bodyOn: true,
  /** The knobs: the 1176's Input and the LA-2A's Peak Reduction (0–100). */
  peaksInput: 50,
  bodyPeakReduction: 50,
  /**
   * Detector offsets, dB — the file's gated-RMS alignment (`alignDbForRms`),
   * MEASURED, never a user setting. The Body stage's is taken net of the
   * Peaks stage's makeup (see `setParams`).
   */
  peaksAlignDb: 0,
  bodyAlignDb: 0,
  /** The speaker's rumble corner, Hz — measured (voiceProfile.js). */
  cornerHz: DEFAULT_CORNER_HZ,
  /**
   * PER-STAGE MAKEUP — each compressor makes up its own level, as it would on
   * its own: the 1176's goes to its Output (the last multiply on its wet path,
   * its peak restore folded in), the LA-2A's to its Gain (before its valve),
   * with its restore in `makeupDb` after it. Each stage then runs into a
   * LOOKAHEAD LIMITER at the source's peak (`dsp/peakLimiter.js`). All
   * MEASURED (`measureVoxPressor`), never user settings.
   */
  peaksMakeupDb: 0,
  peaksCeilingDb: null,
  bodyMakeupDb: 0,
  bodyCeilingDb: null,
  /** The LA-2A stage's peak restore, dB — a gain after the LA-2A, before its limiter. */
  makeupDb: 0,
  /** Manual trim after the last limiter, dB. */
  outputDb: 0,
  /**
   * 'off' | 'peaks' | 'body' — play what that compressor's detector hears
   * instead of the output (the HF Softener's MONITOR contract). Never a preset.
   */
  listen: 'off',
  /** Bench overrides onto the pinned patches. Not panel params, not preset keys. */
  peaksBench: null,
  bodyBench: null,
  /**
   * Whether the PEAKS detector turns sibilance down. false SHIPS — see
   * `peaksTap`. A bench A/B, not a panel param.
   */
  peaksSibilance: false,
  /** Measurement mode: false runs both kernels at the base rate, latency 0. */
  oversample: true,
}

/**
 * What each compressor's detector turns down (dsp/voiceDetector.js).
 *
 * BODY hears neither plosives nor sibilance: an opto release is long, and an
 * "s" or a "p" in its detector ducks the rest of the phrase.
 *
 * ⚠ PEAKS HEARS BOTH, AND SIBILANCE WAS ADDED BACK AFTER IT SHIPPED SHELVED.
 * The makeup restores the processed peak to the source's, so EVERY peak the
 * 1176 cannot see sets the loudness of the whole region. With the −9 dB
 * sibilance shelf on its detector, one bright "s" on the owner's "Messy and
 * Bright" clip (−5.2 dBFS above 5 kHz, −41 below 300 Hz) went through the 1176
 * untouched, sat 4.4 dB above every other output peak, and pinned the makeup:
 * the clip came out 3.6 dB QUIETER than it went in, where the owner's
 * hand-built 1176 → LA-2A chain made it 3.3 dB louder. A peak catcher that
 * cannot see a class of peaks is not one. The "a compressor and a de-esser
 * both cutting an s lisps it" argument for the shelf belongs to a fast
 * leveler; here the cut is a peak trim of a few ms, and there is no de-esser
 * in the chain yet.
 */
export function peaksTap(sibilance) {
  return { plosive: false, sibilance: !!sibilance }
}
export const BODY_TAP = Object.freeze({ plosive: true, sibilance: true })

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function finite(v, fallback, lo, hi) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback
}

export class VoxPressorKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.fet = new FET1176Kernel(sampleRate)
    this.la2a = new LA2AKernel(sampleRate)
    this.peaksDetector = new VoiceDetector(sampleRate, peaksTap(VOX_KERNEL_DEFAULTS.peaksSibilance))
    this.bodyDetector = new VoiceDetector(sampleRate, BODY_TAP)

    // Per-channel scratch and bypass delay lines, grown on demand.
    this.midScratch = []
    this.peaksBypass = []
    this.bodyBypass = []
    this.peaksLimiter = new LinkedPeakLimiter(sampleRate)
    this.bodyLimiter = new LinkedPeakLimiter(sampleRate)

    this.makeupLinSmoothed = null
    this.outputLinSmoothed = null
    this.peaksGrHold = 0
    this.bodyGrHold = 0
    this.gainSmoothCoef = 1 - Math.exp(-1 / (sampleRate * (GAIN_SMOOTH_MS / 1000)))

    this.params = { ...VOX_KERNEL_DEFAULTS }
    this.setParams({})
  }

  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    this.oversampleOn = p.oversample !== false
    this.peaksOn = p.peaksOn !== false
    this.bodyOn = p.bodyOn !== false
    this.stageLatency = this.oversampleOn ? OVERSAMPLE_LATENCY_SAMPLES : 0

    const peaksInput = finite(p.peaksInput, 50, 0, 100)
    const peaksMakeupDb = finite(p.peaksMakeupDb, 0, -36, 36)
    this.fet.setParams({
      ...PEAKS_PATCH,
      inputDrive: peaksInput,
      ...(p.peaksBench ?? {}),
      inputAlignDb: finite(p.peaksAlignDb, 0, -60, 60),
      // Output cancels the Input's drive; the stage's makeup rides on it.
      outputGainDb: -inputDriveDbForKnob(peaksInput) + peaksMakeupDb,
      ceilingDb: null,
      oversample: this.oversampleOn,
    })
    this.la2a.setParams({
      ...BODY_PATCH,
      peakReduction: finite(p.bodyPeakReduction, 50, 0, 100),
      ...(p.bodyBench ?? {}),
      /**
       * ⚠ NET OF THE PEAKS STAGE'S MAKEUP. The LA-2A hears the 1176 stage's
       * output, which its makeup lifts by several dB (+4.7 on "Messy and
       * Bright" at the default). Aligned on the source alone, the Body knob's
       * meaning would move with the Peaks knob, and every makeup measurement
       * landing would shift the leveling under the listener. Level and drive
       * add in dB in the detector, so this cancels it exactly.
       */
      inputAlignDb: finite(p.bodyAlignDb, 0, -60, 60) - (this.peaksOn ? peaksMakeupDb : 0),
      gainDb: finite(p.bodyMakeupDb, 0, -24, 24),
      ceilingDb: null,
      oversample: this.oversampleOn,
    })
    // The Body stage's latency includes the LA-2A's lookahead (a bench
    // option), so its bypass line follows the kernel rather than a constant.
    this.bodyLatency = this.la2a.latencySamples
    /**
     * ⚠ LIMITERS, NOT SOFT CEILINGS. Both kernels' own `softCeiling` stays off:
     * a tanh knee bends the onsets the makeup lifts over the stage's input peak
     * — 0.15 % of the samples of a real clip, up to 3.3 dB deep — and a tanh
     * on a loud transient distorts (owner's verdict). A lookahead gain takes
     * the same onsets down without reshaping them. See `dsp/peakLimiter.js`.
     */
    this.peaksLimiter.setThreshold(this._ceilingLin(p.peaksCeilingDb))
    this.bodyLimiter.setThreshold(this._ceilingLin(p.bodyCeilingDb))

    if (this.peaksDetector.sibilance !== !!p.peaksSibilance) {
      this.peaksDetector = new VoiceDetector(this.sampleRate, peaksTap(p.peaksSibilance))
    }
    this.peaksDetector.setCornerHz(p.cornerHz)
    this.bodyDetector.setCornerHz(p.cornerHz)

    this.makeupLin = Math.exp(finite(p.makeupDb, 0, -24, 24) * LN10_OVER_20)
    this.outputLin = Math.exp(finite(p.outputDb, 0, -24, 24) * LN10_OVER_20)

    this.listen = p.listen === 'peaks' || p.listen === 'body' ? p.listen : 'off'
  }

  _ceilingLin(ceilingDb) {
    return Number.isFinite(ceilingDb) ? float32AtOrBelow(Math.exp(ceilingDb * LN10_OVER_20)) : 0
  }

  /** Constant whether a stage is on or off: both stages and both limiters. */
  get latencySamples() {
    return this.stageLatency + this.bodyLatency
      + this.peaksLimiter.latencySamples + this.bodyLimiter.latencySamples
  }

  /**
   * Gain reduction, dB (positive), for the meters: the MOST each stage did
   * since the last call, then reset.
   *
   * ⚠ HELD, NOT SAMPLED, because of the 1176. A peak catcher lets go within
   * tens of ms, and the worklet reports about every 17 ms, so the reduction
   * at the instant of a report is nearly always 0: the first build's Peaks
   * meter sat at 0 dB through playback that was trimming 3 dB off every loud
   * syllable. Holding the block maxima costs nothing and is what a meter
   * means. Called once per kernel block (the offline meter path), it reads
   * exactly what it did before.
   */
  getMetering() {
    const m = { peaksGrDb: this.peaksGrHold, bodyGrDb: this.bodyGrHold }
    this.peaksGrHold = 0
    this.bodyGrHold = 0
    return m
  }

  resetState() {
    this.fet = new FET1176Kernel(this.sampleRate)
    this.la2a = new LA2AKernel(this.sampleRate)
    this.peaksDetector.reset()
    this.bodyDetector.reset()
    for (const d of this.peaksBypass) d.reset()
    for (const d of this.bodyBypass) d.reset()
    this.peaksLimiter.reset()
    this.bodyLimiter.reset()
    this.makeupLinSmoothed = null
    this.outputLinSmoothed = null
    this.setParams({})
  }

  _grow(nCh, n) {
    while (this.midScratch.length < nCh) {
      this.midScratch.push(new Float32Array(0))
      this.peaksBypass.push(new DelayLine(this.stageLatency))
      this.bodyBypass.push(new DelayLine(this.bodyLatency))
    }
    for (let ch = 0; ch < nCh; ch++) {
      if (this.midScratch[ch].length < n) this.midScratch[ch] = new Float32Array(n)
      // A measurement-mode kernel and a rendering one want different lengths.
      if (this.peaksBypass[ch].length !== this.stageLatency) {
        this.peaksBypass[ch] = new DelayLine(this.stageLatency)
      }
      if (this.bodyBypass[ch].length !== this.bodyLatency) {
        this.bodyBypass[ch] = new DelayLine(this.bodyLatency)
      }
    }
  }

  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }
    this._grow(nOut, n)
    // Views cached per (channels, n): the worklet calls this ~345 times a
    // second with the same shape, and fresh arrays every block are garbage.
    if (!this.midViews || this.midViews.length !== nOut || this.midViewsN !== n
      || this.midViews.some((v, ch) => v.buffer !== this.midScratch[ch].buffer)) {
      this.midViews = this.midScratch.slice(0, nOut).map(c => c.subarray(0, n))
      this.midViewsN = n
    }
    const mid = this.midViews

    // ── PEAKS ──
    const peaksSc = this.peaksDetector.process(inputChannels, n)
    if (this.peaksOn) {
      this.fet.process(inputChannels, mid, n, peaksSc)
    } else {
      for (let ch = 0; ch < nOut; ch++) {
        const src = inputChannels[ch < nIn ? ch : nIn - 1]
        const line = this.peaksBypass[ch]
        const dst = mid[ch]
        for (let i = 0; i < n; i++) dst[i] = line.push(src[i])
      }
    }

    if (this.peaksOn && this.fet.grDb > this.peaksGrHold) this.peaksGrHold = this.fet.grDb
    this.peaksLimiter.process(mid, n)

    // ── BODY ── (its detector hears what PEAKS left)
    const bodySc = this.bodyDetector.process(mid, n)
    if (this.bodyOn) {
      this.la2a.process(mid, outputChannels, n, bodySc)
    } else {
      for (let ch = 0; ch < nOut; ch++) {
        const line = this.bodyBypass[ch]
        const src = mid[ch]
        const dst = outputChannels[ch]
        for (let i = 0; i < n; i++) dst[i] = line.push(src[i])
      }
    }

    if (this.bodyOn && this.la2a.grDb > this.bodyGrHold) this.bodyGrHold = this.la2a.grDb

    // ── LISTEN ── what a detector hears, in place of the output.
    if (this.listen !== 'off') {
      const sc = this.listen === 'peaks' ? peaksSc : bodySc
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].set(sc)
      return
    }

    // ── RESTORE → LIMITER → OUTPUT ── gains smoothed per sample.
    if (this.makeupLinSmoothed === null) this.makeupLinSmoothed = this.makeupLin
    if (this.outputLinSmoothed === null) this.outputLinSmoothed = this.outputLin
    this.makeupLinSmoothed = this._ramp(outputChannels, n, this.makeupLinSmoothed, this.makeupLin)
    this.bodyLimiter.process(outputChannels, n)
    this.outputLinSmoothed = this._ramp(outputChannels, n, this.outputLinSmoothed, this.outputLin)
  }

  /** Scale `io` by a gain gliding from `from` to `to`; returns where it got. */
  _ramp(io, n, from, to) {
    if (from === 1 && to === 1) return 1
    const c = this.gainSmoothCoef
    let g = from
    for (let ch = 0; ch < io.length; ch++) {
      const out = io[ch]
      g = from
      for (let i = 0; i < n; i++) {
        g += (to - g) * c
        out[i] *= g
      }
    }
    // Snap within float noise, so a settled gain is exact.
    return Math.abs(g - to) < 1e-9 ? to : g
  }
}

/**
 * Process a whole buffer through a fresh kernel. The tests and the measurements use
 * this; the app renders through the worklet (preview) and an
 * OfflineAudioContext running the same worklet (apply).
 */
export function processVoxPressorBuffer(channelData, sampleRate, params = {}, { meter = false, compensate = false } = {}) {
  const kernel = new VoxPressorKernel(sampleRate)
  kernel.setParams(params)
  // `compensate`: render `latency` samples long and drop the head, so the
  // output lines up with the input sample for sample (what the measurements compare).
  const lat = compensate ? kernel.latencySamples : 0
  const len = channelData[0].length
  if (lat > 0) {
    channelData = channelData.map((c) => {
      const q = new Float32Array(len + lat)
      q.set(c, 0)
      return q
    })
  }
  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  const peaksGr = meter ? new Float32Array(Math.ceil(n / BLOCK)) : null
  const bodyGr = meter ? new Float32Array(Math.ceil(n / BLOCK)) : null
  for (let off = 0, b = 0; off < n; off += BLOCK, b++) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
    )
    if (meter) {
      const m = kernel.getMetering()
      peaksGr[b] = m.peaksGrDb
      bodyGr[b] = m.bodyGrDb
    }
  }
  return {
    channelData: lat > 0 ? output.map(c => c.subarray(lat, lat + len)) : output,
    latencySamples: lat > 0 ? 0 : kernel.latencySamples,
    peaksGr,
    bodyGr,
  }
}

/**
 * The kernel's latency for these KERNEL params at this rate, without building
 * one — what the apply path renders long by and trims. Mirrors the
 * `latencySamples` getter; pinned against a real kernel by its test.
 */
export function voxLatencySamples(params, sampleRate) {
  const os = params?.oversample === false ? 0 : OVERSAMPLE_LATENCY_SAMPLES
  const body = la2aLatencySamples({ ...(params?.bodyBench ?? {}), oversample: params?.oversample }, sampleRate)
  return os + body + 2 * peakLimiterLatencySamples(sampleRate)
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  // Meter posts at roughly 60 Hz.
  const METER_INTERVAL_SAMPLES = 735

  class VoxPressorWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new VoxPressorKernel(sampleRate)
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
      this.frame += n
      if (this.frame >= METER_INTERVAL_SAMPLES) {
        this.frame = 0
        this.port.postMessage({ type: 'gr', ...this.kernel.getMetering() })
      }
      return true
    }
  }

  try {
    registerProcessor('vox-pressor-processor', VoxPressorWorkletProcessor)
  } catch (err) {
    if (err?.name !== 'NotSupportedError') throw err
  }
}
