/**
 * 1176-style FET limiting amplifier emulation ("FET Punch") — worklet kernel.
 *
 * Companion to la2aProcessor.js (OptoSmooth). Same contract: this file is
 * BOTH a normal ES module (exports FET1176Kernel and processFET1176Buffer for
 * offline use and Node-based verification) AND an AudioWorklet module
 * (registers 'fet1176-processor' when loaded into an AudioWorkletGlobalScope).
 * Its loader goes through `?worker&url`, which bundles whatever it imports into
 * one self-contained chunk — see fet1176WorkletLoader.js.
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
 *
 * OVERSAMPLING. The gain cell and the FET stage run at OVERSAMPLE_FACTOR times
 * the base rate; the detector, the ballistics and the gain computer stay at the
 * base rate, where their time constants were tuned.
 *
 * This unit has two things generating content above Nyquist, not one. The
 * obvious one is the waveshaper. The other is the gain signal itself: the
 * detector is deliberately unsmoothed and at attack dial 7 the cell tracks the
 * waveform, so the gain sequence is a broadband nonlinear function of the input
 * and multiplying by it folds. At 44.1 kHz that showed up as -47 dBc of folded
 * product on a 9 kHz tone at the default fetDrive, and -80 dBc with the FET
 * stage switched off entirely — the residue of the multiply alone.
 *
 * Forming the product at the oversampled rate addresses both. What it cannot
 * recover is detail already lost in computing the gain at the base rate; taking
 * the detector up as well would change the ballistics, which is the sound.
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

// ── Level reference ─────────────────────────────────────────────────────────

// Nominal operating level (0 VU = +4 dBu). The internal threshold sits at
// line level on the hardware, so Input is referenced to that rather than to
// digital full scale — see the same constant in la2aProcessor.js.
// Output-gain smoothing time. Short enough to feel immediate under a knob,
// long enough that a step of tens of dB cannot click. Matches the soft
// clipper's PARAM_SMOOTH_MS.
const OUT_SMOOTH_MS = 8

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
  /**
   * Run the gain cell and FET stage oversampled. Always true for anything
   * anyone listens to; see `computeFET1176AutoMakeupDb` for the one caller
   * that turns it off and why that is sound.
   */
  oversample: true,
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
    this.outScratch = new Float32Array(128)
    // null = not yet seeded. The first block adopts the target exactly so an
    // offline render carries its makeup from sample 0; see process().
    this.outLinSmoothed = null
    this.outSmoothCoef = 1 - Math.exp(-1 / (sampleRate * (OUT_SMOOTH_MS / 1000)))

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

    this.oversampleOn = p.oversample !== false
  }

  /**
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims.
   *
   * Constant across every setting a listener can reach — the oversampled path
   * runs even at `fetDrive: 0`, so switching the FET stage off cannot shift the
   * timeline underneath a running preview. It is zero only in the measurement
   * mode described on `oversample`, which nothing renders through.
   */
  get latencySamples() {
    return this.oversampleOn ? OVERSAMPLE_LATENCY_SAMPLES : 0
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
    if (this.wetScratch.length < n) this.wetScratch = new Float64Array(n)
    if (this.outScratch.length < n) this.outScratch = new Float32Array(n)
    const gain = this.gainScratch
    const chScale = 1 / nIn

    /**
     * OUTPUT GAIN, SMOOTHED — it was applied as a bare step.
     *
     * `outputLin` was recomputed in setParams and multiplied in directly, so
     * every param message stepped the gain discontinuously. Inaudible for a
     * knob nudged by hand; a click for anything that writes this knob rapidly,
     * which is exactly what AUTO makeup does — reported as zippering on rapid
     * adjustment.
     *
     * ⚠ COMPUTED ONCE PER BLOCK, NOT PER CHANNEL. The smoother has to advance
     * with TIME, and a per-channel one advances N times faster on N channels —
     * the bug HfLossShelf's depth ramp already shipped once. Same arrangement
     * as the gain envelope above it, which is shared for the same reason.
     *
     * ⚠ SEEDED ON THE FIRST BLOCK rather than ramped from unity, so an offline
     * render carries its makeup from sample 0. Ramping in from 0 dB puts a
     * swell at the head of every applied region.
     */
    const outGain = this.outScratch
    if (this.outLinSmoothed === null) this.outLinSmoothed = this.outputLin
    let outLinSmoothed = this.outLinSmoothed
    for (let i = 0; i < n; i++) {
      outLinSmoothed += this.outSmoothCoef * (this.outputLin - outLinSmoothed)
      outGain[i] = outLinSmoothed
    }
    this.outLinSmoothed = outLinSmoothed

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
      //
      // Held back to meet the audio where it emerges inside the oversampled
      // section, which the upsampler has delayed by UPSAMPLE_DELAY_SAMPLES.
      // Without this the reduction would arrive early — a look-ahead the
      // hardware does not have, and one that would blunt the grab this unit is
      // bought for. In the base-rate measurement path there is nothing to meet,
      // so the delay would only misalign it.
      const g = this.inputLin * Math.exp(-grNow * LN10_OVER_20)
      gain[i] = this.oversampleOn ? this.gainDelay.push(g) : g
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

      // The multiply is the other half of this unit's aliasing, not just a way
      // of applying the curve — at dial 7 the gain tracks the waveform. So the
      // gain is interpolated up to the oversampled rate rather than held in
      // steps, and the product is formed there.
      // The ramp starts AT gCur rather than one step past it. The halfband
      // upsampler's even branch is a pure delay, so sub-sample j = 0 is the
      // original input sample, not an interpolated point — it has to receive
      // the gain computed from it, exactly. Starting the ramp a step later left
      // that sample holding three quarters of the PREVIOUS gain, which at a
      // 20 us attack is most of the reduction a transient was supposed to get:
      // the first sample of every hard onset passed through nearly unattenuated
      // and read as a click.
      let gCur = seamGain
      for (let i = 0; i < n; i++) {
        const gNext = gain[i]
        const step = (gNext - gCur) * invL
        for (let j = 0; j < L; j++) {
          const k = i * L + j
          let w = hi[k] * (gCur + step * j)
          if (this.applyFet) {
            w = (Math.tanh(this.fetDriveLin * w + this.fetBias) - this.tanhBias) / this.fetNorm
          }
          hi[k] = w
        }
        gCur = gNext
      }

      this.oversamplers[ch].down(wet, n)

      // Back at the base rate: the DC blocker and the Output control are both
      // linear and generate nothing, so they cost nothing to run down here.
      let dcX = this.dcX[ch]
      let dcY = this.dcY[ch]
      const dryLine = this.dryLines[ch]
      for (let i = 0; i < n; i++) {
        let w = wet[i]
        if (this.applyFet) {
          dcY = w - dcX + this.dcR * dcY
          dcX = w
          w = dcY
        }
        w *= outGain[i]
        // The dry side of the blend is the untouched input, delayed to meet the
        // wet side, so a parallel setting stays level-sane and phase-coherent
        // and bypass A/B compares like for like.
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
   * resampling and therefore no latency.
   *
   * This exists because the auto-makeup measurement runs the whole kernel over
   * the selection several times to converge, and doing that through the
   * oversampled path made it about three times slower — slow enough that the
   * Output knob visibly lagged a drag, and slow enough that a stale Output
   * could be applied to a louder signal than it was measured for.
   *
   * It is sound because the measurement only ever asks one question: what is
   * the output's RMS. Oversampling changes that by at most 0.02 dB across the
   * whole control range — it removes folded harmonics, which carry almost no
   * energy. A test pins that bound so the shortcut cannot quietly stop being
   * true.
   *
   * Nothing that renders audio uses this. The worklet never sets `oversample`,
   * and the apply path trims a fixed latency that assumes the oversampled path.
   */
  _processChannelBaseRate(input, out, gain, n, ch) {
    // Filled once per block in process(); read rather than passed so the two
    // branches cannot drift apart on which gain they apply.
    const outGain = this.outScratch
    let dcX = this.dcX[ch]
    let dcY = this.dcY[ch]
    for (let i = 0; i < n; i++) {
      const dry = input[i]
      let w = dry * gain[i]
      if (this.applyFet) {
        const shaped = (Math.tanh(this.fetDriveLin * w + this.fetBias) - this.tanhBias) / this.fetNorm
        dcY = shaped - dcX + this.dcR * dcY
        dcX = shaped
        w = dcY
      }
      w *= outGain[i]
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
    latencySamples: kernel.latencySamples,
    metering: {
      maxGainReductionDb: m.maxGainReductionDb,
      avgGainReductionDb: m.avgGainReductionDb,
    },
  }
}

/**
 * RMS across every sample of every channel, optionally skipping a leading
 * stretch — see the counterpart in la2aProcessor.js for why.
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
 * The Output gain that puts this compressor's output peak back on the input's.
 *
 * SOLVED IN ONE RENDER, EXACTLY — it used to be a fixed-point iteration capped
 * at three passes, and on any parallel setting that cap returned an answer
 * several dB short.
 *
 * ⚠ THE ITERATION DID NOT CONVERGE AT MIX < 1, AND TWO FACTORY PRESETS SHIP
 * THERE (0.4 and 0.5). Output gain scales the WET path only — the sum is
 * `dry*(1-mix) + wet*mix*g` — so `makeup += correction` converges at a rate set
 * by the wet share, which is slow exactly where the wet share is small.
 * Measured on 30 s of real narration at Input 55, makeup by iteration count:
 *
 *   mix 1.0   10.25 / 10.25 / 10.25 / 10.25          (one pass is already exact)
 *   mix 0.7    6.51 /  9.95 / 10.92 / 11.20
 *   mix 0.5    4.11 /  7.23 /  9.35 / 11.98   <- shipped cap returned 9.35
 *   mix 0.3    2.23 /  4.21 /  5.94 / 12.08   <- 6.1 dB short
 *
 * THE SOLVE IS A ONE-PASS SCAN, and it is exact rather than convergent. The
 * output is AFFINE in the makeup: `out[i] = a[i] + b[i]·g`, where
 * `a[i] = dry[i]·(1−mix)` and `b[i] = wet[i]·mix`, because `outputLin` is the
 * last multiply on the wet path and the detector reads the INPUT, so the wet
 * signal does not depend on g at all. Requiring `|a[i] + b[i]·g| <= P` for
 * every sample gives one interval per sample; their intersection's upper end is
 * the largest makeup that keeps the output peak at P, which is the answer. One
 * render (the wet path, taken at mix 1) plus one O(n) pass, against three to
 * twenty renders before.
 *
 * ⚠ `dry` IS THE UNDELAYED INPUT ONLY BECAUSE THE MEASUREMENT RUNS AT BASE
 * RATE. The oversampled path delays the dry side by OVERSAMPLE_LATENCY_SAMPLES
 * to meet the wet side; the base-rate path this measurement forces has no such
 * delay (`const dry = input[i]`). If the measurement ever moves to the
 * oversampled path, `a[i]` has to carry that delay or the two sides are
 * compared at different instants.
 *
 * PEAK, NOT RMS: makeup means handing back what came off the peaks. See
 * peakOfChannels for why a true peak rather than a percentile.
 *
 * Measured through the BASE-RATE path: oversampling removes folded harmonics,
 * which carry almost no energy, and measuring through it was about three times
 * slower — which the Output knob showed as lag behind a drag.
 *
 * @param {Float32Array[]} channelData Region to measure.
 * @param {number} sampleRate
 * @param {object} params Kernel params. `outputGainDb` is IGNORED — it is the
 *   quantity being solved for.
 * @returns {number} Makeup in dB, clamped to the Output knob's travel.
 */
export function computeFET1176AutoMakeupDb(channelData, sampleRate, params = {}, options = {}) {
  const { minDb = -36, maxDb = 36 } = options

  const inputPeak = peakOfChannels(channelData)
  if (inputPeak <= 0) return 0

  const mix = clamp(params.mix ?? FET1176_KERNEL_DEFAULTS.mix, 0, 1)
  // Mix 0 is the dry signal: there is nothing to make up, and the solve below
  // would be unconstrained (every b[i] is zero).
  if (mix <= 0) return 0

  // The wet path alone, at unity output gain. Taken at mix 1 so the render IS
  // `wet[i]`; mix feeds nothing but the final blend, so this changes no other
  // part of the kernel's behaviour.
  const { channelData: wet } = processFET1176Buffer(channelData, sampleRate, {
    ...params, oversample: false, outputGainDb: 0, mix: 1,
  })

  const dryMix = 1 - mix
  // Largest g for which every sample satisfies |a + b·g| <= inputPeak.
  let gMax = Infinity
  for (let ch = 0; ch < wet.length; ch++) {
    const dry = channelData[ch]
    const w = wet[ch]
    for (let i = 0; i < w.length; i++) {
      const b = w[i] * mix
      if (b === 0) continue
      const a = dry[i] * dryMix
      // The binding end of this sample's interval is the one it moves toward.
      const bound = (b > 0 ? inputPeak - a : -inputPeak - a) / b
      if (bound < gMax) gMax = bound
    }
  }
  if (!Number.isFinite(gMax) || gMax <= 0) return 0

  return clamp(20 * Math.log10(gMax), minDb, maxDb)
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
