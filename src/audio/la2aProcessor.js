/**
 * LA-2A electro-optical leveling amplifier emulation — worklet kernel.
 *
 * This file is BOTH a normal ES module (exports LA2AKernel and
 * processLA2ABuffer for offline use and Node-based verification) AND an
 * AudioWorklet module (registers 'la2a-processor' when loaded into an
 * AudioWorkletGlobalScope). Its loader goes through `?worker&url`, which
 * bundles whatever it imports into one self-contained chunk — see
 * la2aWorkletLoader.js.
 *
 * The same kernel instance therefore runs in three places with identical
 * results: real-time preview (AudioContext), offline apply
 * (OfflineAudioContext), and Node verification scripts.
 *
 * Modeled hardware behaviors:
 *
 * 1. T4 optical cell (electroluminescent panel + LDR pair)
 *    - Fixed ~10 ms attack (the panel's turn-on time; not user-adjustable
 *      on the hardware).
 *    - Dual-stage release: a fast stage recovers ~50% of the gain reduction
 *      in 50–60 ms, followed by a slow phosphorescent tail.
 *    - LDR memory: the slow tail's time constant stretches from ~0.5 s to
 *      ~5 s depending on how hard and how long the panel was previously lit.
 *
 * 2. Program-dependent ratio
 *    - Compress mode: gentle, wide-knee curve whose effective ratio drifts
 *      from ~3:1 toward ~4:1 as the sidechain is driven harder.
 *    - Limit mode: narrower knee, ratio climbing from ~12:1 toward ~20:1.
 *    - There is no threshold control on the hardware: the Peak Reduction
 *      knob is sidechain amplifier gain, driving the signal into a fixed
 *      internal threshold. Modeled the same way here.
 *    - That threshold is anchored to nominal analog operating level
 *      (0 VU = -18 dBFS), not to digital full scale — see NOMINAL_DBFS.
 *
 * 3. Sidechain frequency mapping + tube stage
 *    - Sidechain: one-pole 80 Hz high-pass (the cell barely responds to
 *      rumble) plus an R37-style HF emphasis shelf (0 to +8 dB above 2 kHz)
 *      that makes the unit progressively de-ess as it's turned up.
 *    - Output path: asymmetric tanh waveshaper approximating the harmonic
 *      profile of the input/driver/output tube stages (bias term → 2nd
 *      harmonic, tanh curvature → 3rd), followed by a DC blocker.
 *
 * OVERSAMPLING. The gain cell and the tube stage run at OVERSAMPLE_FACTOR times
 * the base rate; the detector, the T4 ballistics and the gain computer stay at
 * the base rate, where their time constants were tuned. That split is
 * deliberate: only the multiply and the waveshaper generate new frequency
 * content, so only they need the headroom, and keeping the ballistics where
 * they were means the unit still sounds like itself.
 *
 * This one benefits more than its FET counterpart, because the Gain knob sits
 * BEFORE the tube stage (as on the hardware). With auto-makeup engaged — the
 * app's default — a Peak Reduction of 70 hands the tubes about 14 dB more
 * signal than the raw defaults suggest, so the stage was being driven hard
 * exactly when nobody had asked for distortion. At 44.1 kHz that measured
 * -40 dBc of folded product on a 9 kHz tone.
 *
 * The cost is OVERSAMPLE_LATENCY_SAMPLES of latency. Both the dry side of the
 * wet/dry blend and the gain envelope are delay-compensated inside the kernel,
 * so a parallel setting still lines up; the offline apply path compensates the
 * whole-plugin delay via `latencySamples`.
 */

import {
  Oversampler, DelayLine, OVERSAMPLE_FACTOR,
  OVERSAMPLE_LATENCY_SAMPLES, UPSAMPLE_DELAY_SAMPLES,
} from './dsp/oversample.js'

export { OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES }

// ── T4 optical cell constants ───────────────────────────────────────────────

const ATTACK_S = 0.010 // EL panel turn-on

