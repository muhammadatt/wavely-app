/**
 * 1176-style FET limiting amplifier emulation ("FET Punch") — worklet kernel.
 *
 * Companion to la2aProcessor.js (OptoSmooth). Same contract: this file is
 * BOTH a normal ES module (exports FET1176Kernel and processFET1176Buffer for
 * offline use and Node-based verification) AND an AudioWorklet module
 * (registers 'fet1176-processor' when loaded into an AudioWorkletGlobalScope).
 * It must stay dependency-free: the worklet loads it as a raw asset via
 * `new URL(...)`, so imports would not resolve there.
 *
 * The same kernel therefore runs in three places with identical results:
 * real-time preview (AudioContext), offline apply (OfflineAudioContext), and
 * Node verification scripts.
 *
 * Where the LA-2A is slow, optical and self-effacing, this one is the
 * opposite, and the model is built around the differences that matter:
 *
 * 1. FET gain element, not a light bulb
 *    - Attack is user-set from 800 us (dial 1) down to 20 us (dial 7), which
 *      is short enough that the gain cell tracks individual waveform peaks
 *      rather than an envelope. That is where the "grab" comes from.
 *    - Release runs 1.1 s (dial 1) to 50 ms (dial 7).
 *    - Both dials are REVERSED on the hardware: 7 is the fastest position,
 *      not the slowest. Modeled the same way so the UI can print the dial
 *      number the way the panel does.
 *
 * 2. Program-dependent release
 *    - The control-voltage network does not discharge on a single time
 *      constant. A minority share of the reduction hangs on a slower tail,
 *      so dense program recovers more slowly than isolated peaks.
 *
 * 3. Input as the only threshold control
 *    - Like the LA-2A there is no threshold knob. Input is an attenuator
 *      ahead of a fixed internal threshold, and it feeds the audio path as
 *      well as the detector, so turning it up raises level AND compression
 *      together. Output then brings it back down. That interaction is the
 *      whole gain-staging feel of the unit and is modeled directly.
 *    - The threshold is referenced to nominal analog operating level
 *      (0 VU = -18 dBFS), matching the LA-2A model's NOMINAL_DBFS.
 *
 * 4. Ratio buttons, including all-buttons-in
 *    - 4:1, 8:1, 12:1 and 20:1 select progressively tighter knees.
 *    - Pressing every button at once ("British mode") is not a ratio at all:
 *      it drops the effective threshold, bends the curve so the ratio climbs
 *      with level, lags the attack, lengthens the release tail and pushes the
 *      FET much harder. Modeled as its own mode rather than as a number.
 *
 * 5. Detector and output stage
 *    - Broadband detector (the hardware has no sidechain filter); an optional
 *      one-pole sidechain high-pass is offered as a modern extension so
 *      plosives and rumble don't duck a narration track.
 *    - Asymmetric tanh waveshaper standing in for the FET plus class-A output
 *      amp, followed by a DC blocker.
 */

// ── Level reference ─────────────────────────────────────────────────────────

// Nominal operating level (0 VU = +4 dBu). The internal threshold sits at
// line level on the hardware, so Input is referenced to that rather than to
// digital full scale — see the same constant in la2aProcessor.js.
const NOMINAL_DBFS = -18
const THRESHOLD_DBFS = NOMINAL_DBFS

// Input knob 0-100 -> drive into the fixed threshold, spanning 40 dB
// (-24 dB at knob 0, +16 dB at knob 100). IN_TAPER < 1 models the hardware's
// stepped audio-taper attenuator: level rises quickly off zero and flattens
// toward the top.
const IN_DRIVE_MIN_DB = -24
const IN_DRIVE_SPAN_DB = 40
const IN_TAPER = 0.8

// ── Ballistics ──────────────────────────────────────────────────────────────

// Dial 1 (slowest) and dial 7 (fastest) endpoints; positions in between are
// interpolated geometrically, as the hardware's switched resistor ladder does.
const ATTACK_SLOWEST_S = 0.0008
const ATTACK_FASTEST_S = 0.00002
const RELEASE_SLOWEST_S = 1.1
const RELEASE_FASTEST_S = 0.05

