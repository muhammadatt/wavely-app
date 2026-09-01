/**
 * INFLATOR — worklet kernel.
 *
 * A port of Kiriki-liszt/JS_Inflator, itself a reimplementation of the Sonnox
 * Inflator. The curve, the coefficient law, the fold-back region, the
 * 240/2400 Hz split and the signal order are the reference's; see dsp/inflator.js
 * for the algebra and for the four properties that make the curve worth porting
 * exactly rather than approximating.
 *
 * This file is BOTH a normal ES module (exports InflatorKernel and
 * processInflatorBuffer) AND an AudioWorklet module (registers
 * 'inflator-processor'). It imports from ./dsp/, so its loader pulls it through
 * `?worker&url` — see inflatorWorkletLoader.js.
 *
 * ── WHAT THIS PLUGIN IS FOR ────────────────────────────────────────────────
 *
 * It raises quiet material without moving the ceiling. f(1) = 1 at every Curve
 * setting while f'(0) = 1.5 + p, so the small signals come up 3.5 dB at the
 * default and full scale stays exactly where it was. That is a different
 * mechanism from every other density control in this app: the compressors pull
 * the loud parts DOWN and hand the level back as makeup, the soft clipper
 * reshapes the peaks. This one lifts everything underneath and leaves the peaks
 * alone.
 *
 * ⚠ SO IT IS NOT A PEAK CONTROLLER AND MUST NOT BE SOLD AS ONE. The curve
 * cannot reduce a peak — f(s) ≤ 1 is a ceiling, not a reduction — and with the
 * Clip switch off, material ABOVE full scale is folded back toward zero rather
 * than limited. The soft clipper is the stage that controls peaks; this one is
 * placed before it.
 *
 * ── THREE DELIBERATE DIVERGENCES FROM THE REFERENCE ────────────────────────
 *
 * 1. OVERSAMPLING IS FIXED AT 4x AND UNCONDITIONAL, where the reference offers
 *    1x/2x/4x/8x and a minimum/linear-phase choice.
 *
 *    The same reasoning vocalSatProcessor.js records: the apply path trims a
 *    fixed number of samples, so a factor that changed under a running preview
 *    would move the whole region on the timeline mid-drag. A selectable factor
 *    is a research control, and this codebase already learned that lesson
 *    expensively — the soft clipper's Limiter knob changes its latency and was
 *    moved off the faceplate for it, and its apply path shipped a bug trimming
 *    50 samples off a 226-sample render.
 *
 *    ⚠ THE REFERENCE DEFAULTS TO 1x, i.e. NO oversampling, which for a quartic
 *    with a fold-back corner aliases audibly. 4x is COMPRESSOR_OVERSAMPLE, the
 *    profile the soft clipper and both compressors already use, and it is
 *    chosen for exactly this: a hard-kneed polynomial's products need the
 *    headroom more than they need the last kilohertz of passband.
 *
 * 2. THE MINIMUM-PHASE PATH IS THE ONLY ONE. The reference's linear-phase mode
 *    routes through r8b and costs 3388-3465 samples of latency (77 ms at
 *    44.1 kHz) against the FIR path's 49-60. Our profile is linear phase
 *    already, at 50 samples, because it is a halfband FIR rather than a general
 *    resampler — so the choice the reference offers does not arise here.
 *
 * 3. EFFECT DEFAULTS TO 50%, NOT 0%. A VST must be inaudible until asked, so
 *    the reference ships fully dry. This app opens a plugin engaged and metering,
 *    and a panel that does nothing on open reads as broken — the same argument
 *    that has the soft clipper measure and place its ceiling on open. 50% is
 *    audible and not committal.
 *
 * ── WHAT IS FAITHFUL, AND VERIFIED SO ──────────────────────────────────────
 *
 * The per-sample order is the reference's exactly: input gain, optional +-1
 * clip, unconditional +-2 clamp, DRY CAPTURED HERE, curve (oversampled),
 * optional post-curve +-1 clip, downsample, blend against the delayed dry,
 * output gain.
 *
 * ⚠ THE DRY IS CAPTURED AFTER THE INPUT GAIN AND AFTER THE CLIP, which is the
 * reference's placement and is load-bearing: it makes Effect a blend between
 * two signals at the SAME level, so the knob is a character control rather
 * than a second input gain. It also means Effect 0 is not the plugin's input —
 * it is the input with Input Gain and Clip applied. Both of those are dry-path
 * controls by design.
 */