// Fraction of gain reduction held by the fast stage, and its release tau.
// Together tuned so total recovery hits ~50% at 50–60 ms regardless of the
// slow tail's current length.
const FAST_FRACTION = 0.65
const FAST_RELEASE_S = 0.035

// Slow-tail release range; position within the range is driven by the
// LDR memory state.
const SLOW_RELEASE_MIN_S = 0.5
const SLOW_RELEASE_MAX_S = 5.0

// LDR memory: integrates gain reduction over time. Charges while the panel
// is lit, bleeds off slowly after. MEM_HALF_DB is the accumulated level (dB
// of GR) at which the slow tail sits halfway through its range.
const MEM_CHARGE_S = 0.8
const MEM_DISCHARGE_S = 8.0
const MEM_HALF_DB = 2.5

// ── Sidechain constants ─────────────────────────────────────────────────────

const SC_HPF_HZ = 80

/**
 * R37 side-chain pre-emphasis.
 *
 * An ATTENUATOR of lows, not a booster of highs — the distinction decides what
 * the control can actually do. On the hardware R37 is a trimmer in a passive
 * network, and a passive network cannot boost: "emphasis" is achieved by
 * discarding low frequencies and letting the side-chain amplifier make the
 * level back up. Factory position is fully clockwise, which is flat; turning it
 * counter-clockwise progressively filters the side-chain so the cell stops
 * responding to the low end. `emphasis` here runs 0 (flat, factory) to 1 (fully
 * counter-clockwise), so the parameter increases in the direction the hardware
 * knob turns for more filtering.
 *
 * This was modelled backwards until it was measured against a plosive: as a
 * high SHELF BOOST from unity it left the lows at full level, so sweeping it
 * moved the gain reduction on a 120 Hz thump by 0.06 dB — and upward, because
 * the Peak Reduction knob drives a FIXED internal threshold, so adding
 * side-chain gain adds compression. Attenuating instead gives the control
 * authority over the thing it exists to reject.
 */
const SC_SHELF_HZ = 1000
const SC_SHELF_MAX_DB = 10
const DETECTOR_S = 0.0005 // light rectifier smoothing; the T4 model supplies the real ballistics

// Nominal operating level. The hardware's T4 threshold sits at line level
// (0 VU = +4 dBu), so Peak Reduction is referenced to that, not to digital
// full scale. Anchoring at 0 dBFS instead would make the cell ~18 dB deaf to
// normal program: narration at -20 dBFS RMS would need the knob near 95 to
// produce 3 dB of reduction. -18 dBFS is the EBU alignment.
const NOMINAL_DBFS = -18

// Peak Reduction knob → detector-sidechain drive (anchored to NOMINAL_DBFS), spanning 40 dB.
// Effective endpoints: -2 dB at knob 0 and +38 dB at knob 100.
// SC_TAPER < 1 models an audio-taper pot: the drive rises quickly off zero
// and flattens toward the top, so gain reduction starts around knob 20.
const SC_DRIVE_MIN_DB = -20
const SC_DRIVE_SPAN_DB = 40
const SC_TAPER = 0.7

// ── Gain computer constants ─────────────────────────────────────────────────

const COMPRESS_KNEE_DB = 20 // wide knee — the "leveling" feel
const LIMIT_KNEE_DB = 6

const LN10_OVER_20 = Math.LN10 / 20