// Program-dependent release: this share of the reduction recovers on a tail
// this many times slower than the dial setting.
const TAIL_FRACTION = 0.22
const TAIL_MULT = 4

// All-buttons-in holds far more of the reduction on the slow tail, which is
// what makes it pump and breathe instead of releasing cleanly.
const ALL_TAIL_FRACTION = 0.45
const ALL_TAIL_MULT = 6

// ── Gain computer ───────────────────────────────────────────────────────────

// Tighter knees as the ratio climbs — 4:1 is a comparatively gentle curve,
// 20:1 is nearly a corner.
const RATIO_VALUES = { 4: 4, 8: 8, 12: 12, 20: 20 }
const RATIO_KNEE_DB = { 4: 10, 8: 8, 12: 6, 20: 3 }

// All-buttons-in: a wide, badly-behaved knee whose effective ratio climbs
// with overshoot, over a threshold pulled down by ALL_THRESHOLD_DROP_DB.
const ALL_KNEE_DB = 16
const ALL_THRESHOLD_DROP_DB = 6
const ALL_RATIO_MIN = 6
const ALL_RATIO_SPAN = 14
const ALL_RATIO_HALF_DB = 12 // overshoot at which the ratio sits mid-range
// The famously late attack: the dial still sets the rate, but everything
// arrives slower than the number says.
const ALL_ATTACK_LAG = 2.5
// ...and the FET is driven much harder, which is most of the "sound".
const ALL_FET_BOOST = 1.6

const LN10_OVER_20 = Math.LN10 / 20

