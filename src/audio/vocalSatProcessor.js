/**
 * Vocal Saturation — worklet kernel.
 *
 * A realtime port of server/scripts/vocal_saturation.py: a complementary
 * three-band split, a blended tanh/arctan transfer with per-band drive, and a
 * gain-neutral parallel blend back against the dry signal.
 *
 * This file is BOTH a normal ES module (exports VocalSatKernel and
 * processVocalSatBuffer) AND an AudioWorklet module (registers
 * 'vocal-sat-processor'). It imports from ./dsp/, so its loader pulls it
 * through `?worker&url` — see vocalSatWorkletLoader.js.
 *
 * Two deliberate deviations from the Python, both consequences of the fact
 * that a streaming effect cannot see the whole file:
 *
 * 1. LEVEL MATCHING. The Python normalises twice against whole-file RMS —
 *    `wet *= dry_rms/wet_rms` then `output *= dry_rms/out_rms`. Here each of
 *    those three measurements is a one-pole follower (RMS_TAU_MS). The
 *    structure is identical; the values track programme level instead of being
 *    constant over the file. Followers are primed from the first sample so the
 *    opening of a region is not under-normalised.
 *
 * 2. OVERSAMPLING IS UNCONDITIONAL, where the Python's is gated.
 *
 *    The Python runs each band's nonlinearity at 2x whenever that band's
 *    effective drive reaches 0.5 (`_OVERSAMPLE_DRIVE_THRESHOLD`), which at
 *    default settings is the low band alone — mid and high sit at 0.2. This
 *    kernel oversamples all three, always.
 *
 *    Not gating is what keeps latency constant. The apply path trims a fixed
 *    number of samples, so a threshold that engaged as a knob crossed it would
 *    move the whole region on the timeline mid-drag. The Python's gate exists
 *    to save CPU in a batch job that has no such constraint.
 *
 *    Unconditional also means this side never aliases more than the server,
 *    at any setting — which the gated version could not promise. Where the
 *    Python skips a band, this one is slightly cleaner; where it oversamples,
 *    the two agree.
 *
 *    THIS FILE PREVIOUSLY DID NOT OVERSAMPLE AT ALL, on the strength of
 *    measurements that ran to 2 kHz and stopped. That was sound for narration,
 *    where the hard drive is on the low band and its harmonics have room below
 *    Nyquist. It does not hold for bright material. On a 12 kHz tone the second
 *    harmonic folded to 20.1 kHz at -50 dBc at defaults and -36 dBc at full
 *    drive fully wet; those are now -102 and -93.
 *
 *    On DENSE bright material the gain is smaller and worth stating honestly:
 *    2 to 4 dB in the audible band, because most of the non-harmonic energy
 *    there is real intermodulation between partials, which oversampling
 *    neither can nor should remove. What it removes is the folded part, which
 *    is concentrated above 16 kHz and improves by 16 to 25 dB. The audible-band
 *    win is largest on sparse bright sources — a cymbal ringing out, a bell, a
 *    synth tone — where there is little else to mask a folded partial.
 *
 *    The other half of that decision was that latency "would make this a
 *    latent effect and force delay compensation through the offline apply
 *    path". That machinery now exists and carries three other plugins.
 *
 *    Cost: about 5.9% of one core for stereo, against 2.2% before. Most of it
 *    is the three upsamplers. If that ever needs to come down, the low and mid
 *    bands are band-limited well below the transition and would be served by a
 *    much shorter filter than the high band needs.
 *
 * The band split stays at the base rate, as it is in the Python. That is not
 * incidental: designing the 500 Hz Butterworth at 2x instead moves its stopband
 * by 18 dB at 16 kHz, which would be a different effect, not a cleaner one.
 * Only the three transfer curves run high.
 */

import { lowpass, highpass, butterworthQs, BiquadCascade } from './dsp/biquad.js'
import { Oversampler, DelayLine, VOCAL_SAT_OVERSAMPLE } from './dsp/oversample.js'
import { RmsFollower, riseCoeff } from './dsp/envelope.js'

export const VOCAL_SAT_LATENCY_SAMPLES = VOCAL_SAT_OVERSAMPLE.latencySamples