export const LA2A_KERNEL_DEFAULTS = {
  mode: 'compress', // 'compress' | 'limit'
  peakReduction: 50, // 0–100, sidechain drive (hardware Peak Reduction knob)
  gainDb: 0, // makeup gain (hardware Gain knob)
  tubeDrive: 0.3, // 0–1 tube stage saturation amount
  emphasis: 0, // 0–1 R37 HF sidechain emphasis (0 = flat, stock)
  mix: 1, // wet/dry blend
  /**
   * Run the gain cell and tube stage oversampled. Always true for anything
   * anyone listens to; see `computeAutoMakeupDb` for the one caller that turns
   * it off and why that is sound.
   */
  oversample: true,
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass (the slow
 * release coefficient refreshes once per block, so keep blocks <= a few ms —
 * the 128-sample render quantum is ideal).
 */
export class LA2AKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate

    this.attackCoef = 1 - Math.exp(-1 / (sampleRate * ATTACK_S))
    this.fastRelCoef = 1 - Math.exp(-1 / (sampleRate * FAST_RELEASE_S))
    this.detCoef = 1 - Math.exp(-1 / (sampleRate * DETECTOR_S))
    this.memChargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_CHARGE_S))
    this.memDischargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_DISCHARGE_S))
    this.hpfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_HPF_HZ / sampleRate)
    this.shelfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_SHELF_HZ / sampleRate)
    // DC blocker pole (~5 Hz) — the asymmetric shaper shifts the operating point
    this.dcR = 1 - 2 * Math.PI * 5 / sampleRate

    // Sidechain / T4 state
    this.hpfLp = 0
    this.shelfLp = 0
    this.env = 0
    this.grFast = 0
    this.grSlow = 0
    this.memory = 0
    this.slowRelCoef = 1 - Math.exp(-1 / (sampleRate * SLOW_RELEASE_MIN_S))

    // Per-channel DC blocker state (grown on demand)
    this.dcX = []
    this.dcY = []

    // Per-channel oversamplers and dry-path delay lines (grown on demand).
    this.oversamplers = []
    this.dryLines = []

    // The gain envelope is computed once per block at the base rate and shared
    // by every channel, so it is delayed once, here, rather than per channel.
    //
    // One sample SHORT of the upsampler's delay, deliberately. Interpolating a
    // gain across the oversampled sub-samples needs both endpoints, and the
    // later one has to be in hand before the earlier one is used. Holding the
    // envelope one sample less makes `gain[i]` the newer endpoint and last
    // block's `gain[i-1]` the older one, which is exactly the pair the ramp in
    // `process` consumes.
    this.gainDelay = new DelayLine(Math.max(0, UPSAMPLE_DELAY_SAMPLES - 1))
    // Last gain of the previous block, for interpolating across the block seam.
    this.lastGain = 1

    // Metering
    this.grDb = 0
    this.maxGrDb = 0
    this.grSum = 0
    this.grActive = 0

    this.gainScratch = new Float32Array(128)
    this.wetScratch = new Float64Array(128)

    this.params = { ...LA2A_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Clear every feedback path in the cell and the tube stage. */
  resetState() {
    this.hpfLp = 0
    this.shelfLp = 0
    this.env = 0
    this.grFast = 0
    this.grSlow = 0
    this.memory = 0
    this.lastGain = 1
    this.dcX = this.dcX.map(() => 0)
    this.dcY = this.dcY.map(() => 0)
    this.gainDelay.reset()
    for (const line of this.dryLines) line?.reset()
  }

  /** Merge a partial param update and recompute derived coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    this.isLimit = p.mode === 'limit'
    this.kneeDb = this.isLimit ? LIMIT_KNEE_DB : COMPRESS_KNEE_DB
    this.halfKnee = this.kneeDb / 2

    // Peak Reduction 0–100 → sidechain gain on an audio taper, into a fixed
    // internal threshold referenced to nominal level. Endpoints are -2 dB at
    // knob 0 and +38 dB at knob 100.
    const knob = clamp(p.peakReduction, 0, 100) / 100
    this.scDriveDb =
      SC_DRIVE_MIN_DB - NOMINAL_DBFS + SC_DRIVE_SPAN_DB * Math.pow(knob, SC_TAPER)
    // Gain applied to the side-chain's sub-1 kHz content: 1 at emphasis 0
    // (flat), down to -10 dB fully counter-clockwise. Above the corner the
    // side-chain stays at unity, so this only ever removes drive — see
    // SC_SHELF_MAX_DB.
    this.shelfLowGain = Math.pow(10, (-SC_SHELF_MAX_DB * clamp(p.emphasis, 0, 1)) / 20)
    this.makeupLin = Math.exp((Number.isFinite(p.gainDb) ? p.gainDb : 0) * LN10_OVER_20)

    // Tube stage. Drive can go sub-unity (slope is normalized back to 1
    // below): at the default amount a -6 dBFS peak lands around H3 ≈ -40 dBc
    // — tube warmth at nominal level, not overdrive. Max reaches ~-22 dBc.
    const amount = clamp(p.tubeDrive, 0, 1)
    this.applyTube = amount > 0
    this.tubeDriveLin = 0.25 + 1.5 * amount
    this.tubeBias = 0.2 * amount
    this.tanhBias = Math.tanh(this.tubeBias)
    // Normalize so the shaper has unity small-signal gain
    this.tubeNorm = this.tubeDriveLin * (1 - this.tanhBias * this.tanhBias)

    this.wetMix = clamp(p.mix, 0, 1)
    this.dryMix = 1 - this.wetMix

    this.oversampleOn = p.oversample !== false
  }

  /**
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims.
   *
   * Constant across every setting a listener can reach — the oversampled path
   * runs even at `tubeDrive: 0`, so switching the tube stage off cannot shift
   * the timeline underneath a running preview. It is zero only in the
   * measurement mode described on `oversample`, which nothing renders through.
   */
  get latencySamples() {
    return this.oversampleOn ? OVERSAMPLE_LATENCY_SAMPLES : 0
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels  - per-channel input (any count)
   * @param {Float32Array[]} outputChannels - per-channel output to fill
   * @param {number} n                      - samples in this block
   */
  process(inputChannels, outputChannels, n) {
    // A non-finite value anywhere in the cell's state is unrecoverable on its
    // own: env, grFast, grSlow and memory all feed back into themselves, so one
    // NaN makes every future block NaN and the effect goes silent for good.
    // Params are validated at the boundary, but this kernel is embedded by
    // other plugins and reached from a message port, so it also heals itself.
    // One comparison per block.
    if (!Number.isFinite(this.env + this.grFast + this.grSlow + this.memory)) {
      this.resetState()
    }

    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    // Refresh the slow-release coefficient from the LDR memory state — the
    // memory moves on ~1 s time scales, once per block is plenty.
    const memNorm = this.memory / (this.memory + MEM_HALF_DB)
    const slowTau = SLOW_RELEASE_MIN_S + (SLOW_RELEASE_MAX_S - SLOW_RELEASE_MIN_S) * memNorm
    this.slowRelCoef = 1 - Math.exp(-1 / (this.sampleRate * slowTau))

    if (this.gainScratch.length < n) this.gainScratch = new Float32Array(n)
    if (this.wetScratch.length < n) this.wetScratch = new Float64Array(n)
    const gain = this.gainScratch
    const chScale = 1 / nIn

    let { hpfLp, shelfLp, env, grFast, grSlow, memory } = this

    for (let i = 0; i < n; i++) {
      // Mono sidechain tap
      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale

      // Sidechain frequency mapping: 80 Hz HPF, then the R37 emphasis filter.
      hpfLp += (x - hpfLp) * this.hpfLpCoef
      const hp = x - hpfLp
      // Split at the corner and attenuate only the low half. Run
      // unconditionally rather than skipped at emphasis 0: it is algebraically
      // the identity there (lowGain 1 sums the two halves back to hp), and
      // skipping it would leave the one-pole holding stale state for the knob
      // to jump off when it next moves.
      shelfLp += (hp - shelfLp) * this.shelfLpCoef
      const sc = (hp - shelfLp) + this.shelfLowGain * shelfLp

      // Rectify + light smoothing
      const rect = sc < 0 ? -sc : sc
      env += (rect - env) * this.detCoef

      // Static curve: overshoot above the fixed internal threshold after
      // sidechain drive; ratio itself is program-dependent (grows with drive).
      const levelDb = env > 1e-6 ? 20 * Math.log10(env) : -120
      const over = levelDb + this.scDriveDb
      let grTarget = 0
      if (over > -this.halfKnee) {
        const ratio = this.isLimit
          ? 12 + 8 * (over > 0 ? over / (over + 6) : 0)
          : 3 + (over > 0 ? over / (over + 10) : 0)
        const slope = 1 - 1 / ratio
        if (over <= this.halfKnee) {
          const t = over + this.halfKnee
          grTarget = slope * t * t / (2 * this.kneeDb)
        } else {
          grTarget = slope * over
        }
      }

      // LDR memory: charges while gain reduction is demanded, bleeds off after
      memory += (grTarget - memory) *
        (grTarget > memory ? this.memChargeCoef : this.memDischargeCoef)

      // T4 dynamics. Attack splits the incoming reduction across both stages
      // so a release from any state recovers ~50% at the fast rate. Release
      // decays each stage toward its share of the current target (not zero)
      // so sustained program holds its reduction.
      const gr = grFast + grSlow
      if (grTarget > gr) {
        const delta = (grTarget - gr) * this.attackCoef
        grFast += delta * FAST_FRACTION
        grSlow += delta * (1 - FAST_FRACTION)
      } else {
        grFast += (grTarget * FAST_FRACTION - grFast) * this.fastRelCoef
        grSlow += (grTarget * (1 - FAST_FRACTION) - grSlow) * this.slowRelCoef
      }

      const grNow = grFast + grSlow
      if (grNow > this.maxGrDb) this.maxGrDb = grNow
      if (grNow > 0.05) {
        this.grSum += grNow
        this.grActive++
      }
      // Held back to meet the audio where it emerges inside the oversampled
      // section, which the upsampler has delayed by UPSAMPLE_DELAY_SAMPLES.
      // Without this the reduction would arrive early — a small look-ahead the
      // hardware does not have. In the base-rate measurement path there is
      // nothing to meet, so the delay would only misalign it.
      const g = Math.exp(-grNow * LN10_OVER_20) * this.makeupLin
      gain[i] = this.oversampleOn ? this.gainDelay.push(g) : g
    }

    this.hpfLp = hpfLp
    this.shelfLp = shelfLp
    this.env = env
    this.grFast = grFast
    this.grSlow = grSlow
    this.memory = memory
    this.grDb = grFast + grSlow

    // Apply gain curve + tube stage per channel, at the oversampled rate.
    while (this.dcX.length < nOut) {
      this.dcX.push(0)
      this.dcY.push(0)
    }
    // Built only when they will be used. The measurement path runs the whole
    // kernel several times over a selection and never touches them, and their
    // filter tables are not free to allocate.
    if (this.oversampleOn) {
      while (this.oversamplers.length < nOut) {
        this.oversamplers.push(new Oversampler())
        this.dryLines.push(new DelayLine(OVERSAMPLE_LATENCY_SAMPLES))
      }
    }

    const L = OVERSAMPLE_FACTOR
    const invL = 1 / L
    // Every channel interpolates from the same block-seam value, so it is read
    // before the loop and advanced once after it.
    const seamGain = this.lastGain
    const wet = this.wetScratch

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]

      if (!this.oversampleOn) {
        this._processChannelBaseRate(input, out, gain, n, ch)
        continue
      }

      const hi = this.oversamplers[ch].up(input, n)

      // The multiply is itself a nonlinearity — a fast-moving gain against
      // program material generates sum and difference content — so the gain is
      // interpolated up to the oversampled rate rather than held in steps, and
      // the product is formed there.
      // The ramp starts AT gCur rather than one step past it. The halfband
      // upsampler's even branch is a pure delay, so sub-sample j = 0 is the
      // original input sample, not an interpolated point — it has to receive
      // the gain computed from it, exactly. Starting the ramp a step later left
      // that sample holding three quarters of the PREVIOUS gain. On very fast attacks
      // (e.g. FET Punch dial 7 ≈ 20 µs) that was most of the reduction a transient
      // should have received, so the first sample of a hard onset passed through nearly
      // unattenuated and read as a click.
      let gCur = seamGain
      for (let i = 0; i < n; i++) {
        const gNext = gain[i]
        const step = (gNext - gCur) * invL
        for (let j = 0; j < L; j++) {
          const k = i * L + j
          let w = hi[k] * (gCur + step * j)
          if (this.applyTube) {
            w = (Math.tanh(this.tubeDriveLin * w + this.tubeBias) - this.tanhBias) / this.tubeNorm
          }
          hi[k] = w
        }
        gCur = gNext
      }

      this.oversamplers[ch].down(wet, n)

      // Back at the base rate: the DC blocker is linear and generates nothing,
      // so it costs nothing to run down here. The dry side of the blend is the
      // untouched input, delayed to meet the wet side.
      let dcX = this.dcX[ch]
      let dcY = this.dcY[ch]
      const dryLine = this.dryLines[ch]
      for (let i = 0; i < n; i++) {
        let w = wet[i]
        if (this.applyTube) {
          dcY = w - dcX + this.dcR * dcY
          dcX = w
          w = dcY
        }
        const dry = dryLine.push(input[i])
        out[i] = dry * this.dryMix + w * this.wetMix
      }
      this.dcX[ch] = dcX
      this.dcY[ch] = dcY
    }

    if (n > 0) this.lastGain = gain[n - 1]
  }

  /**
   * Measurement-only path: the same arithmetic at the base rate, with no
   * resampling and therefore no latency. See the counterpart in
   * fet1176Processor.js for why this exists and why it is sound.
   */
  _processChannelBaseRate(input, out, gain, n, ch) {
    let dcX = this.dcX[ch]
    let dcY = this.dcY[ch]
    for (let i = 0; i < n; i++) {
      const dry = input[i]
      let w = dry * gain[i]
      if (this.applyTube) {
        const shaped = (Math.tanh(this.tubeDriveLin * w + this.tubeBias) - this.tanhBias) / this.tubeNorm
        dcY = shaped - dcX + this.dcR * dcY
        dcX = shaped
        w = dcY
      }
      out[i] = dry * this.dryMix + w * this.wetMix
    }
    this.dcX[ch] = dcX
    this.dcY[ch] = dcY
  }

  getMetering() {
    return {
      grDb: this.grDb,
      maxGainReductionDb: this.maxGrDb,
      avgGainReductionDb: this.grActive > 0 ? this.grSum / this.grActive : 0,
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh
 * kernel. Used by Node verification scripts; the app itself renders through
 * an OfflineAudioContext running the worklet so preview and apply share the
 * exact same code path.
 */
export function processLA2ABuffer(channelData, sampleRate, params = {}) {
  const kernel = new LA2AKernel(sampleRate)
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

  const m = kernel.getMetering()
  return {
    channelData: output,
    latencySamples: kernel.latencySamples,
    metering: {
      maxGainReductionDb: m.maxGainReductionDb,
      avgGainReductionDb: m.avgGainReductionDb,
    },
  }
}

/**
 * RMS across every sample of every channel, optionally skipping a leading
 * stretch.
 *
 * The skip exists for the oversampler's latency: the first
 * OVERSAMPLE_LATENCY_SAMPLES of a processed buffer are the filters' ramp-up,
 * not signal, and including them would bias the measurement quietly downward.
 * Over a region of any real length the effect is tiny, but the auto-makeup that
 * depends on it is exactly the thing users judge bypass A/B by.
 */
/**
 * Peak magnitude across every sample of every channel, in dB.
 *
 * The makeup reference. Peak rather than RMS, and the distinction is the whole
 * point of makeup gain: the compressor pulls the loud moments down, makeup
 * hands back what it took, the peaks land where they started and everything
 * underneath rises with them. That is a compressor made louder without being
 * merely turned up — which is the comparison a listener is actually running
 * when they A/B it.
 *
 * Matching RMS instead, as this did, returns only the average loss and
 * therefore leaves the output exactly as loud as the input: a compressor that
 * by construction cannot make anything louder.
 *
 * TRUE PEAK, not a high percentile, and that was measured. A percentile of
 * short-block peaks looks more robust and is worse where it matters: on real
 * speech a fast transient can survive compression almost intact while the p99
 * comes down several dB, so percentile-referenced makeup over-compensates and
 * pushes that survivor ABOVE the source — up to 5.5 dB above, measured. True
 * peak cannot do that; the guarantee it buys is exact.
 *
 * The cost is the opposite failure: a single uncompressed click sets the
 * reference and the makeup comes out small. That is the safe direction — never
 * louder than the source — and the manual trim is there for it.
 */
function peakOfChannels(channels, skip = 0) {
  let peak = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i]
      if (v > peak) peak = v
    }
  }
  return peak
}

