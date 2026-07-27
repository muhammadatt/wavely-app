/**
 * LA-2A electro-optical leveling amplifier emulation — worklet kernel.
 *
 * This file is BOTH a normal ES module (exports LA2AKernel and
 * processLA2ABuffer for offline use and Node-based verification) AND an
 * AudioWorklet module (registers 'la2a-processor' when loaded into an
 * AudioWorkletGlobalScope). It must stay dependency-free: the worklet loads
 * it as a raw asset via `new URL(...)`, so imports would not resolve there.
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
 */

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
const SC_SHELF_HZ = 2000
const SC_SHELF_MAX_DB = 8
const DETECTOR_S = 0.0005 // light rectifier smoothing; the T4 model supplies the real ballistics

// Nominal operating level. The hardware's T4 threshold sits at line level
// (0 VU = +4 dBu), so Peak Reduction is referenced to that, not to digital
// full scale. Anchoring at 0 dBFS instead would make the cell ~18 dB deaf to
// normal program: narration at -20 dBFS RMS would need the knob near 95 to
// produce 3 dB of reduction. -18 dBFS is the EBU alignment.
const NOMINAL_DBFS = -18

// Peak Reduction knob → sidechain amplifier gain, spanning 40 dB.
// SC_TAPER < 1 models an audio-taper pot: the drive rises quickly off zero
// and flattens toward the top, so gain reduction starts around knob 20 and
// the everyday 3-6 dB range sits mid-dial rather than in the last third.
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

    // Metering
    this.grDb = 0
    this.maxGrDb = 0
    this.grSum = 0
    this.grActive = 0

    this.gainScratch = new Float32Array(128)

    this.params = { ...LA2A_KERNEL_DEFAULTS }
    this.setParams({})
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
    this.shelfGain = Math.pow(10, (SC_SHELF_MAX_DB * clamp(p.emphasis, 0, 1)) / 20) - 1
    this.makeupLin = Math.exp(p.gainDb * LN10_OVER_20)

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
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels  - per-channel input (any count)
   * @param {Float32Array[]} outputChannels - per-channel output to fill
   * @param {number} n                      - samples in this block
   */
  process(inputChannels, outputChannels, n) {
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
    const gain = this.gainScratch
    const chScale = 1 / nIn

    let { hpfLp, shelfLp, env, grFast, grSlow, memory } = this

    for (let i = 0; i < n; i++) {
      // Mono sidechain tap
      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale

      // Sidechain frequency mapping: 80 Hz HPF, then HF emphasis shelf
      hpfLp += (x - hpfLp) * this.hpfLpCoef
      const hp = x - hpfLp
      let sc = hp
      if (this.shelfGain > 0) {
        shelfLp += (hp - shelfLp) * this.shelfLpCoef
        sc = hp + this.shelfGain * (hp - shelfLp)
      }

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
      gain[i] = Math.exp(-grNow * LN10_OVER_20) * this.makeupLin
    }

    this.hpfLp = hpfLp
    this.shelfLp = shelfLp
    this.env = env
    this.grFast = grFast
    this.grSlow = grSlow
    this.memory = memory
    this.grDb = grFast + grSlow

    // Apply gain curve + tube stage per channel
    while (this.dcX.length < nOut) {
      this.dcX.push(0)
      this.dcY.push(0)
    }

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      let dcX = this.dcX[ch]
      let dcY = this.dcY[ch]
      for (let i = 0; i < n; i++) {
        const dry = input[i]
        let wet = dry * gain[i]
        if (this.applyTube) {
          const shaped = (Math.tanh(this.tubeDriveLin * wet + this.tubeBias) - this.tanhBias) / this.tubeNorm
          dcY = shaped - dcX + this.dcR * dcY
          dcX = shaped
          wet = dcY
        }
        out[i] = dry * this.dryMix + wet * this.wetMix
      }
      this.dcX[ch] = dcX
      this.dcY[ch] = dcY
    }
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
    metering: {
      maxGainReductionDb: m.maxGainReductionDb,
      avgGainReductionDb: m.avgGainReductionDb,
    },
  }
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

  registerProcessor('la2a-processor', LA2AWorkletProcessor)
}