export const VOCAL_SAT_KERNEL_DEFAULTS = {
  drive: 2.0,
  wetDry: 0.3,
  bias: 0.5,
  softness: 0.3,
  lowCrossover: 500,
  midCrossover: 3500,
  lowDriveMult: 5.0,
  midDriveMult: 0.1,
  highDriveMult: 0.1,
  // ── Medium control (see HF_LOSS_CORNER_HZ) ───────────────────────────────
  // 0-100, and ABSENT at 0 rather than flat: the filter is skipped outright, so
  // the patch that shipped before it existed is bit-identical. The same rule the
  // soft clipper's emphasis pair follows, and the thing that buys the right to
  // put medium colouring inside a plugin whose existing defaults people already
  // rely on.
  hfLoss: 0,
}

/**
 * HF LOSS — the top end softening as the medium is pushed, tape-style.
 *
 * ⚠ MOVED HERE FROM THE SOFT CLIPPER, where it was one third of that stage's
 * Drive knob. It never belonged there: the soft clipper's identity is
 * transparency and this is a colour, and — unlike the asymmetry it shipped
 * beside — it has no dependence at all on the clip curve or its threshold. It
 * is a plain linear filter, so the move is a copy rather than a re-derivation.
 *
 * WHAT IT MODELS, AND WHAT IT DELIBERATELY DOES NOT. Gap loss — the reproduce
 * head averaging flux across a finite gap — is `sinc(pi*g/lambda)`, a function
 * of gap width, tape speed and frequency and NOT of level. Modelled faithfully
 * it is an always-on shelf. What actually makes tape lose top end when pushed
 * is short-wavelength self-erasure, which is level-dependent. This is the
 * second one in spirit and a fixed shelf in fact: the depth is a knob, not an
 * envelope.
 *
 * ⚠ CONSTANT DEPTH, NOT ENVELOPE-FOLLOWING, and that was a correction made in
 * its previous home rather than a simplification made in this one. Following
 * the envelope gives full depth on a loud syllable and none through the pause
 * after it, which is a room that BREATHES — audible as pumping long before the
 * colour itself is. The smoother below stays so that moving the knob does not
 * click; the target does not move with the signal.
 *
 * THE STRUCTURE IS A BLEND, NOT A RECOMPUTED FILTER:
 *   out = g*x + (1-g)*lowpass(x)
 * one fixed one-pole and a per-sample `g`. That is exactly a first-order high
 * shelf — unity at DC, plateauing at `g` above the corner — with two properties
 * a moving biquad would not have. It is EXACTLY transparent at g = 1, so the
 * bypass is free rather than approximate. And it PROVABLY CANNOT BOOST:
 * |g + (1-g)*LP| <= g + (1-g)*|LP| <= 1 for any 0 <= g <= 1, since a one-pole
 * lowpass has magnitude at most 1 everywhere.
 *
 * MEASURED IN ITS PREVIOUS HOME, at full knob: -0.63 / -1.87 / -2.28 / -3.51 dB
 * at 2k / 4k / 8k / 16k with HF_LOSS_MAX_DB at 6, and -0.80 / -2.47 / -3.69 /
 * -6.00 at 12. Returns halve between 12 and 18, so 12 is the knee. The transfer
 * is a fixed linear filter and therefore file-independent; what varies between
 * recordings is only how much program each depth removes.
 *
 * ⚠ DEEPER HF LOSS THAN THIS NEEDS A LOWER CORNER OR A STEEPER FILTER, NOT A
 * BIGGER CONSTANT. The shelf saturates: as depth grows the output tends to the
 * one-pole itself and no further, so the constant scales the plateau and cannot
 * steepen the slope.
 */
const HF_LOSS_CORNER_HZ = 4000

/** Plateau depth at full knob, dB. See the note above for why 12 is the knee. */
const HF_LOSS_MAX_DB = 12

/**
 * Smoothing on the depth, ms. Only so a knob drag does not click — this is not
 * an envelope, and nothing about the signal moves it.
 */
const HF_LOSS_SMOOTH_MS = 30

const HF_LOSS_EPSILON = 1e-4

