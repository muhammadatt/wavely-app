/**
 * Adaptive Soft Clipper — memoryless transient-taming stage, worklet kernel.
 *
 * Companion to la2aProcessor.js / fet1176Processor.js: this file is BOTH a
 * normal ES module (exports SoftClipperKernel and processSoftClipperBuffer for
 * offline use and Node-based verification) AND an AudioWorklet module
 * (registers 'soft-clipper-processor' when loaded into an
 * AudioWorkletGlobalScope). Its loader goes through `?worker&url`, which
 * bundles whatever it imports into one self-contained chunk — see
 * softClipperWorkletLoader.js.
 *
 * Adapted from the "Instant Polish — Adaptive Soft Clipper Stage" spec (v1.0,
 * Aug 2026). Faithful to the spec's architecture and curve; several
 * implementation details were adjusted to fit this codebase rather than
 * introduce a second pattern alongside it. Departures, and why:
 *
 * 1. DETECTOR RUNS PER-SAMPLE, NOT AT A DECIMATED CONTROL RATE (spec §6.2).
 *    Every other kernel here — including the FET1176, whose release runs up
 *    to 1.1 s, slower than nothing this stage does — evaluates its detector
 *    every sample. The whole detector is four one-pole updates and a
 *    comparison; it is trivial next to the oversampled tanh + halfband FIRs
 *    that actually cost CPU. Decimating it would buy nothing measurable and
 *    would fork the codebase's detector pattern for this one kernel alone.
 *
 * 2. THE NOISE FLOOR IS A DECAYING VALLEY FOLLOWER, NOT A WINDOWED MINIMUM
 *    (spec §3.1). A literal "running minimum over a trailing 2 s window" needs
 *    either a ring buffer of block minima or a monotonic deque. A valley
 *    follower — snap down instantly when the input reads lower, creep back up
 *    on a ~2 s time constant otherwise — approximates the same behaviour in
 *    O(1) state, with no discontinuity when a low sample falls out of a
 *    window edge (there is no edge). It also reacts to a real drop in noise
 *    floor immediately, which a windowed minimum only reports once the loud
 *    stretch scrolls out of the window.
 *
 * 3. `headroomDb` AND `outputTrimDb` ARE SMOOTHED WITH A FIXED-TIME-CONSTANT
 *    ONE-POLE, NOT "RAMPED LINEARLY OVER THE BLOCK" AS SPEC §5.3 LITERALLY
 *    SAYS — a real bug this file's own test suite caught. Tying a ramp's
 *    DURATION to whatever block size happens to be processing means the same
 *    parameter change plays out over a different number of milliseconds
 *    depending on host buffer size — invisible on a real AudioWorklet, which
 *    always calls with 128 samples, but a direct violation of §6.3's
 *    block-size-independence requirement for any other caller (including the
 *    Node offline path, which chunks in 128s but is still supposed to match
 *    64/256/1024 exactly). Measured: an initial headroomDb move from the
 *    constructor default to a caller's setParams() value diverged the 64- and
 *    1024-sample renders of the same file by 0.00087 in amplitude — small,
 *    but not the bit-for-bit match §6.3 asks for. A one-pole recurrence run
 *    truly per-sample is chunk-invariant by construction: each sample's value
 *    depends only on the previous sample's, never on which call it landed in.
 *    `PARAM_SMOOTH_MS` sets how fast it settles.
 *
 *    Emphasis-filter coefficients are handled differently again: recomputed
 *    only when the raw target has moved enough to matter (see
 *    `EMPHASIS_RECOMPUTE_EPS_DB`), with no ramp or crossfade at all — same as
 *    every other kernel in this codebase recomputes on `setParams`. That
 *    recompute happens identically regardless of chunking (it is driven by
 *    the target value, not by sample position within a block), so it does
 *    not share headroomDb/outputTrimDb's bug.
 *
 * 4. NO IN-KERNEL BYPASS PATH (spec §6.5). The app's bypass mechanism is
 *    uniform across every plugin: EffectChain removes a disabled effect's
 *    node from the graph entirely (effectChain.js `_rebuildChain`), so there
 *    is nothing for a disabled soft clipper to comb-filter against. What
 *    §6.5 actually wants — a way to gain-match for an honest A/B — is Output
 *    Trim (§4.5), which is a real user control here.
 *
 * 5. TWO MEASURED FIXES to the spec's literal pseudocode, both caught by the
 *    test suite rather than by inspection:
 *
 *    a) The speech level tracker updates on the RAW `aboveFloor` condition,
 *       not the hold-extended `gate_open` the spec's §3.2 pseudocode names.
 *       Feeding the tracker through the hold window works fine on a genuine
 *       stop-consonant closure (some room tone still reaches the mic), but a
 *       synthetic true-silence pause exposed what that same wiring does when
 *       the hold window sees actual digital silence: fast_rms collapses in
 *       ~10 ms and the tracker spends the rest of the 200 ms hold averaging
 *       that near-silence in, dragging `speech_level` down by double digits
 *       of dB on ONE pause — precisely the failure the hold exists to
 *       prevent. `gate_hold`'s stated purpose (bridging brief closures
 *       without a full re-gate) is already covered by the tracker's own 3 s
 *       time constant, which a 100-200 ms dip barely moves whether or not
 *       it's included — so nothing is lost by excluding the held region
 *       specifically, and pause integrity is gained. `gateOpen` (with hold)
 *       is still computed and exposed, for a "gate active" indicator this
 *       kernel doesn't yet have a use for beyond that.
 *
 *    b) Peak reduction is measured AT THE CLIP CURVE — the dB delta between
 *       what went into softClip() and what came out, at whichever
 *       oversampled sample reduced the most this block — rather than by
 *       diffing the stage's raw input/output peaks as spec §7.2 literally
 *       describes. That literal version compares two buffers that are NOT
 *       time-aligned: the oversampler's ~50-sample group delay means "this
 *       block's input peak" and "this block's output peak" can belong to
 *       different instants. Measured: a sudden level change landing near a
 *       block boundary produced a many-dB SPURIOUS reduction reading with no
 *       clipping involved — this block's louder input compared against the
 *       previous block's still-arriving quieter output. Measuring inside the
 *       clip curve is exactly what FET1176Kernel/LA2AKernel already do for
 *       their own GR meters (`grDb`, read at the gain cell, not from I/O
 *       peaks) and cannot misalign by construction — both sides of the
 *       comparison are read at the same instant.
 *
 * ARCHITECTURE (spec §2, unchanged):
 *
 *   input ──┬─► detector (unfiltered, mono downmix) ──────────────┐
 *           │     noise floor ─► gate+hold ─► speech level ─► T   │
 *           │                                                     │
 *           └─► pre-emphasis (HF shelf, per channel) ─────────────┤
 *                 └─► 4x oversample ─► soft clip curve (shared T) ◄┘
 *                       └─► 4x downsample
 *                             └─► de-emphasis (exact inverse)
 *                                   └─► output trim
 *
 * The detector reads the UNFILTERED input, in parallel with the audio path —
 * never post-emphasis (which would couple the threshold to the emphasis
 * setting) and never post-clip (which would be a feedback path suppressing
 * the stage's own trigger).
 *
 * OVERSAMPLING reuses COMPRESSOR_OVERSAMPLE from dsp/oversample.js — the same
 * 4x halfband profile the FET1176 and LA2A waveshapers run, already measured
 * at ≥80 dB stopband attenuation (oversample.test.js) and already carrying
 * OVERSAMPLE_LATENCY_SAMPLES (50 samples / ~1.13 ms at 44.1 kHz — squarely in
 * the spec's "approximately 1-2 ms" estimate, §6.4). Sharing the profile means
 * this stage's latency is identical to the compressors it typically precedes,
 * which is one less number to reason about when chaining them.
 *
 * Pre/de-emphasis run at the BASE rate, outside the oversampled section — they
 * are ordinary IIR biquads, not linear-phase, so they add no latency of their
 * own. The clip curve is the only thing that needs headroom above Nyquist.
 */