export const FET1176_KERNEL_DEFAULTS = {
  inputDrive: 50, // 0-100, drive into the fixed threshold (hardware Input knob)
  outputGainDb: 0, // makeup (hardware Output knob)
  attack: 4, // dial 1-7, 7 = fastest (hardware markings)
  release: 4, // dial 1-7, 7 = fastest (hardware markings)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  fetDrive: 0.35, // 0-1 FET / output-amp saturation amount
  scHpfHz: 0, // 0 = off (stock), or sidechain high-pass corner in Hz
  mix: 1, // wet/dry blend — parallel compression
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Geometric interpolation between the dial-1 and dial-7 endpoints. */
function dialToSeconds(dial, slowestS, fastestS) {
  const t = (clamp(dial, 1, 7) - 1) / 6
  return slowestS * Math.pow(fastestS / slowestS, t)
}

/**
 * Attack/release time actually modeled at a given dial position. Exported so
 * the panel can print the real number under the knob instead of carrying a
 * second, drift-prone copy of the table.
 */
export function attackSecondsForDial(dial) {
  return dialToSeconds(dial, ATTACK_SLOWEST_S, ATTACK_FASTEST_S)
}

export function releaseSecondsForDial(dial) {
  return dialToSeconds(dial, RELEASE_SLOWEST_S, RELEASE_FASTEST_S)
}

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass (block size
 * affects nothing — every coefficient is fixed at setParams time).
 */
export class FET1176Kernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate

    // DC blocker pole (~5 Hz) — the asymmetric shaper shifts the operating point
    this.dcR = 1 - 2 * Math.PI * 5 / sampleRate

    // Sidechain / detector state
    this.hpfLp1 = 0
    this.hpfLp2 = 0
    this.grMain = 0
    this.grTail = 0

    // Per-channel DC blocker state (grown on demand)
    this.dcX = []
    this.dcY = []

    // Metering
    this.grDb = 0
    this.maxGrDb = 0
    this.grSum = 0
    this.grActive = 0

    this.gainScratch = new Float32Array(128)

    this.params = { ...FET1176_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived coefficients. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    const sr = this.sampleRate

    this.isAllButtons = String(p.ratio) === 'all'
    if (this.isAllButtons) {
      this.kneeDb = ALL_KNEE_DB
      this.thresholdDb = THRESHOLD_DBFS - ALL_THRESHOLD_DROP_DB
      this.tailFraction = ALL_TAIL_FRACTION
      this.tailMult = ALL_TAIL_MULT
    } else {
      const ratioKey = RATIO_VALUES[p.ratio] ? p.ratio : '4'
      this.ratio = RATIO_VALUES[ratioKey]
      this.slope = 1 - 1 / this.ratio
      this.kneeDb = RATIO_KNEE_DB[ratioKey]
      this.thresholdDb = THRESHOLD_DBFS
      this.tailFraction = TAIL_FRACTION
      this.tailMult = TAIL_MULT
    }
    this.halfKnee = this.kneeDb / 2
    this.mainFraction = 1 - this.tailFraction

    // Ballistics. Attack is applied to the whole reduction; release splits
    // across a main stage and a slower tail.
    let attackS = dialToSeconds(p.attack, ATTACK_SLOWEST_S, ATTACK_FASTEST_S)
    if (this.isAllButtons) attackS *= ALL_ATTACK_LAG
    const releaseS = dialToSeconds(p.release, RELEASE_SLOWEST_S, RELEASE_FASTEST_S)

    this.attackCoef = 1 - Math.exp(-1 / (sr * attackS))
    this.releaseCoef = 1 - Math.exp(-1 / (sr * releaseS))
    this.tailCoef = 1 - Math.exp(-1 / (sr * releaseS * this.tailMult))

    // Input attenuator: audio path and detector both, as on the hardware.
    const knob = clamp(p.inputDrive, 0, 100) / 100
    this.inputDriveDb = IN_DRIVE_MIN_DB + IN_DRIVE_SPAN_DB * Math.pow(knob, IN_TAPER)
    this.inputLin = Math.exp(this.inputDriveDb * LN10_OVER_20)
    this.outputLin = Math.exp(p.outputGainDb * LN10_OVER_20)

    // Optional sidechain high-pass (0 = off, the stock broadband detector).
    // Two cascaded one-poles: a single pole leaves too much of a 60-80 Hz
    // plosive in the detector to be worth switching on.
    this.scHpfOn = p.scHpfHz > 0
    this.hpfLpCoef = this.scHpfOn
      ? 1 - Math.exp(-2 * Math.PI * p.scHpfHz / sr)
      : 0

    // FET + class-A output amp. Drive can go sub-unity (the slope is
    // normalized back to 1 below), so `fetDrive` sets harmonic content
    // without changing level.
    const amount = clamp(p.fetDrive, 0, 1)
    this.applyFet = amount > 0
    this.fetDriveLin = (0.3 + 2.2 * amount) * (this.isAllButtons ? ALL_FET_BOOST : 1)
    this.fetBias = 0.15 * amount
    this.tanhBias = Math.tanh(this.fetBias)
    // Normalize so the shaper has unity small-signal gain
    this.fetNorm = this.fetDriveLin * (1 - this.tanhBias * this.tanhBias)

    this.wetMix = clamp(p.mix, 0, 1)
    this.dryMix = 1 - this.wetMix
  }

  /** Static curve: overshoot in dB -> gain reduction in dB. */
  _grForOvershoot(over) {
    if (over <= -this.halfKnee) return 0
    const slope = this.isAllButtons
      ? 1 - 1 / (ALL_RATIO_MIN + ALL_RATIO_SPAN * (over > 0 ? over / (over + ALL_RATIO_HALF_DB) : 0))
      : this.slope
    if (over >= this.halfKnee) return slope * over
    const t = over + this.halfKnee
    return slope * t * t / (2 * this.kneeDb)
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

    if (this.gainScratch.length < n) this.gainScratch = new Float32Array(n)
    const gain = this.gainScratch
    const chScale = 1 / nIn

    let { hpfLp1, hpfLp2, grMain, grTail } = this

    for (let i = 0; i < n; i++) {
      // Mono sidechain tap, taken after the input attenuator
      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale * this.inputLin

      let sc = x
      if (this.scHpfOn) {
        hpfLp1 += (x - hpfLp1) * this.hpfLpCoef
        const hp1 = x - hpfLp1
        hpfLp2 += (hp1 - hpfLp2) * this.hpfLpCoef
        sc = hp1 - hpfLp2
      }

      // Full-wave rectified peak detector. There is deliberately no envelope
      // smoothing here: at the fast attack settings the gain cell is meant to
      // track the waveform itself, and the release network supplies the only
      // meaningful time constant on the way back down.
      const rect = sc < 0 ? -sc : sc
      const levelDb = rect > 1e-6 ? 20 * Math.log10(rect) : -120
      const grTarget = this._grForOvershoot(levelDb - this.thresholdDb)

      // Attack pulls both stages toward their share of the target together;
      // release lets each stage decay at its own rate, which is what makes
      // recovery depend on how dense the program was.
      const gr = grMain + grTail
      if (grTarget > gr) {
        const delta = (grTarget - gr) * this.attackCoef
        grMain += delta * this.mainFraction
        grTail += delta * this.tailFraction
      } else {
        grMain += (grTarget * this.mainFraction - grMain) * this.releaseCoef
        grTail += (grTarget * this.tailFraction - grTail) * this.tailCoef
      }

      const grNow = grMain + grTail
      if (grNow > this.maxGrDb) this.maxGrDb = grNow
      if (grNow > 0.05) {
        this.grSum += grNow
        this.grActive++
      }
      // Input attenuator and gain cell fold into one per-sample coefficient;
      // Output is applied after the saturator, where the hardware's output
      // control sits.
      gain[i] = this.inputLin * Math.exp(-grNow * LN10_OVER_20)
    }

    this.hpfLp1 = hpfLp1
    this.hpfLp2 = hpfLp2
    this.grMain = grMain
    this.grTail = grTail
    this.grDb = grMain + grTail

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
        if (this.applyFet) {
          const shaped = (Math.tanh(this.fetDriveLin * wet + this.fetBias) - this.tanhBias) / this.fetNorm
          dcY = shaped - dcX + this.dcR * dcY
          dcX = shaped
          wet = dcY
        }
        wet *= this.outputLin
        // The dry side of the blend is the untouched input, so a parallel
        // setting stays level-sane and bypass A/B compares like for like.
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
 * kernel. Used by the auto-makeup measurement worker and by Node verification
 * scripts; the app itself renders through an OfflineAudioContext running the
 * worklet so preview and apply share the exact same code path.
 */
export function processFET1176Buffer(channelData, sampleRate, params = {}) {
  const kernel = new FET1176Kernel(sampleRate)
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

/** RMS across every sample of every channel. */
function rmsOfChannels(channels) {
  let sumSq = 0
  let count = 0
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sumSq += ch[i] * ch[i]
    count += ch.length
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0
}

/**
 * Compute the Output setting (dB) that restores the processed signal to the
 * input's RMS level — i.e. what makes engaging the compressor level-neutral
 * so bypass A/B comparisons aren't decided by loudness bias.
 *
 * This matters more here than on the OptoSmooth: Input drives the audio path
 * as well as the detector, so moving it swings the output level by tens of dB
 * and the user would otherwise be re-trimming Output after every touch.
 *
 * Measured, not derived from the curve: the kernel is run over the actual
 * audio and the output RMS compared to the input's. RMS rather than peak,
 * because reducing peaks is the point — peak matching would over-boost.
 *
 * Output is applied after the saturator (as on the hardware), so unlike the
 * LA-2A's makeup it does not change the operating point of the nonlinearity
 * and the first correction is normally exact. The loop is kept for the same
 * shape as its counterpart and simply exits early.
 */
export function computeFET1176AutoMakeupDb(channelData, sampleRate, params = {}, options = {}) {
  const { maxIterations = 3, toleranceDb = 0.05 } = options

  const inputRms = rmsOfChannels(channelData)
  if (inputRms <= 0) return 0

  let makeupDb = 0
  for (let i = 0; i < maxIterations; i++) {
    const { channelData: out } = processFET1176Buffer(channelData, sampleRate, {
      ...params,
      outputGainDb: makeupDb,
    })
    const outRms = rmsOfChannels(out)
    if (outRms <= 0) break
    const correctionDb = 20 * Math.log10(inputRms / outRms)
    makeupDb = clamp(makeupDb + correctionDb, -36, 36)
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
  // smooth needle without flooding the message port.
  const METER_INTERVAL_SAMPLES = 1024

  class FET1176WorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new FET1176Kernel(sampleRate)
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

  registerProcessor('fet1176-processor', FET1176WorkletProcessor)
}