/**
 * ⚠ SOFTEN IS NOT HERE, AND THE ATTEMPT TO BRING IT IS WORTH RECORDING.
 *
 * Soften — a limit on how fast the waveform may move — was the soft clipper's
 * other colour control and was meant to land here beside HF Loss. It was built,
 * measured in three placements at three depths on real narration, and removed
 * again. What follows is why, so nobody spends the afternoon twice.
 *
 * WHAT IT NEEDS TO WORK: a CLEAN, BROADBAND signal, at the oversampled rate,
 * just ahead of ONE nonlinearity, with its allowance referenced near the level
 * that nonlinearity acts at. In the soft clipper it had all four, and took
 * 4-10 kHz down 3.31 dB at full knob while REDUCING that stage's own distortion
 * by 3.9 dB. This plugin's topology offers none of them:
 *
 *  - The band split means there is no broadband signal at the oversampled rate
 *    until AFTER the three transfer curves. Limiting there measured a tilt of
 *    +0.66 and +1.38 dB — HF RISING, on a control that provably cannot boost.
 *    Slew-limiting an already-saturated, LF-dominated sum makes it triangular,
 *    and a triangle is harmonics: past a certain depth it stops being a
 *    softener and becomes a distortion generator. At MIN_SCALE 0.001 that
 *    reaches +3.29 dB.
 *  - Limiting the high band alone before its transfer is inert — worst -0.13 dB
 *    at any depth, because that band is already band-limited and lightly driven.
 *  - Limiting all three bands before their transfers is the best of them and is
 *    still only -0.11 to -0.21 dB of tilt, and it turns positive too (+0.65) as
 *    soon as the depth is enough to bite the low band.
 *
 * So the ceiling on what Soften can do here is about -0.2 dB against -3.31 in
 * its previous home, and every route to more inverts its sign. A control that
 * is inert until it starts doing the opposite of its name is not a control.
 *
 * ⚠ THE SECOND HALF OF THE PROBLEM IS THE REFERENCE, and it is worth stating
 * separately because it would bite any future attempt. This plugin is not
 * level-invariant — drive multiplies absolute sample values into a fixed
 * tanh/arctan — so there is no tracked operating level to reference an
 * allowance to, and importing the clipper's gated speech tracker would mean
 * carrying a copy of its detector. Against a full-scale reference the shipped
 * MIN_SCALE of 0.02 puts the allowance at 0.0314, which sits at the p99 of the
 * wet path's own slope distribution (measured: p99 3.0e-2 to 5.5e-2, p50 1.8e-4
 * to 2.1e-3) — it bites the top 1% of samples and nothing else.
 *
 * ⚠ AND THE FIRST MEASUREMENT OF ALL THIS READ POSITIVE FOR A SECOND REASON
 * THAT IS NOT THE EFFECT. Soften would sit inside the wet path, upstream of
 * both `wet *= dryRms/wetRms` and `out *= dryRms/outRms`, so whatever energy it
 * removes is partly handed back as broadband gain. An absolute >4 kHz reading
 * therefore rises even where the filter is working. Any future attempt must
 * measure TILT — the band against the broadband — or it is measuring the level
 * match.
 */

/**
 * Time constant for the three level-matching followers. Long enough not to
 * pump on syllables, short enough to track a change of delivery.
 */
const RMS_TAU_MS = 300

// Matches the `+ 1e-8` in vocal_saturation.py's _rms, and keeps the two
// divisions below finite through silence.
const RMS_FLOOR = 1e-8

const TWO_OVER_PI = 2 / Math.PI

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Blended tanh/arctan transfer with the bias operating point removed.
 * Direct port of `_apply_transfer`.
 */
function applyTransfer(pre, softness, bias) {
  if (softness <= 0) return Math.tanh(pre) - Math.tanh(bias)
  if (softness >= 1) return TWO_OVER_PI * (Math.atan(pre) - Math.atan(bias))
  const yTanh = Math.tanh(pre)
  const yAtan = TWO_OVER_PI * Math.atan(pre)
  const biasRef =
    (1 - softness) * Math.tanh(bias) + softness * TWO_OVER_PI * Math.atan(bias)
  return (1 - softness) * yTanh + softness * yAtan - biasRef
}