import {
  Oversampler, OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES,
} from './dsp/oversample.js'
import {
  highShelf, invertBiquad, biquadZerosInsideUnitCircle, BiquadCascade,
} from './dsp/biquad.js'
import { riseCoeff } from './dsp/envelope.js'

export { OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES as SOFT_CLIPPER_LATENCY_SAMPLES }

// ── Detector constants ──────────────────────────────────────────────────────

const FAST_RMS_TAU_MS = 10
const NOISE_FOLLOW_TAU_MS = 2000 // creep-up rate of the valley follower
const GATE_MARGIN_DB = 12 // ⚠ spec-flagged for calibration; not user-exposed in v1
const GATE_HOLD_MS = 200
const SPEECH_TAU_S = 3.0
const SPEECH_INIT_WINDOW_MS = 500
const SPEECH_INIT_DEFAULT_DB = -24

// A linear one-pole decaying toward silence can sit in denormal range for the
// whole length of a pause, which is measured to spike CPU on x86 (spec §6.1).
// Every kernel with a long-release one-pole in this codebase is exposed to
// this in principle; this one's the first with a multi-second LINEAR (not
// dB-domain) follower, so it is the first to need the guard.
const DENORMAL_GUARD = 1e-30

// Threshold clamp (spec §3.3) — linear amplitude.
const T_MIN = 0.10
const T_MAX = 0.95

