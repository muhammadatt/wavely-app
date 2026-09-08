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
import { RmsFollower, riseCoeff, dbToLin } from './dsp/envelope.js'
import {
  HfLossShelf, SkewTracker, asymmetryOffset, makeDcBlocker, ASYM_EPSILON,
} from './dsp/tapeCharacter.js'

export const VOCAL_SAT_LATENCY_SAMPLES = VOCAL_SAT_OVERSAMPLE.latencySamples

export const VOCAL_SAT_KERNEL_DEFAULTS = {
  drive: 2.0,
  wetDry: 0.3,
  // ── Asymmetry (was `bias`) ───────────────────────────────────────────────
  // 0-100, and the SAME QUANTITY the old `bias` number was: the offset is
  // `asymmetry/100 * ASYM_MAX_FRACTION * reference`, ASYM_MAX_FRACTION is 1 and
  // the reference is 1 (see ASYM_REFERENCE), so `asymmetry: 50` puts the same
  // 0.5 in front of the curve that `bias: 0.5` did. The magnitude of the
  // shipped patch is unchanged by the rename; only the SIGN is now measured
  // from the material rather than always positive.
  asymmetry: 50,
  // Knee order of the transfer curve — see `shape`. Replaces `softness`, which
  // crossfaded tanh against arctan; measured at matched THD those two are the
  // same curve to within 3 dB at the 5th harmonic and the blend was not a
  // character control. This one is.
  hardness: 2.5,
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
 * ⚠ THE FILTER AND ITS CONSTANTS LIVE IN dsp/tapeCharacter.js, not here. It
 * arrived from the soft clipper, where it was one third of a Drive knob inside
 * a stage whose identity is transparency; it is a plain linear filter and
 * belonged in neither place as a private copy. That module is where the rest of
 * the tape-character family waits for the plugin that will use it, and keeping
 * one owner is what stops this becoming two constants that drift.
 *
 * What it is: a first-order high shelf built as a blend, `g*x + (1-g)*LP(x)`,
 * with a constant depth. Exactly transparent at g = 1 and provably incapable of
 * boosting. Measured here at full knob: -0.22 / -0.79 / -2.34 / -4.75 / -6.51
 * dB at 1k / 2k / 4k / 8k / 16k.
 */

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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * THE TRANSFER CURVE, and why it is no longer tanh.
 *
 *   shape(x) = x / (1 + |x|^n)^(1/n)
 *
 * Same shape family at every n: odd, monotonic, unity slope at the origin,
 * asymptotically |shape| -> 1. What n moves is the ONLY thing about a
 * memoryless odd curve that is audible once you have matched the amount of
 * distortion — HOW FAST THE HARMONIC SERIES DECAYS.
 *
 * ⚠ THE THING THIS REPLACED WAS NOT A CHARACTER CONTROL. `softness` crossfaded
 * tanh against (2/pi)*arctan. Driven to a MATCHED 5% THD, which is the only
 * comparison that means anything, the two are the same curve:
 *
 *   curve            H3      H5      H7      H9
 *   tanh           -26.0   -50.3   -74.3   -98.4
 *   (2/pi)arctan   -26.1   -47.0   -66.4   -85.1
 *
 * 3 dB apart at the 5th and nothing at all at the 3rd, which is where the
 * energy is. The knob swept between two points that were audibly one point.
 *
 * Against the same 5% THD reference, n IS the axis:
 *
 *   n       H3      H5      H7      H9        character
 *   1     -26.2   -40.0   -49.1   -55.8      dense, buzzy, "fuzz"
 *   2.5   -26.0   -58.6   -64.4   -72.5      (the default)
 *   3     -26.0   -58.7   -58.4   -70.4      close-in, clean
 *   8     -26.4   -36.8   -79.3   -57.9      hard-clip-like, spiky
 *
 * H3 does not move — it cannot, it IS the 5% — and everything above it moves by
 * 20 dB. That is what makes n a character control and `softness` not one.
 *
 * ⚠ TANH IS NO LONGER REACHABLE AT ANY SETTING and that is deliberate, not an
 * oversight. tanh's series decays about 24 dB per harmonic, faster than any
 * member of this family; past the 3rd there is nothing there, which is exactly
 * the complaint the curve was changed to answer. If it is ever wanted back it
 * is a curve, not an n.
 *
 * ⚠ HARDER IS NOT DIRTIER, AND THE ALIASING GOES THE OTHER WAY FROM INTUITION.
 * At a matched 5% THD through this plugin's own 2x path, a 7 kHz probe folds
 * worst at the SOFT end — n=1 total alias -57.5 dBc, n=1.5 -68.0, n=2.5 -79.0,
 * n=4 -86.5 — because "soft" here means a slowly-decaying series, and it is the
 * high harmonics that fold. That measurement, not taste, is what sets
 * HARDNESS_MIN; see it for the bound the panel actually enforces.
 *
 * ⚠ AND IT ONLY WORKS BELOW SATURATION. Every member of this family tends to
 * sign(x) for large |x|, so once the drive has squared the wave off there is no
 * knee left to shape. Measured in the plugin as series tilt (H11 against H5,
 * which cancels the amount and leaves the decay rate), swing from n=2 to n=8:
 *
 *   drive 1, low band mult 5 (effective 5)     12.8 dB    the knob works
 *   drive 3, low band mult 5 (effective 15)     1.4 dB    near-inert
 *   all three bands at mult 8, drive 2          1.7 dB    near-inert
 *
 * THE SHIPPED PATCH IS IN THE INERT REGION: the kernel default is drive 2.0
 * into a mult of 5, and the panel's is 2.0 into 8. `softness` was inert for the
 * same reason at EVERY setting, which is the likeliest explanation for why a
 * control that measurably did nothing survived this long unreported. Lowering
 * the default drive would put Hardness inside its own window and would change
 * the sound the plugin ships with; that has NOT been done here, and it is the
 * first thing to try if this knob is ever reported as doing nothing.
 *
 * It is also CHEAPER than what it replaced. The blend evaluated tanh and atan
 * per sample and recomputed both at the bias point per sample too — four
 * transcendentals per band per sample. This is two, and the caller hoists the
 * operating-point term out of the sample loop entirely.
 */
function shape(x, hardness) {
  const a = Math.abs(x)
  if (a < 1e-12) return x
  return x / Math.pow(1 + Math.pow(a, hardness), 1 / hardness)
}

/**
 * The curve, run off-centre by `offset` with its operating point removed.
 *
 * ⚠ `shapedOffset` MUST be `shape(offset, hardness)` — the caller passes it in
 * because it is constant for a whole block and evaluating it per sample was a
 * third of this function's cost. See tapeCharacter's note (1): asymmetry is not
 * a stage, it is `curve(x + off) - curve(off)`, and where the curve is
 * transparent that expression is exactly `x`. Every harmonic the offset appears
 * to create belongs to THIS curve, generated off-centre.
 */
function applyTransfer(pre, hardness, offset, shapedOffset) {
  return shape(pre + offset, hardness) - shapedOffset
}

/**
 * Bounds on the knee order, and the ONE of the two that is a measurement.
 *
 * HARDNESS_MIN IS SET BY ALIASING, not by taste, and the ordering is the
 * OPPOSITE of the intuition — the SOFT end is the dirty end. "Soft" here does
 * not mean gentle, it means a SLOWLY-DECAYING harmonic series, and it is the
 * high harmonics that fold. Two probes, and they disagree in a way worth
 * keeping, because the next person to widen this range will read only one.
 *
 * (a) The CURVE ALONE through this plugin's 2x path, drive matched to 5% THD,
 *     7 kHz probe, total folded energy against the fundamental:
 *
 *       n      1      1.5      2      2.5      3       4       6       8
 *       dBc  -57.5  -68.0  -109.8  -79.0   -80.5   -86.5   -76.3   -74.6
 *
 *     n=1 and n=1.5 fail this file's own -70 dB alias bar outright. 2.0 is the
 *     floor because it is the first value with real margin.
 *
 * (b) THE WHOLE PLUGIN, kernel defaults, low band dropped to a near-linear
 *     drive, asymmetry off (`a near-linear band produces essentially no
 *     aliasing`):
 *
 *       n      2       2.5     3       4       6       8
 *       dB  -134.8  -144.0  -148.5  -149.3  -151.8  -152.3
 *
 * ⚠ (b) IS MONOTONIC AND (a) IS NOT, so do not carry (a)'s shape across. In
 * particular n=2 reads 30 dB BETTER than its neighbours in (a) and is the WORST
 * of the range in (b) — that outlier is a property of one isolated probe at one
 * drive, it does not survive contact with the band split, and nothing should be
 * built on it. What both probes agree on is the direction: softer folds more.
 *
 * HARDNESS_MAX is taste. Past about 8 the curve is a hard clipper with a
 * rounded corner and n stops changing what you hear.
 *
 * ⚠ WHAT THIS CURVE COST, stated plainly because it is a real trade and not a
 * free win. A richer harmonic series folds more, so running the curve OFF
 * CENTRE gives up alias margin that tanh had. Same near-linear probe, offset
 * 0.5: tanh measured -139.4 dB, this curve at hardness 2.5 measures -109.1. In
 * the worst corner the panel can reach (drive 5, all three band mults at 8,
 * fully wet, 235 Hz) tanh at full bias measured -75.3 dB and this measures
 * -70.0 at hardness 2 falling to -55.7 at hardness 8 with asymmetry at 100.
 *
 * ⚠ THAT CORNER WAS ALREADY BAD AND THIS IS NOT WHAT MADE IT BAD. On the same
 * patch a 12 kHz tone measures -18 to -20 dB, and the OLD tanh build measures
 * -20.2 dB on it — 40x drive into three bands through a 2x path folds whatever
 * curve you put in it. If this plugin ever gets 4x oversampling, that is the
 * number it buys back, and this curve's off-centre cost goes with it.
 */
export const HARDNESS_MIN = 2
export const HARDNESS_MAX = 8

/**
 * The level the asymmetry offset is referenced to.
 *
 * ⚠ IT IS 1 BECAUSE THE OFFSET IS ADDED AFTER DRIVE, in the curve's own input
 * units, where the knee sits at |x| ~ 1 by construction for every n. That is
 * what makes it the level the nonlinearity acts at, which is what
 * `asymmetryOffset` documents its reference argument to be. Referenced to the
 * band's own level instead, the offset would track programme material and stop
 * being a character control — the failure tapeCharacter records under "ONLY THE
 * SIGN COMES FROM THE SKEW".
 *
 * It also makes the rename arithmetic-free: ASYM_MAX_FRACTION is 1, so the
 * offset is exactly `asymmetry/100`, and the `bias: 0.5` this replaced is
 * `asymmetry: 50` to the last bit.
 */
const ASYM_REFERENCE = 1

// ── The voiced gate the skew tracker requires ──────────────────────────────

/** Short-term level, fast enough to open inside a syllable. */
const VOICED_TAU_MS = 20

/** Creep-up rate of the noise-floor valley follower. */
const NOISE_FOLLOW_TAU_MS = 2000

/** How far over the floor a sample must sit to count as voice. */
const VOICED_MARGIN_DB = 12

/**
 * Decides which samples the skew tracker is allowed to see.
 *
 * ⚠ THE TRACKER CANNOT OWN THIS AND tapeCharacter SAYS SO: "FEED IT ONLY VOICED
 * SAMPLES. The caller owns the gate." A pause contributes room tone to the
 * second moment and almost nothing to the third, so ungated the skew estimate
 * is dragged toward zero by silence — which lands inside the deadband and
 * quietly disables the whole control on any file with pauses in it.
 *
 * A valley follower that snaps DOWN and creeps UP, exactly as the soft
 * clipper's noise estimate does. Deliberately not a port of that detector: this
 * needs a boolean, not a threshold in dB, and carrying a copy of a 200-line
 * tracker to get one is the trade tapeCharacter warns against under Soften.
 */
class VoicedGate {
  constructor(sampleRate) {
    this.fast = new RmsFollower(sampleRate, VOICED_TAU_MS, 1e-9)
    this.creep = riseCoeff(NOISE_FOLLOW_TAU_MS, sampleRate)
    this.margin = dbToLin(VOICED_MARGIN_DB)
    this.floor = 0
    this.primed = false
  }

  /** @returns {boolean} whether this sample is voice rather than room. */
  update(x) {
    const level = this.fast.process(x)
    if (!this.primed) {
      this.floor = level
      this.primed = true
    } else if (level < this.floor) {
      this.floor = level
    } else {
      this.floor += this.creep * (level - this.floor)
    }
    return level > this.floor * this.margin
  }
}

/** Per-channel filter, follower, and resampler state. */
class ChannelState {
  constructor(sampleRate) {
    const qs = butterworthQs(4)
    this.lp = new BiquadCascade(qs.length, 1)
    this.hp = new BiquadCascade(qs.length, 1)
    this.dryRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.wetRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)
    this.outRms = new RmsFollower(sampleRate, RMS_TAU_MS, RMS_FLOOR)

    // One upsampler per band, because each band is filtered at the base rate
    // and only then taken up. The three saturated bands are summed while still
    // at the high rate, so a single downsampler serves all of them.
    this.upLow = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upMid = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.upHigh = new Oversampler(VOCAL_SAT_OVERSAMPLE)
    this.downWet = new Oversampler(VOCAL_SAT_OVERSAMPLE)

    // Asymmetry state. Per channel because the skew is a property of what that
    // channel recorded — a stereo pair miked differently can lean two ways.
    this.skew = new SkewTracker(sampleRate)
    this.gate = new VoicedGate(sampleRate)
    this.dcBlock = makeDcBlocker(sampleRate)

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
    // The shelf owns its own filter state and its depth ramp — see HfLossShelf,
    // which advances the ramp once per BLOCK rather than once per channel per
    // sample. The inline version this replaced advanced it inside the channel
    // loop, so on stereo the 30 ms ramp converged in 15.
    this.hfLoss = new HfLossShelf(sampleRate)
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
    this.hfLossMaxDb = HfLossShelf.depthFor(p.hfLoss ?? 0)
    this.hfLossActive = HfLossShelf.isActive(this.hfLossMaxDb)

    this.hardness = clamp(p.hardness, HARDNESS_MIN, HARDNESS_MAX)
    // Read as 0-100 and ABSENT below the epsilon, so a patch at 0 runs no DC
    // blocker and takes no branch — the same rule HF Loss follows, and the
    // thing that keeps `asymmetry: 0` bit-identical to a build without any of
    // this. `asymmetryOffset` applies the same epsilon to the offset itself.
    this.asymmetry = clamp(p.asymmetry, 0, 100)
    this.asymActive = this.asymmetry / 100 > ASYM_EPSILON
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

    const { hardness, asymActive, wetDry, lowDrive, midDrive, highDrive } = this
    const L = VOCAL_SAT_OVERSAMPLE.factor

    const { low: lowBuf, high: highBuf, mid: midBuf, wet: wetBuf } = this._scratch(n)

    // ONCE PER BLOCK, BEFORE THE CHANNEL LOOP — see HfLossShelf. The depth is a
    // parameter ramp shared by every channel; advancing it per channel makes it
    // converge N times faster on N channels.
    const hfLossGain = this.hfLossActive ? this.hfLoss.advance(this.hfLossMaxDb, n) : 1

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

      // ── Which way the offset should lean ─────────────────────────────────
      // Fed the BROADBAND input, which is exactly what the three curves see
      // between them: the split is complementary, so the bands sum back to this
      // signal. Feeding one band instead would measure that filter's skew, and
      // tapeCharacter is explicit that a shelf changes a waveform's lean.
      //
      // Updated BEFORE the offset is read, so a block uses its own direction
      // rather than the previous one. The ramp is 200 ms; either would do.
      if (asymActive) {
        for (let i = 0; i < n; i++) {
          if (st.gate.update(input[i])) st.skew.update(input[i])
        }
      }
      const offset = asymActive
        ? asymmetryOffset(this.asymmetry, st.skew.direction, ASYM_REFERENCE)
        : 0
      // Constant for the block — see applyTransfer on why this is hoisted.
      const shapedOffset = shape(offset, hardness)

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
          applyTransfer(lowUp[j] * lowDrive, hardness, offset, shapedOffset) +
          applyTransfer(midUp[j] * midDrive, hardness, offset, shapedOffset) +
          applyTransfer(highUp[j] * highDrive, hardness, offset, shapedOffset)
      }

      st.downWet.down(wetBuf, n)

      // ⚠ LOAD-BEARING, AND ONLY WHILE THE OFFSET IS ENGAGED — see DC_BLOCK_HZ.
      // `curve(x + off) - curve(off)` removes the operating point for a SILENT
      // input; under signal the mean of the off-centre curve is not curve(off),
      // and what is left is level-dependent DC. It lands on the wet path, ahead
      // of both RMS matches, so untreated it is read as level and handed back
      // as gain. tapeCharacter measured -45.2 dBFS of it on a driven 120 Hz
      // tone, and a file that already carried DC came out 5.1 dB below its own
      // peak — which corrupts exactly the peak measurement ACX compliance is
      // built on. This is the plugin that shipped `bias` with no blocker at all.
      if (asymActive) st.dcBlock.process(wetBuf, wetBuf, n, 0)

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
        const y = blended * (dryRms / outRms)

        out[i] = y > 1 ? 1 : y < -1 ? -1 : y
      }

      // HF LOSS — see dsp/tapeCharacter.js.
      //
      // ⚠ ON THE FINISHED OUTPUT, NOT ON THE WET PATH, and that is a claim
      // about what is being modelled. This is the MEDIUM's bandwidth, not the
      // saturation's: a tape machine does not roll off only the part of the
      // signal that saturated. Blending a dulled copy underneath a
      // full-bandwidth dry copy nets very little HF change at any ordinary
      // Wet/Dry — measured, 0.79 dB against 3.77 at the default blend.
      //
      // ⚠ AFTER THE OUTPUT NORMALISATION, deliberately. Placed before it, the
      // `dry_rms / out_rms` match reads the energy this filter just removed as
      // a level drop and pushes the whole signal back up to compensate — the
      // level match undoing the tone control, silently.
      //
      // ⚠ THE COST: Wet/Dry 0 is no longer the dry signal once this is engaged.
      // That is intended and is the one place this plugin's parallel-blend
      // contract is deliberately broken, because a medium the dry path bypasses
      // is not a medium. The knob is absent at 0, so the contract holds for
      // anyone who does not reach for it.
      //
      // ⚠ IT NOW RUNS AFTER THE ±1 CLAMP, WHERE THE INLINE VERSION RAN BEFORE
      // IT. A block pass cannot sit inside the per-sample loop, and the move is
      // safe in both directions that matter: the clamp only acts on overload,
      // and the shelf provably cannot boost, so the ±1 guarantee survives
      // either ordering. On overload it now softens the corner the clamp
      // squared off rather than handing the clamp an already-softened edge,
      // which is if anything the more faithful of the two.
      if (this.hfLossActive) this.hfLoss.process(out, n, ch, hfLossGain)
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