/** Per-channel filter, follower, and resampler state. */
class ChannelState {
  constructor(sampleRate) {
    const qs = butterworthQs(4)
    this.lp = new BiquadCascade(qs.length, 1)
    this.hp = new BiquadCascade(qs.length, 1)
    this.dryRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    // Medium-control state: one lowpass accumulator for the HF shelf, at the
    // base rate — see HF_LOSS_CORNER_HZ.
    this.hfLossLp = 0
    this.wetRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.outRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)

    // One upsampler per band, because each band is filtered at the base rate
    // and only then taken up. The three saturated bands are summed while still
    // at the high rate, so a single downsampler serves all of them.
    this.upLow = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upMid = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upHigh = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.downWet = new Oversampler(VOCAL_SAT_OVERSAMPLE)

    // The blend `x + wetDry * wet` is a sample-accurate sum, so the dry side
    // has to wait for the wet side to come back down.
    this.dryLine = new DelayLine(VOCAL_SAT_OVERSAMPLE.latencySamples)
  }
}

export class VocalSatKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.butterQs = butterworthQs(4)
    this.channels = []
    this.params = { ...VOCAL_SAT_KERNEL_DEFAULTS }
    // Smoothed HF-loss depth. Per KERNEL rather than per channel: it is a
    // parameter ramp, not a measurement, so every channel must reach the same
    // depth at the same instant or a stereo image shifts while a knob moves.
    this.hfLossDb = 0
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived state. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const nyquist = this.sampleRate / 2
    this.lowCrossover = clamp(p.lowCrossover, 20, nyquist * 0.98)
    this.midCrossover = clamp(p.midCrossover, this.lowCrossover + 1, nyquist * 0.98)

    // butter(4, ...) → two biquad sections; sosfilt is causal, so a direct
    // cascade matches it.
    this.lpSections = this.butterQs.map(q => lowpass(this.sampleRate, this.lowCrossover, q))
    this.hpSections = this.butterQs.map(q => highpass(this.sampleRate, this.midCrossover, q))
    for (const c of this.channels) {
      c.lp.setSections(this.lpSections)
      c.hp.setSections(this.hpSections)
    }

    // ── Medium control ───────────────────────────────────────────────────
    // Read as 0-100 and ABSENT below the epsilon, so the shipped patch runs
    // no filter and takes no branch.
    this.hfLossMaxDb = (clamp(p.hfLoss ?? 0, 0, 100) / 100) * HF_LOSS_MAX_DB
    this.hfLossActive = this.hfLossMaxDb > HF_LOSS_EPSILON
    this.hfLossCoef = riseCoeff(1000 / (2 * Math.PI * HF_LOSS_CORNER_HZ), this.sampleRate)
    this.hfLossSmoothCoef = riseCoeff(HF_LOSS_SMOOTH_MS, this.sampleRate)

    this.softness = clamp(p.softness, 0, 1)
    this.bias = p.bias
    this.wetDry = Math.max(0, p.wetDry)
    this.lowDrive = p.drive * p.lowDriveMult
    this.midDrive = p.drive * p.midDriveMult
    this.highDrive = p.drive * p.highDriveMult
  }

  _ensureChannels(n) {
    while (this.channels.length < n) {
      const c = new ChannelState(this.sampleRate)
      c.lp.setSections(this.lpSections)
      c.hp.setSections(this.hpSections)
      this.channels.push(c)
    }
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

    const { softness, bias, wetDry, lowDrive, midDrive, highDrive } = this
    const L = VOCAL_SAT_OVERSAMPLE.factor

    const { low: lowBuf, high: highBuf, mid: midBuf, wet: wetBuf } = this._scratch(n)

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const st = this.channels[ch]

      // Band split at the base rate, as in vocal_saturation.py:
      //   low  = sosfilt(sos_lp, audio)
      //   high = sosfilt(sos_hp, audio)
      //   mid  = audio - low - high      (complementary — sums back exactly)
      st.lp.process(input, lowBuf, n, 0)
      st.hp.process(input, highBuf, n, 0)
      for (let i = 0; i < n; i++) midBuf[i] = input[i] - lowBuf[i] - highBuf[i]

      // Up to the high rate one band at a time. Upsampling is linear, so the
      // three still sum back to the input there — the complementary split is
      // preserved, and each band meets its own transfer curve with room above
      // it for the harmonics that curve creates.
      const lowUp = st.upLow.up(lowBuf, n)
      const midUp = st.upMid.up(midBuf, n)
      const highUp = st.upHigh.up(highBuf, n)

      const sum = st.downWet.scratch(n)
      for (let j = 0; j < n * L; j++) {
        sum[j] =
          applyTransfer(lowUp[j] * lowDrive + bias, softness, bias) +
          applyTransfer(midUp[j] * midDrive + bias, softness, bias) +
          applyTransfer(highUp[j] * highDrive + bias, softness, bias)
      }

      st.downWet.down(wetBuf, n)

      // Level matching and the blend stay at the base rate, where the Python
      // does them. The dry side is delayed to meet the wet side.
      for (let i = 0; i < n; i++) {
        const x = st.dryLine.push(input[i])
        const wet = wetBuf[i]

        const dryRms = st.dryRms.process(x)
        const wetRms = st.wetRms.process(wet)

        // wet *= dry_rms / wet_rms
        const wetMatched = wet * (dryRms / wetRms)
        // output = audio + wet_dry * wet
        const blended = x + wetDry * wetMatched
        // output *= dry_rms / out_rms
        const outRms = st.outRms.process(blended)
        let y = blended * (dryRms / outRms)

        // HF LOSS — see HF_LOSS_CORNER_HZ.
        //
        // ⚠ ON THE FINISHED OUTPUT, NOT ON THE WET PATH, and that is a claim
        // about what is being modelled. This is the MEDIUM's bandwidth, not
        // the saturation's: a tape machine does not roll off only the part of
        // the signal that saturated. Blending a dulled copy underneath a
        // full-bandwidth dry copy nets very little HF change at any ordinary
        // Wet/Dry, which is the measurement that settles it rather than the
        // metaphor.
        //
        // ⚠ AFTER THE OUTPUT NORMALISATION, deliberately. Placed before it,
        // the `dry_rms / out_rms` match would read the energy this filter just
        // removed as a level drop and push the whole signal back up to
        // compensate — the level match undoing the tone control, silently.
        //
        // ⚠ THE COST: Wet/Dry 0 is no longer the dry signal once this is
        // engaged. That is intended and is the one place this plugin's
        // parallel-blend contract is deliberately broken, because a medium the
        // dry path bypasses is not a medium. The knob is absent at 0, so the
        // contract holds for anyone who does not reach for it.
        if (this.hfLossActive) {
          this.hfLossDb += this.hfLossSmoothCoef * (this.hfLossMaxDb - this.hfLossDb)
          const g = Math.pow(10, -this.hfLossDb / 20)
          st.hfLossLp += this.hfLossCoef * (y - st.hfLossLp)
          y = g * y + (1 - g) * st.hfLossLp
        }

        out[i] = y > 1 ? 1 : y < -1 ? -1 : y
      }
    }
  }

  /**
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims. Constant at every setting — see the note at the top
   * about why the Python's per-band gate is not reproduced here.
   */
  get latencySamples() {
    return VOCAL_SAT_LATENCY_SAMPLES
  }

  /**
   * Band scratch buffers, grown on demand. Float64 so the complementary
   * subtraction `mid = x - low - high` does not lose precision before the
   * nonlinearity sees it. Channels are processed sequentially, so one pair
   * serves all of them.
   */
  _scratch(n) {
    if (!this._lowBuf || this._lowBuf.length < n) {
      this._lowBuf = new Float64Array(n)
      this._highBuf = new Float64Array(n)
      this._midBuf = new Float64Array(n)
      this._wetBuf = new Float64Array(n)
    }
    return {
      low: this._lowBuf, high: this._highBuf, mid: this._midBuf, wet: this._wetBuf,
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by verification scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share the same code path.
 */
export function processVocalSatBuffer(channelData, sampleRate, params = {}) {
  const kernel = new VocalSatKernel(sampleRate)
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
  class VocalSatWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new VocalSatKernel(sampleRate)
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

  registerProcessor('vocal-sat-processor', VocalSatWorkletProcessor)
}