/**
 * Knee sharpness of the soft-clip curve.
 *
 * NOT IN THE SPEC, AND THE SPEC NEEDS IT: as written, §4.4's curve cannot
 * produce the peak reduction §7.1 of the same document calls its usable
 * operating range. The two sections contradict each other, and the curve is
 * the half that is wrong.
 *
 * The mechanism is the curve's own normalisation. Its tanh argument is
 * (|x|-T)/(1-T), so at |x| = 1.0 — digital full scale, the loudest sample any
 * signal can contain — that argument is exactly 1.0 for EVERY threshold. The
 * output there is therefore always T + tanh(1)·(1-T), and the reduction is
 * bounded at -20·log10(0.76159 + 0.23841·T): 2.37 dB as T approaches zero, and
 * less for every real threshold. Within the [-1, 1] domain a digital signal
 * lives in, the curve only ever traverses the first unit of tanh's argument,
 * where tanh has barely begun to bend. §7.1 asks for 3-6 dB usable and calls
 * 6 dB a hard ceiling; the curve cannot reach even the bottom of that range at
 * any setting.
 *
 * Found on a real 35-second narration clip (normalised to -1 dBFS, speech
 * around -22 dBFS): at minimum Headroom the detector correctly placed the
 * threshold at -18 dBFS, putting peaks a full 17 dB over it, and the stage
 * still only took off 1.82 dB — matching the analytical bound of 2.03 dB for
 * that threshold almost exactly. The detector was never the problem. Note that
 * the whole synthetic test suite passed throughout: its assertions were about
 * monotonicity and relative behaviour, none of which this breaks. Eighth time
 * synthetic material has been too clean to answer the question asked of it.
 *
 * The fix divides the curve's output span by k and multiplies its argument by
 * k, which reaches further along tanh for the same input while leaving every
 * property the spec relies on intact — unity below T, unit slope at the knee
 * (sech²(0) = 1 for any k, so C¹ continuity is untouched), a bounded asymptote
 * at T + (1-T)/k, odd symmetry, monotonicity. k = 1 is the spec's curve
 * exactly.
 *
 * 2.2 is calibrated on that clip. Measured peak reduction on its hottest
 * transient across the Headroom range: 2.82 dB at 16 (gentlest), 4.48 at 10
 * (default), 5.45 at 4 (most aggressive) — so the knob's travel brackets the
 * meter's shaded 3-6 dB target zone, opening just below it and topping out
 * just under §7.1's stated 6 dB hard ceiling rather than at a quarter of it.
 * Typical active blocks sit near 1 dB; the figures above are the single
 * loudest transient in 35 seconds, which is what the meter's peak hold shows.
 * 2.6 was the alternative and was rejected for reaching 3.28 dB at the
 * GENTLEST setting — a gentle setting should be able to be gentle — and for
 * crossing the ceiling at 6.46 at the far end.
 *
 * ⚠ One narrator, one clip. This is the first constant to re-derive against a
 * wider corpus, and the honest read is that it is calibrated, not measured.
 */
