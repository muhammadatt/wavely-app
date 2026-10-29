/**
 * VoxPressor — worklet kernel. Stage 1: the voice detector and the
 * Peaks (1176) → Body (LA-2A) core. See docs/voxpressor_spec.md.
 *
 *   in ─┬─ VOICE DETECTOR (no plosive shelf) ─┐ sidechain
 *       │                                     ▼
 *       ├──────────────────────────── [PEAKS] FET1176Kernel, pinned peak-catcher patch
 *       │                                     │
 *       │      ┌─ VOICE DETECTOR (full) ◄─────┤ sidechain, read from the PEAKS output
 *       │      ▼                              │
 *       │   [BODY] LA2AKernel ◄───────────────┘
 *       │      │
 *       │   MAKEUP (measured) → CEILING (source peak, soft) → OUTPUT trim ─ out
 *
 * HOLDS THE KERNELS, NOT COPIES, as Scheps holds the LA-2A: every fitted
 * constant, ballistic law and saturation curve in either compressor reaches
 * this plugin with no conforming change. What is new here is only what they
 * LISTEN TO (`dsp/voiceDetector.js`, through each kernel's `sidechain`
 * argument) and how they are DRIVEN — both compressors are steered by a
 * detector-only offset (`inputAlignDb`) that the solves in
 * `voxPressorSolve.js` set per file, so neither one's audio gain moves when a
 * knob does.
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
import { LA2AKernel } from './la2aProcessor.js'
import { VoiceDetector, DEFAULT_CORNER_HZ } from './dsp/voiceDetector.js'
import { DelayLine, OVERSAMPLE_LATENCY_SAMPLES } from './dsp/oversample.js'
import {
  softCeiling, float32AtOrBelow, CEILING_KNEE_DB,
} from './dsp/makeupReference.js'

const LN10_OVER_20 = Math.LN10 / 20

/**
 * The 1176 as a peak catcher. Everything but the detector offset is pinned —
 * the Peaks knob asks for dB off the loudest peaks and the solve finds the
 * offset that delivers it.
 *
 * ⚠ ALL REASONED, TO AUDITION:
 * - ratio 12 — limiting, not leveling. The moving threshold puts 12:1's
 *   threshold 2.7 dB above 4:1's; the solve absorbs it.
 * - attack 6, release 6 (7 is fastest on both) — fast enough to take a
 *   consonant onset, one short of the end so a vowel's first cycle is not
 *   sliced and the release does not ride bass cycles.
 * - fetDrive 0 — a CLEAN peak trimmer. The colour in this plugin is the
 *   LA-2A's; a FET shaper running on every sample would colour the body the
 *   Peaks stage is promising to leave alone. On the bench.
 * - Input at 50 with Output cancelling its drive: the audio gain through the
 *   stage is unity, and the knee — which reads the KNOB's drive, not the
 *   aligned one (`kneeDbForDrive`) — is the knob-50 knee whatever the solve
 *   does.
 */
export const PEAKS_INPUT_KNOB = 50
export const PEAKS_PATCH = Object.freeze({
  ratio: '12',
  attack: 6,
  release: 6,
  fetDrive: 0,
  inputDrive: PEAKS_INPUT_KNOB,
  outputGainDb: -inputDriveDbForKnob(PEAKS_INPUT_KNOB),
  mix: 1,
  scHpfHz: 0,
  ceilingDb: null,
})

/**
 * The LA-2A as the leveler. Peak Reduction is pinned at its calibrated middle
 * and the solve moves the detector offset instead, so the panel's Body number
 * is a target amount of leveling rather than a knob position whose meaning
 * depends on the file. Everything else is the shipping LA Vintage 2A —
 * including its quartic cell and valve, which are this plugin's colour.
 */