function rmsOfChannels(channels, skip = 0) {
  let sumSq = 0
  let count = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) sumSq += ch[i] * ch[i]
    count += Math.max(0, ch.length - skip)
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0
}

/**
 * Compute the makeup gain (dB) that restores the processed signal's PEAK to
 * the input's — the classic makeup convention. See `peakOfChannels` for why
 * peak and not RMS, and why not a percentile either.
 *
 * Measured, not derived from the curve: the kernel is run over the actual
 * audio and the output's peak compared to the input's.
 *
 * Iterated because makeup is applied *before* the tube stage (as on the
 * hardware, where the Gain knob drives the output amplifier). Raising
 * makeup therefore drives the tubes slightly harder, which shifts the
 * output level a little, so each pass re-measures at the corrected
 * operating point. The loop stops as soon as a correction lands under
 * `toleranceDb`, which for most settings means two passes; only extreme
 * ones (max peak reduction into max tube drive) need three or four.
 *
 * The caller's manual Gain trim is deliberately excluded — this returns the
 * unity-restoring offset, and any trim is a deliberate deviation added on
 * top of it.
 */
export function computeAutoMakeupDb(channelData, sampleRate, params = {}, options = {}) {
  const { maxIterations = 4, toleranceDb = 0.05 } = options

  // Measured through the base-rate path: oversampling removes folded
  // harmonics, which carry almost no energy, and measuring through it was
  // about three times slower — which the Gain knob showed as lag behind a
  // drag. It does move the peak slightly more than it moves the RMS, so the
  // iteration below re-measures rather than trusting one pass.
  const measureParams = { ...params, oversample: false }

  const inputPeak = peakOfChannels(channelData)
  if (inputPeak <= 0) return 0

  let makeupDb = 0
  for (let i = 0; i < maxIterations; i++) {
    const { channelData: out } = processLA2ABuffer(channelData, sampleRate, {
      ...measureParams,
      gainDb: makeupDb,
    })
    const outPeak = peakOfChannels(out)
    if (outPeak <= 0) break
    const correctionDb = 20 * Math.log10(inputPeak / outPeak)
    makeupDb = clamp(makeupDb + correctionDb, -24, 24)
    if (Math.abs(correctionDb) < toleranceDb) break
  }
  return makeupDb
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

// `registerProcessor` and the `sampleRate` global exist only inside an
// AudioWorkletGlobalScope. When this file is imported as a normal module
// (main bundle, Node), this block is skipped.
if (typeof registerProcessor === 'function') {
  // Post gain-reduction metering every ~21 ms at 44.1 kHz — enough for a
  // smooth meter without flooding the message port.
  const METER_INTERVAL_SAMPLES = 1024

  class LA2AWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new LA2AKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
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

      this.sinceMeter += n
      if (this.sinceMeter >= METER_INTERVAL_SAMPLES) {
        this.sinceMeter = 0
        this.port.postMessage({ type: 'gr', grDb: this.kernel.grDb })
      }
      return true
    }
  }

  // Guarded, because this module reaches a worklet scope by two routes: its own
  // loader, and as a dependency of the Scheps worklet, which composes
  // LA2AKernel. Load both into one AudioContext and the second bundle's
  // registration hits a name that is already taken and throws NotSupportedError
  // — which would abort that whole module, taking the Scheps processor with it
  // over a duplicate nobody needed. Already-registered is the desired state, so
  // swallow exactly that and nothing else.
  try {
    registerProcessor('la2a-processor', LA2AWorkletProcessor)
  } catch (err) {
    if (err?.name !== 'NotSupportedError') throw err
  }
}