const KNEE_SHARPNESS = 2.2

// ── Emphasis constants ──────────────────────────────────────────────────────

// ⚠ Spec flags the corner as "consider fixing in v1" (Open Question #1) —
// fixed here, which also means the pre/de-emphasis pair only ever needs one
// coefficient set per sample rate rather than one per (corner, gain) pair.
const EMPHASIS_CORNER_HZ = 3500
const EMPHASIS_SLOPE_S = 0.7 // gentle shelf slope, avoids resonant overshoot at the corner
const EMPHASIS_EPSILON_DB = 0.001 // below this, treat as "0 dB" and skip the filters entirely
// Recompute shelf coefficients only when the ramped value has moved this far
// since the last computation — see deviation note (3) above.
const EMPHASIS_RECOMPUTE_EPS_DB = 0.05

// Fixed time constant for smoothing headroomDb / outputTrimDb toward their
// targets — see deviation note 3. Fast enough to feel immediate on a knob
// drag, slow enough that no step is audible as zipper noise.
const PARAM_SMOOTH_MS = 8

const LN10_OVER_20 = Math.LN10 / 20

export const SOFT_CLIPPER_KERNEL_DEFAULTS = {
  headroomDb: 10, // 4-16, primary control — lower means more clipping
  emphasisDb: 6, // 0-12, HF pre/de-emphasis depth; 0 = bypass both filters
  outputTrimDb: 0, // ±6, post-stage gain match for A/B
  thresholdMode: 'adaptive', // 'adaptive' | 'fixed'
  fixedThresholdDb: -10, // used only in 'fixed' mode
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function dbToLin(db) {
  return Math.exp(db * LN10_OVER_20)
}

function linToDb(lin) {
  return lin > 1e-9 ? 20 * Math.log10(lin) : -180
}

/**
 * Soft-clip curve (spec §4.4, with the knee-sharpness term the spec's own
 * operating range turns out to require — see KNEE_SHARPNESS).
 *
 *   y = x                                                      |x| <= T
 *   y = sign(x) * [T + ((1-T)/k)*tanh(k*(|x|-T)/(1-T))]        |x| > T
 *
 * At k = 1 this is exactly the curve as written in the spec. Every shape
 * guarantee the spec claims holds for ANY k > 0:
 *
 * - Unity below T — bit-transparent on material that never crosses it.
 * - C¹ continuous at the knee. The derivative above the knee is
 *   sech²(k(|x|-T)/(1-T)), which is 1 at |x| = T for every k, matching the
 *   unity slope below it. So there is no slope discontinuity to ring a
 *   wideband harmonic burst, whatever k is set to.
 * - Bounded, never hard-clips: the asymptote is T + (1-T)/k, which is below
 *   1.0 for k >= 1.
 * - Odd symmetry — no DC term, no DC blocker required.
 * - Monotonic in |x|.
 *
 * Deliberately NOT a plain `tanh(k·x)` — that compresses across the entire
 * amplitude range and changes voice character below threshold. The whole
 * "transparent when idle" claim rests on the piecewise form.
 */
export function softClip(x, T, k = KNEE_SHARPNESS) {
  const ax = x < 0 ? -x : x
  if (ax <= T) return x
  const span = 1 - T
  const y = T + (span / k) * Math.tanh((k * (ax - T)) / span)
  return x < 0 ? -y : y
}

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass — every
 * coefficient derives from sample rate and time constants, never from block
 * count (spec §6.3).
 */
export class SoftClipperKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate

    // ── Detector state (mono, shared across channels) ──
    this.fastRmsMeanSq = 0
    this.noiseEstDb = -80
    this.gateHoldSamples = 0
    this.gateOpen = false
    this.speechLevelDb = SPEECH_INIT_DEFAULT_DB
    this.speechWarmupCount = 0
    this.speechWarmupSum = 0 // cumulative mean of fastRmsLin (linear RMS amplitude) during warmup
    this.speechWarmupTarget = Math.max(1, Math.round(sampleRate * (SPEECH_INIT_WINDOW_MS / 1000)))

    this.fastRmsCoef = riseCoeff(FAST_RMS_TAU_MS, sampleRate)
    this.noiseFollowCoef = riseCoeff(NOISE_FOLLOW_TAU_MS, sampleRate)
    this.speechCoef = riseCoeff(SPEECH_TAU_S * 1000, sampleRate)
    this.gateHoldSamplesTotal = Math.round((GATE_HOLD_MS / 1000) * sampleRate)
    this.paramSmoothCoef = riseCoeff(PARAM_SMOOTH_MS, sampleRate)

    // ── Smoothed scalars (fixed-time-constant one-pole — deviation note 3) ──
    this.headroomDbSmoothed = SOFT_CLIPPER_KERNEL_DEFAULTS.headroomDb
    this.outputTrimDbSmoothed = SOFT_CLIPPER_KERNEL_DEFAULTS.outputTrimDb
    // emphasisDb is not ramped per-sample like the two scalars above — its
    // effect is a filter coefficient, recomputed once per block rather than
    // crossfaded (see deviation note 3 in the file header). -1 forces a first
    // computation on the earliest process() call.
    this.emphasisDbCommitted = -1

    // ── Emphasis filters (per-channel state, shared coefficients) ──
    this.preEmphasis = new BiquadCascade(1, 1)
    this.deEmphasis = new BiquadCascade(1, 1)
    this.emphasisActive = false
    this.emphasisStable = true

    // ── Oversamplers (grown on demand per channel) ──
    this.oversamplers = []

    // ── Metering ──
    this.reductionDb = 0
    this.maxReductionDb = 0

    this.tScratch = new Float32Array(128)
    this.trimScratch = new Float32Array(128)

    this.params = { ...SOFT_CLIPPER_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Merge a partial param update and recompute derived coefficients. */
  setParams(partial) {
    this.params = { ...this.params, ...partial }
    // headroomDb and outputTrimDb are smoothed toward these targets by a
    // fixed-time-constant one-pole in process() rather than snapped here (see
    // deviation note 3); emphasisDb's filter coefficients recompute in
    // process() once the target has moved enough to matter. thresholdMode and
    // fixedThresholdDb take effect immediately — neither drives a filter
    // coefficient, so there is nothing to click.
  }

  /**
   * Algorithmic latency, in samples — the oversampler's group delay alone.
   * Pre/de-emphasis are ordinary IIR biquads at the base rate and add none.
   * Constant regardless of settings, including emphasisDb = 0: the
   * oversampled path always runs, so bypassing the emphasis filters cannot
   * shift the timeline under a running preview.
   */
  get latencySamples() {
    return OVERSAMPLE_LATENCY_SAMPLES
  }

  getMetering() {
    return { reductionDb: this.reductionDb, maxReductionDb: this.maxReductionDb }
  }

  /**
   * Recompute the pre/de-emphasis shelf pair for the current sample rate and
   * a committed emphasisDb value.
   *
   * De-emphasis is the exact algebraic inverse of pre-emphasis (invertBiquad),
   * not an independently fitted cut shelf — any mismatch there would leave
   * residual coloration on a stage that is supposed to be transparent when
   * idle (spec §4.2). Stability is checked before trusting the inverse: an
   * RBJ shelving BOOST is minimum-phase for any sane corner/slope, so this
   * should never fail in practice at a fixed 3.5 kHz corner, but the check is
   * cheap (it runs only here, not per sample) and failing closed is safer
   * than emitting an unstable de-emphasis filter.
   */
  _updateEmphasis(emphasisDb) {
    this.emphasisDbCommitted = emphasisDb
    this.emphasisActive = emphasisDb > EMPHASIS_EPSILON_DB
    if (!this.emphasisActive) return

    const pre = highShelf(this.sampleRate, EMPHASIS_CORNER_HZ, EMPHASIS_SLOPE_S, emphasisDb, 'slope')
    this.emphasisStable = biquadZerosInsideUnitCircle(pre)
    if (!this.emphasisStable) {
      // Fail closed rather than run an unstable inverse (spec §4.2).
      this.emphasisActive = false
      return
    }
    const de = invertBiquad(pre)
    this.preEmphasis.setSections([pre])
    this.deEmphasis.setSections([de])
  }

  /**
   * Process one block.
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

    if (this.tScratch.length < n) this.tScratch = new Float32Array(n)
    if (this.trimScratch.length < n) this.trimScratch = new Float32Array(n)
    const T = this.tScratch
    const trimGain = this.trimScratch
    const chScale = 1 / nIn

    const p = this.params
    const fixedMode = p.thresholdMode === 'fixed'

    // ── Detector + threshold, computed once per sample from the unfiltered
    // mono downmix, shared by every channel's clip curve. headroomDb and
    // outputTrimDb are smoothed here too — one one-pole each, run exactly
    // once regardless of channel count (deviation note 3) ──
    let fastRmsMeanSq = this.fastRmsMeanSq
    let noiseEstDb = this.noiseEstDb
    let gateHoldSamples = this.gateHoldSamples
    let speechLevelDb = this.speechLevelDb
    let speechWarmupCount = this.speechWarmupCount
    let speechWarmupSum = this.speechWarmupSum
    let headroomDbSmoothed = this.headroomDbSmoothed
    let outputTrimDbSmoothed = this.outputTrimDbSmoothed

    for (let i = 0; i < n; i++) {
      headroomDbSmoothed += this.paramSmoothCoef * (p.headroomDb - headroomDbSmoothed)
      outputTrimDbSmoothed += this.paramSmoothCoef * (p.outputTrimDb - outputTrimDbSmoothed)
      trimGain[i] = dbToLin(outputTrimDbSmoothed)

      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale

      // fast_rms: one-pole RMS, τ = 10 ms (spec §3.1).
      fastRmsMeanSq += this.fastRmsCoef * (x * x - fastRmsMeanSq) + DENORMAL_GUARD
      const fastRmsLin = Math.sqrt(Math.max(0, fastRmsMeanSq))
      const fastRmsDb = linToDb(fastRmsLin)

      // noise_est: decaying valley follower standing in for a running minimum
      // over a trailing 2 s window — see deviation note (2) above.
      if (fastRmsDb < noiseEstDb) {
        noiseEstDb = fastRmsDb
      } else {
        noiseEstDb += this.noiseFollowCoef * (fastRmsDb - noiseEstDb)
      }

      // gate + hold (spec §3.1): open while fast_rms clears the floor by the
      // margin, held open for GATE_HOLD_MS after it drops back below.
      const aboveFloor = fastRmsDb > noiseEstDb + GATE_MARGIN_DB
      if (aboveFloor) {
        gateHoldSamples = this.gateHoldSamplesTotal
      } else if (gateHoldSamples > 0) {
        gateHoldSamples--
      }
      // Held open for metering / a future "gate active" indicator — see
      // deviation note (5) for why the TRACKER below is gated on the
      // un-held `aboveFloor` instead.
      this.gateOpen = aboveFloor || gateHoldSamples > 0

      // speech level tracker (spec §3.2): updates only while the signal is
      // ACTUALLY above the floor — no update, no decay — through pauses.
      // Without this the tracker would sag toward the noise floor across
      // every breath and the first word after every pause would clip hard.
      //
      // Gated on `aboveFloor`, not the hold-extended `gateOpen` — see
      // deviation note (5).
      if (aboveFloor) {
        if (speechWarmupCount < this.speechWarmupTarget) {
          speechWarmupCount++
          speechWarmupSum += (fastRmsLin - speechWarmupSum) / speechWarmupCount
          speechLevelDb = linToDb(speechWarmupSum)
        } else {
          speechLevelDb += this.speechCoef * (fastRmsDb - speechLevelDb)
        }
      }

      // threshold derivation (spec §3.3)
      const targetDb = fixedMode ? p.fixedThresholdDb : speechLevelDb + headroomDbSmoothed
      T[i] = clamp(dbToLin(targetDb), T_MIN, T_MAX)
    }

    this.fastRmsMeanSq = fastRmsMeanSq
    this.noiseEstDb = noiseEstDb
    this.gateHoldSamples = gateHoldSamples
    this.speechLevelDb = speechLevelDb
    this.speechWarmupCount = speechWarmupCount
    this.speechWarmupSum = speechWarmupSum
    this.headroomDbSmoothed = headroomDbSmoothed
    this.outputTrimDbSmoothed = outputTrimDbSmoothed

    // Emphasis coefficients recompute only when the raw target has moved
    // enough to matter (deviation note 3) — cheap on a knob drag, free
    // otherwise.
    if (Math.abs(p.emphasisDb - this.emphasisDbCommitted) > EMPHASIS_RECOMPUTE_EPS_DB) {
      this._updateEmphasis(p.emphasisDb)
    }

    while (this.oversamplers.length < nOut) this.oversamplers.push(new Oversampler())
    this.preEmphasis.ensureChannels(nOut)
    this.deEmphasis.ensureChannels(nOut)

    const L = OVERSAMPLE_FACTOR
    // Peak reduction is measured AT THE CLIP CURVE ITSELF — the difference in
    // dB between what went into softClip() and what came out, at whichever
    // oversampled sample this block reduced the most — rather than by
    // comparing the stage's raw input/output peaks (spec §7.2's literal
    // wording). That literal version compares two buffers that are NOT
    // time-aligned: the oversampler's ~50-sample group delay means "this
    // block's input peak" and "this block's output peak" can belong to
    // different moments in the signal. Measured: on a signal with a sudden
    // level change landing near a block boundary, that misalignment produces
    // a many-dB SPURIOUS reduction reading with no clipping involved at all —
    // this block's louder input compared against the previous block's
    // still-arriving quieter output. Measuring inside the clip curve is
    // exactly what FET1176Kernel/LA2AKernel already do for their own GR
    // meters (`grDb`, computed at the gain cell, not from I/O peaks) and is
    // immune to the issue by construction — there is nothing to misalign
    // when both sides of the comparison are read at the same instant.
    let blockMaxReductionDb = 0

    for (let ch = 0; ch < nOut; ch++) {
      const input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const oversampler = this.oversamplers[ch]

      let stagedInput = input
      if (this.emphasisActive) {
        // Pre-emphasis runs at the base rate, in place into a scratch view —
        // BiquadCascade.process supports output aliasing input.
        this.preEmphasis.process(input, out, n, ch)
        stagedInput = out
      }

      const hi = oversampler.up(stagedInput, n)

      // T changes on time constants no faster than a few milliseconds — the
      // speech tracker alone is 3 s — so unlike a fast compressor's gain
      // envelope it needs no interpolation across the oversampled
      // sub-samples; holding it flat across each group of L is inaudible.
      for (let i = 0; i < n; i++) {
        const t = T[i]
        for (let j = 0; j < L; j++) {
          const k = i * L + j
          const before = hi[k]
          const after = softClip(before, t)
          hi[k] = after
          const ab = before < 0 ? -before : before
          if (ab > t) {
            const aa = after < 0 ? -after : after
            const redDb = linToDb(ab) - linToDb(aa)
            if (redDb > blockMaxReductionDb) blockMaxReductionDb = redDb
          }
        }
      }

      oversampler.down(out, n)

      if (this.emphasisActive) {
        this.deEmphasis.process(out, out, n, ch)
      }

      for (let i = 0; i < n; i++) {
        out[i] *= trimGain[i]
      }
    }

    this.reductionDb = blockMaxReductionDb
    if (this.reductionDb > this.maxReductionDb) this.maxReductionDb = this.reductionDb
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh
 * kernel. Used by Node verification scripts; the app itself renders through
 * an OfflineAudioContext running the worklet so preview and apply share the
 * exact same code path.
 */
export function processSoftClipperBuffer(channelData, sampleRate, params = {}) {
  const kernel = new SoftClipperKernel(sampleRate)
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

  return {
    channelData: output,
    latencySamples: kernel.latencySamples,
    metering: kernel.getMetering(),
  }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  const METER_INTERVAL_SAMPLES = 1024

  class SoftClipperWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SoftClipperKernel(sampleRate)
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
        this.port.postMessage({ type: 'gr', reductionDb: this.kernel.reductionDb })
      }
      return true
    }
  }

  registerProcessor('soft-clipper-processor', SoftClipperWorkletProcessor)
}