export const BODY_PEAK_REDUCTION = 50
export const BODY_PATCH = Object.freeze({
  mode: 'compress',
  peakReduction: BODY_PEAK_REDUCTION,
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
  /** Detector offsets, dB — MEASURED by the solves, never a user setting. */
  peaksAlignDb: 0,
  bodyAlignDb: 0,
  /** The speaker's rumble corner, Hz — measured (voiceProfile.js). */
  cornerHz: DEFAULT_CORNER_HZ,
  /** Makeup gain, dB — measured (`solveVoxMakeup`). */
  makeupDb: 0,
  /** Output ceiling, dBFS (the source's peak) and its knee — measured with the makeup. */
  ceilingDb: null,
  ceilingKneeDb: null,
  /** Manual trim after the ceiling, dB. */
  outputDb: 0,
  /**
   * 'off' | 'peaks' | 'body' — play what that compressor's detector hears
   * instead of the output (the HF Softener's MONITOR contract). Never a preset.
   */
  listen: 'off',
  /** Bench overrides onto the pinned patches. Not panel params, not preset keys. */
  peaksBench: null,
  bodyBench: null,
  /** Measurement mode: false runs both kernels at the base rate, latency 0. */
  oversample: true,
}

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
    this.peaksDetector = new VoiceDetector(sampleRate, { plosive: false })
    this.bodyDetector = new VoiceDetector(sampleRate, { plosive: true })

    // Per-channel scratch and bypass delay lines, grown on demand.
    this.midScratch = []
    this.peaksBypass = []
    this.bodyBypass = []

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

    this.fet.setParams({
      ...PEAKS_PATCH,
      ...(p.peaksBench ?? {}),
      inputAlignDb: finite(p.peaksAlignDb, 0, -60, 60),
      oversample: this.oversampleOn,
    })
    this.la2a.setParams({
      ...BODY_PATCH,
      ...(p.bodyBench ?? {}),
      inputAlignDb: finite(p.bodyAlignDb, 0, -60, 60),
      oversample: this.oversampleOn,
    })

    this.peaksDetector.setCornerHz(p.cornerHz)
    this.bodyDetector.setCornerHz(p.cornerHz)

    this.makeupLin = Math.exp(finite(p.makeupDb, 0, -24, 24) * LN10_OVER_20)
    this.outputLin = Math.exp(finite(p.outputDb, 0, -24, 24) * LN10_OVER_20)
    this.ceilingLin = Number.isFinite(p.ceilingDb)
      ? float32AtOrBelow(Math.exp(p.ceilingDb * LN10_OVER_20)) : 0
    const kneeDb = Number.isFinite(p.ceilingKneeDb)
      ? clamp(p.ceilingKneeDb, 0, CEILING_KNEE_DB) : CEILING_KNEE_DB
    this.ceilingKneeLin = this.ceilingLin > 0
      ? this.ceilingLin * Math.exp(-kneeDb * LN10_OVER_20) : 0

    this.listen = p.listen === 'peaks' || p.listen === 'body' ? p.listen : 'off'
  }

  /** Constant: both stages' latency whether they are on or off. */
  get latencySamples() {
    return 2 * this.stageLatency
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
    this.makeupLinSmoothed = null
    this.outputLinSmoothed = null
    this.setParams({})
  }

  _grow(nCh, n) {
    while (this.midScratch.length < nCh) {
      this.midScratch.push(new Float32Array(0))
      this.peaksBypass.push(new DelayLine(this.stageLatency))
      this.bodyBypass.push(new DelayLine(this.stageLatency))
    }
    for (let ch = 0; ch < nCh; ch++) {
      if (this.midScratch[ch].length < n) this.midScratch[ch] = new Float32Array(n)
      // A measurement-mode kernel and a rendering one want different lengths.
      if (this.peaksBypass[ch].length !== this.stageLatency) {
        this.peaksBypass[ch] = new DelayLine(this.stageLatency)
        this.bodyBypass[ch] = new DelayLine(this.stageLatency)
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

    // ── MAKEUP → CEILING → OUTPUT ── smoothed per sample, once per block.
    if (this.makeupLinSmoothed === null) this.makeupLinSmoothed = this.makeupLin
    if (this.outputLinSmoothed === null) this.outputLinSmoothed = this.outputLin
    const identity = this.makeupLin === 1 && this.outputLin === 1
      && this.makeupLinSmoothed === 1 && this.outputLinSmoothed === 1
      && this.ceilingLin === 0
    if (identity) return

    const c = this.gainSmoothCoef
    let m = this.makeupLinSmoothed
    let o = this.outputLinSmoothed
    const mStart = m
    const oStart = o
    for (let ch = 0; ch < nOut; ch++) {
      const out = outputChannels[ch]
      m = mStart
      o = oStart
      for (let i = 0; i < n; i++) {
        m += (this.makeupLin - m) * c
        o += (this.outputLin - o) * c
        let y = out[i] * m
        if (this.ceilingLin > 0) y = softCeiling(y, this.ceilingLin, this.ceilingKneeLin)
        out[i] = y * o
      }
    }
    // Snap once within float noise, so a settled gain is exact.
    this.makeupLinSmoothed = Math.abs(m - this.makeupLin) < 1e-9 ? this.makeupLin : m
    this.outputLinSmoothed = Math.abs(o - this.outputLin) < 1e-9 ? this.outputLin : o
  }
}

/**
 * Process a whole buffer through a fresh kernel. The tests and the solves use
 * this; the app renders through the worklet (preview) and an
 * OfflineAudioContext running the same worklet (apply).
 */
export function processVoxPressorBuffer(channelData, sampleRate, params = {}, { meter = false } = {}) {
  const kernel = new VoxPressorKernel(sampleRate)
  kernel.setParams(params)
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
  return { channelData: output, latencySamples: kernel.latencySamples, peaksGr, bodyGr }
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