import { Oversampler, DelayLine, COMPRESSOR_OVERSAMPLE } from './dsp/oversample.js'
import { inflatorCoefficients, inflatorCurve, InflatorBandSplit } from './dsp/inflator.js'

const OVERSAMPLE = COMPRESSOR_OVERSAMPLE

export const INFLATOR_LATENCY_SAMPLES = OVERSAMPLE.latencySamples

export const INFLATOR_KERNEL_DEFAULTS = {
  // dB, -12..+12. Drives the curve: the effect is NOT level-invariant, so this
  // is how far up the curve the material sits and therefore how much lift it
  // gets. See the note on property 2 in dsp/inflator.js.
  inputDb: 0,
  // dB, -12..0. Only ever cuts, matching the reference — the curve already
  // raises the level and an output stage that could raise it further would make
  // every A/B a loudness comparison.
  outputDb: 0,
  // 0..1 wet/dry. ABSENT at 0: the curve is skipped outright, so the dry path
  // is the delayed input exactly. The house rule the soft clipper's emphasis
  // pair and the tube saturator's HF Loss both follow.
  effect: 0.5,
  // -50..+50 %. Shape only — the ceiling does not move with it.
  curve: 0,
  // Hard clip at +-1 before AND after the curve. Off by default, as in the
  // reference. See the note on the fold-back below.
  clip: false,
  // Run the curve on three bands rather than on the broadband signal.
  bandSplit: false,
}

/** Per-channel state: resamplers, the dry delay line, and the split. */
class ChannelState {
  constructor(oversampledRate) {
    this.up = new Oversampler(OVERSAMPLE)
    this.down = new Oversampler(OVERSAMPLE)
    // The blend is a sample-accurate sum, so the dry side waits for the wet
    // side to come back down.
    this.dry = new DelayLine(OVERSAMPLE.latencySamples)
    // ⚠ THE SPLIT RUNS AT THE OVERSAMPLED RATE, as in the reference — its
    // filters sit inside the oversampled loop. That matters beyond placement:
    // the mid band's drive G is a function of fc/Fs, so a split built at the
    // base rate would drive the mid band by a different amount (1.1099 against
    // 1.1110). Small, and wrong for no reason.
    this.split = new InflatorBandSplit(oversampledRate)
  }
}

export class InflatorKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.oversampledRate = sampleRate * OVERSAMPLE.factor
    this.channels = []
    this.params = { ...INFLATOR_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived state. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    this.inGain = dbToLin(clamp(p.inputDb, -12, 12))
    this.outGain = dbToLin(clamp(p.outputDb, -12, 0))
    this.effect = clamp(p.effect, 0, 1)
    this.co = inflatorCoefficients(p.curve)
    this.clip = !!p.clip
    this.bandSplit = !!p.bandSplit

    // ⚠ THIS IS A CPU SAVING, NOT A CORRECTNESS ONE — and the first version of
    // this comment claimed otherwise. It said skipping the wet path was what
    // made Effect 0 bit-exact, by keeping the oversampler's own ~-70 dBc
    // reconstruction error out of the output. Mutation testing disproved it:
    // forcing `wetActive = true` leaves every test passing, because the blend
    // multiplies the wet side by exactly zero and a finite value times zero is
    // zero. The bit-exactness comes from the multiply, not from the branch.
    //
    // The branch is still worth having — it skips two resamplers, the curve and
    // (with Split on) three filter updates per oversampled sample, on a patch
    // that provably cannot use any of them. It is just not load-bearing for the
    // guarantee, and saying so is what stops someone "simplifying" the multiply
    // away on the strength of a comment that was wrong.
    this.wetActive = this.effect > 0
  }

  _ensureChannels(n) {
    while (this.channels.length < n) {
      this.channels.push(new ChannelState(this.oversampledRate))
    }
  }

  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    this._ensureChannels(nOut)

    const { inGain, outGain, effect, co, clip, bandSplit, wetActive } = this
    const L = OVERSAMPLE.factor
    const preBuf = this._scratch(n)

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const st = this.channels[ch]

      // ── Base rate: input gain, optional clip, the +-2 guard ──────────────
      // The reference's order, and the dry signal is what comes out of here.
      for (let i = 0; i < n; i++) {
        let x = input[i] * inGain
        if (clip) x = x > 1 ? 1 : x < -1 ? -1 : x
        // ⚠ ALWAYS, even with Clip off. Past +-2 the fold-back parabola has
        // already returned to zero and would turn back up; this is the guard
        // that keeps the curve single-valued, not a taste control.
        preBuf[i] = x > 2 ? 2 : x < -2 ? -2 : x
      }

      if (!wetActive) {
        // Effect 0 — the delayed dry path, exactly. Still delayed, because the
        // reported latency has to hold at every setting or the apply path
        // trims the wrong amount when the knob happens to be down.
        for (let i = 0; i < n; i++) out[i] = st.dry.push(preBuf[i]) * outGain
        continue
      }

      // ── Oversampled: the curve ───────────────────────────────────────────
      const up = st.up.up(preBuf, n)
      const wet = st.down.scratch(n)

      if (bandSplit) {
        const g = st.split.g
        const gInv = st.split.gInv
        for (let j = 0; j < n * L; j++) {
          const b = st.split.process(up[j])
          // The mid band is driven harder into the curve and scaled back after
          // — the reference's `process_inflator(mid * G) * GR`. Note this is a
          // drive change, not a level change: GR undoes G exactly, so what
          // survives is the extra curvature the mid band saw, and nothing else.
          let y =
            inflatorCurve(b.low, co) +
            inflatorCurve(b.mid * g, co) * gInv +
            inflatorCurve(b.high, co)
          if (clip) y = y > 1 ? 1 : y < -1 ? -1 : y
          wet[j] = y
        }
      } else {
        for (let j = 0; j < n * L; j++) {
          let y = inflatorCurve(up[j], co)
          if (clip) y = y > 1 ? 1 : y < -1 ? -1 : y
          wet[j] = y
        }
      }

      st.down.down(wet, n)

      // ── Base rate: blend and output gain ─────────────────────────────────
      for (let i = 0; i < n; i++) {
        const dry = st.dry.push(preBuf[i])
        out[i] = (dry * (1 - effect) + wet[i] * effect) * outGain
      }
    }
  }

  /**
   * Algorithmic latency, in samples. Constant at every setting — including
   * Effect 0, where the dry path is delayed to match rather than passed
   * through. The apply path renders long and trims by this figure.
   */
  get latencySamples() {
    return INFLATOR_LATENCY_SAMPLES
  }

  /** Pre-curve scratch, grown on demand. Channels run sequentially. */
  _scratch(n) {
    if (!this._preBuf || this._preBuf.length < n) this._preBuf = new Float64Array(n)
    return this._preBuf
  }
}

function dbToLin(db) {
  return Math.pow(10, db / 20)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by tests and verification scripts; the app renders through an
 * OfflineAudioContext running the worklet, so preview and apply share a path.
 */
export function processInflatorBuffer(channelData, sampleRate, params = {}) {
  const kernel = new InflatorKernel(sampleRate)
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
  class InflatorWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new InflatorKernel(sampleRate)
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

  registerProcessor('inflator-processor', InflatorWorkletProcessor)
}
