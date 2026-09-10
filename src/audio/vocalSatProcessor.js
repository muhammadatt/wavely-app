/**
 * Vocal Saturation — worklet kernel.
 *
 * Began as a realtime port of server/scripts/vocal_saturation.py: a
 * complementary three-band split, a blended tanh/arctan transfer with per-band
 * drive, and a gain-neutral parallel blend back against the dry signal. It has
 * since diverged from that Python in three ways that matter — the transfer is a
 * knee-order curve rather than a tanh/arctan blend (see `shape`), the asymmetry
 * offset takes its sign from the material rather than always leaning positive
 * (see ASYM_REFERENCE), and the stage can now run in SERIES as one broadband
 * curve rather than only as a parallel sum of three (see MODE_SERIES). The
 * server's `vocalSaturation` pipeline stage is still the Python and is
 * unaffected by any of it.
 *
 * This file is BOTH a normal ES module (exports VocalSatKernel and
 * processVocalSatBuffer) AND an AudioWorklet module (registers
 * 'vocal-sat-processor'). It imports from ./dsp/, so its loader pulls it
 * through `?worker&url` — see vocalSatWorkletLoader.js.
 *
 * Two deliberate deviations from the Python, both consequences of the fact
 * that a streaming effect cannot see the whole file:
 *
 * ⚠ 3. PREVIEW AND APPLY ARE NOT SAMPLE-IDENTICAL. This file used to be
 *    described as producing exactly what the preview produced; it does not, and
 *    it never quite did. The apply path starts cold while the preview has run
 *    over the whole session, so every follower in here begins somewhere else.
 *    VOCAL_SAT_PREROLL_S is what narrows the gap and records how far.
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

import { lowpass, highpass, highShelf, butterworthQs, BiquadCascade } from './dsp/biquad.js'
import { Oversampler, DelayLine, VOCAL_SAT_OVERSAMPLE } from './dsp/oversample.js'
import { LookaheadLimiter } from './dsp/lookaheadLimiter.js'
import { RmsFollower, riseCoeff, dbToLin } from './dsp/envelope.js'
import {
  HfLossShelf, SkewTracker, asymmetryOffset, makeDcBlocker, ASYM_EPSILON,
  SoftenLimiter, softenScale, SOFTEN_EPSILON,
} from './dsp/tapeCharacter.js'

export const VOCAL_SAT_LATENCY_SAMPLES = VOCAL_SAT_OVERSAMPLE.latencySamples

/**
 * Seconds of real audio the offline apply path should run through the kernel
 * BEFORE the region, and discard. See applyWorkletRegion in processing.js.
 *
 * ⚠ THIS STAGE IS NOT SAMPLE-IDENTICAL BETWEEN PREVIEW AND APPLY AND CANNOT BE
 * MADE SO. The preview worklet has been running over everything the user
 * played; the apply render starts cold at the region's first sample. Every
 * follower, gate and tracker in here therefore begins in a different state.
 * Measured, preview settled against a cold apply, energy over the first 0.5 s:
 *
 *   patch                                  first 0.5 s
 *   kernel default (parallel, offset)        -0.363 dB
 *   series + cubic + tame                    -1.275
 *     + autoDrive 100                        -1.678
 *     + asymmetry 100                        -2.055
 *
 * Read the BOTTOM of that table, not the top. The first row is
 * VOCAL_SAT_KERNEL_DEFAULTS; the patch the panel now opens with is series,
 * autoDrive 100 and asymmetry 100, so the figure that applies to what a user
 * actually hears is the last one. It is also why VOCAL_SAT_PREROLL_S is 4 s
 * rather than the 2 s that suffices for OptoSmooth and Scheps.
 *
 * That last figure is inside the range tapeCharacter records for the same
 * defect the last time it shipped. Most of it is NOT new: the three 300 ms RMS
 * followers alone account for -1.035 dB, and series mode amplifies them because
 * at wetDry 1 the output is entirely wet.
 *
 * AND ONE FAILURE IS WORSE THAN A LEVEL OFFSET. The skew tracker settles to
 * direction -0.62 on positive-leaning material but reads +1.00 before its 3 s
 * evidence gate, so a selection shorter than that had its asymmetry leaning the
 * WRONG WAY — worth up to 7.9 dB of other distortion by that module's own
 * measurement. A decision, not a settling difference.
 *
 * ── WHY 4 AND NOT MORE ─────────────────────────────────────────────────────
 *
 * Convergence of a cold apply toward the settled preview, full patch:
 *
 *   pre-roll    0 s     1 s     2 s     3 s     4 s     8 s    all
 *   first .5s  -1.083  -0.645  -0.316  -0.295  -0.297  -0.031  0.000
 *
 * It knees at 2-3 s — the skew tracker's SKEW_EVIDENCE_S is 3 — and then
 * plateaus near -0.3 dB before improving again much later. 4 s covers the
 * evidence gate plus the flip ramp with margin and costs a 2 s region a 6 s
 * render, which is nothing offline.
 *
 * ⚠ IT DOES NOT REACH IDENTITY AND NOTHING SHORT OF THE WHOLE FILE WOULD. At a
 * pre-roll equal to ALL the preceding audio the difference is 0.0000 dB, which
 * is the proof that state history is the only cause — but the voiced gate's
 * valley floor and the skew sign's stickiness depend on history arbitrarily far
 * back, so any finite pre-roll leaves a residue. 4 s takes the opening error
 * from about 1.1 dB to about 0.3.
 */
export const VOCAL_SAT_PREROLL_S = 4

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
  // How the asymmetry is produced — see ASYM_MODE_SPLIT. 'offset' is what
  // ships; 'split' is the variant that does not fight peak absorption.
  asymMode: 'offset',
  // ── Topology ─────────────────────────────────────────────────────────────
  // 'parallel' (the shipped behaviour) or 'series'. See MODE_SERIES for what
  // the difference actually buys and why the default does not move.
  mode: 'parallel',
  // Pre/de-emphasis depth around the curve, 0-100 -> 0-EMPHASIS_MAX_DB. ABSENT
  // at 0, so the patch that shipped before it existed is bit-identical.
  emphasis: 0,
  // Slew limit ahead of the curve, 0-100. SERIES ONLY and absent at 0 — see
  // SOFTEN_REFERENCE_NOTE for why it cannot be offered in parallel.
  soften: 0,
  // Peak control ahead of the curve, 0-100. SERIES ONLY, absent at 0, and
  // costs NO added latency — see TAME_LOOKAHEAD_L.
  tame: 0,
  // Programme-level normalisation ahead of the drive, 0-100. Works in BOTH
  // topologies, unlike Tame and Soften. Absent at 0. See AutoDrive.
  autoDrive: 0,
  // Knee order of the transfer curve — see `shape`. Replaces `softness`, which
  // crossfaded tanh against arctan; measured at matched THD those two are the
  // same curve to within 3 dB at the 5th harmonic and the blend was not a
  // character control. This one is.
  hardness: 2.5,
  // Curve family — see cubicShape. 'shape' is what ships.
  curve: 'shape',
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
export function shape(x, hardness) {
  const a = Math.abs(x)
  if (a < 1e-12) return x
  return x / Math.pow(1 + Math.pow(a, hardness), 1 / hardness)
}

/**
 * CUBIC — a bounded-order polynomial, and the one property it has that no
 * clipping function can.
 *
 *   f(x) = x - x^3/6.75   on |x| <= 1.5,   sign(x) beyond
 *
 * ⚠ A DEGREE-3 POLYNOMIAL GENERATES EXACTLY THE THIRD HARMONIC AND NOTHING
 * ELSE. Not "mostly"; the algebra permits no other term — sin^3 expands to
 * (3sin - sin3)/4, so a cubic in a sine is a fundamental and a third, full
 * stop. Against the shipping curve at a MATCHED 35% THD, which is what this
 * plugin puts on an onset in series:
 *
 *   curve                  H3      H5      H7      H9     H11   above H5
 *   shape n=2.5          -10.5   -16.5   -21.3   -25.7   -29.8     9.6%
 *   this cubic            -9.1       -       -       -       -     0.0%
 *
 * That last column is the audible difference. High-order harmonics are what
 * reads as GRIT; a pure third reads as thickness. Same amount of distortion,
 * different kind.
 *
 * ⚠ AND IT IS ESSENTIALLY ALIAS-FREE AT THIS PLUGIN'S 2x, WHICH THE RATIONAL
 * FAMILY CAN NEVER BE. Bounded harmonic order is bounded bandwidth: a cubic
 * triples it, so at 2x a 7 kHz tone's third lands at 21 kHz, under the 22.05
 * kHz Nyquist, and nothing folds. Measured, 7 kHz probe, matched THD:
 *
 *   5% THD    shape n=2.5   -79.0 dBc        this cubic   -151.1 dBc
 *
 * 72 dB, and it is structural rather than tuning.
 *
 * ⚠ BOTH ADVANTAGES DIE IN THE CLAMP, AND THE CLAMP IS NOT OPTIONAL. A
 * polynomial diverges — this one turns over at x = 1.5 and heads for -infinity
 * — so it must be clamped, and a clamp is a hard clipper with UNBOUNDED order.
 * Everything above holds only while the signal stays inside |x| <= 1.5:
 *
 *   5% THD  (in domain)   above H5  0.0%    alias -151.1 dBc
 *   35% THD (clamped)     above H5  6.3%    alias  -34.9 dBc
 *
 * ⚠ AND IN THIS PLUGIN THE CLAMP IS THE NORMAL CASE, NOT THE EDGE CASE, which
 * is the single most important thing to know before reaching for this curve.
 * The band mults are 8, so Drive 1 already presents a peak of 3.2 to a curve
 * whose domain ends at 1.5. Measured in the plugin, series, asymmetry 0:
 *
 *   curve   drive    THD      H5      grit (above H5)
 *   shape    0.3     6.9%   -49.5        0.0%
 *   cubic    0.3     3.9%   -67.5        0.0%     <- 18 dB less 5th
 *   shape      1    26.5%   -20.6        2.6%
 *   cubic      1    30.0%   -19.2        1.6%
 *   shape      2    35.7%   -16.3       10.6%
 *   cubic      2    38.9%   -15.2       12.7%     <- WORSE than shape
 *   shape      4    41.4%   -14.7       19.3%
 *   cubic      4    43.3%   -14.3       22.3%     <- worse again
 *
 * The promise holds at Drive 0.3 and inverts by Drive 2. Past the domain this
 * is a hard clipper wearing a polynomial's name, and a hard clipper is grittier
 * than the rational curve it replaced. THE WHOLE VALUE OF THIS CURVE IS
 * CONDITIONAL ON THE SIGNAL STAYING IN DOMAIN, and nothing here enforces that.
 *
 * An envelope-domain limiter ahead of the curve would enforce it, and that is
 * the obvious next piece. It is deliberately NOT in this change: the curve was
 * asked for on its own so it could be judged on its own. Judge it at LOW DRIVE,
 * or the measurement above says you will be listening to the clamp.
 *
 * ── THE NORMALISATION, WHICH IS NOT THE TEXTBOOK ONE ───────────────────────
 *
 * The usual form is `1.5x - 0.5x^3`, clamped at 1. That has a slope of 1.5 at
 * the origin — 3.5 dB of gain — so switching to it from `shape` would change
 * the level as well as the character and an A/B would be measuring the wrong
 * thing. Solving instead for unity slope at 0, an asymptote of 1, and a C1 join
 * (no corner where the clamp takes over):
 *
 *   f'(0) = 1 -> coefficient of x is 1
 *   f'(t) = 1 - 3b t^2 = 0     ->  b = 1/(3t^2)
 *   f(t)  = t - t/3 = 2t/3 = 1 ->  t = 3/2,  b = 1/6.75
 *
 * Verified: f(0)=0, f'(0)=1, f(1.5)=1, f'(1.5)=0, monotonic on [0, 1.5], and
 * within 0.01 dB of `shape` at |x| <= 0.2. So the switch is a change of
 * character at matched level, which is what makes it auditionable.
 *
 * ⚠ IT STILL DISTORTS HARDER AT THE SAME DRIVE, and no normalisation fixes
 * that because it is not a level difference. Matched THD needs drive 7.45 here
 * against 14.90 for `shape` at 35%, and 1.81 against 2.03 at 5% — the ratio is
 * not even constant, so no single trim could compensate it. Expect to back
 * Drive off when switching to this curve.
 *
 * ⚠ HARDNESS DOES NOTHING HERE. It is the knee order of the rational family;
 * this curve's knee order is 3 by construction. The panel disables the knob.
 */
const CUBIC_LIMIT = 1.5
const CUBIC_COEFF = 1 / 6.75

export function cubicShape(x) {
  if (x >= CUBIC_LIMIT) return 1
  if (x <= -CUBIC_LIMIT) return -1
  return x - CUBIC_COEFF * x * x * x
}

/** Curve families. `shape` is the shipped default; see cubicShape for the other. */
export const CURVE_SHAPE = 'shape'
export const CURVE_CUBIC = 'cubic'

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
function applyTransfer(curveFn, pre, hardness, offset, shapedOffset) {
  return curveFn(pre + offset, hardness) - shapedOffset
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

/**
 * THE TWO WAYS TO BE ASYMMETRIC, and why the shipped one fights the rest of
 * this plugin.
 *
 * ⚠ AN OFFSET MAKES THE CURVE'S TWO BOUNDS UNEQUAL, and that — not the even
 * harmonics — is what pushes onsets forward. `curve(x + off) - curve(off)`
 * still asymptotes to +-1 BEFORE the subtraction, so afterwards the bounds are
 * `1 - f(off)` and `-1 - f(off)`: different by `2*f(off)`. Measured on
 * shape n=2.5:
 *
 *   offset 0.25    bounds  +0.753 / -1.247    4.38 dB apart
 *   offset 0.5     bounds  +0.532 / -1.469    8.83 dB
 *   offset 1.0     bounds  +0.242 / -1.758   17.22 dB
 *
 * At the panel's shipped Asymmetry of 100 the negative bound sits SEVENTEEN dB
 * above the positive one. The output is grossly lopsided, so the peak is set by
 * whichever polarity clips late while the RMS falls with the one that clips
 * early — crest rises and the onset protrudes. That is a property of offsetting
 * a BOUNDED curve, and has nothing to do with even harmonics as such.
 *
 * ── THE SPLIT KNEE ─────────────────────────────────────────────────────────
 *
 * Give each polarity a different knee ORDER instead of shifting the operating
 * point. `shape` has f'(0) = 1 and an asymptote of 1 for EVERY n, so the two
 * halves meet at the origin with the same slope (no corner at a zero crossing)
 * and bound to the same +-1. Asymmetric in the middle, symmetric at the
 * extremes. Measured bound imbalance: -0.01 dB at the mild end, -1.04 dB at the
 * widest usable spread, against 17.22 dB for the offset.
 *
 * Warmth against the onset cost, bare curve at drive 8:
 *
 *   mechanism      H2      d crest
 *   symmetric       -       -8.63
 *   offset 0.5    -14.2     -4.90     3.7 dB of softening given up
 *   split k=4     -14.3     -7.38     1.25 dB given up, for the same H2
 *   offset 1.0     -9.3     -1.10     7.5 dB given up
 *   split k=8     -10.2     -6.89     1.7 dB, for the same H2
 *
 * So warmth and onset prominence are SEPARABLE. They are welded together only
 * by the offset mechanism.
 *
 * ⚠ IT IS NOT A FREE LUNCH — IT MOVES THE COST, IT DOES NOT REMOVE IT. The
 * k=8 row above needs knee orders of 20 and 0.31, far outside the range
 * HARDNESS_MIN measured as safe, and aliases at -43.8 dBc accordingly. Held
 * inside [HARDNESS_MIN, HARDNESS_MAX], which is what this implementation does:
 *
 *   curve            H2      d crest    alias
 *   symmetric n=2.5   -       -8.63    -62.3 dBc
 *   symmetric n=4     -       -9.12    -47.0 dBc
 *   split 8 / 2     -24.6     -8.85    -43.1 dBc
 *   offset 0.5      -14.2     -4.90    -67.1 dBc
 *
 * Essentially ZERO crest penalty (-8.85 against -8.63 symmetric), but only
 * -24.6 dB of H2 — about 10 dB less warmth than the offset reaches — and about
 * 4 dB worse aliasing than a symmetric curve at the same THD. THIS IS THE
 * SUBTLE OPTION THAT COSTS NO ONSETS; offset is still the one that gets loud.
 *
 * ⚠ SPLIT REQUIRES CURVE = SHAPE. The mechanism needs a family with a shape
 * parameter that leaves the asymptote alone, and the cubic has none: its
 * normalisation (unity slope, asymptote 1, C1 join) determines it uniquely, so
 * there is no second cubic to put on the other polarity. A quintic with one
 * free parameter would give one; that is a new curve family, not a mode. The
 * kernel falls back to offset for the cubic rather than silently doing nothing.
 *
 * ⚠ AND ON THIS CURVE ASYMMETRY IS PARTLY A REBALANCING, not the pure addition
 * tapeCharacter records for the curve IT measured ("H3 moves by at most 1 dB
 * across the entire sweep"). Here H3 goes -20.2 -> -25.1 -> -28.8 as the offset
 * goes 0 -> 0.5 -> 1.0: odd content is traded for even, which is a larger
 * character change than that note implies. Measured on shape n=2.5, not on the
 * soft clipper's knee, so it contradicts nothing — but do not carry the claim
 * across.
 */
export const ASYM_MODE_OFFSET = 'offset'
export const ASYM_MODE_SPLIT = 'split'

/**
 * The knee pair, interpolated geometrically from Hardness TOWARD the bounds.
 *
 * ⚠ THE OBVIOUS FORM — a fixed ratio, `h * k^d`, CLAMPED to the range — WAS
 * INERT OVER HALF THE KNOB, and this is the THIRD control in this file to fail
 * that way (Soften's first reference, Tame's first threshold mapping, this).
 * With ratio 4 at Hardness 4 the pair hits 8/2 at Asymmetry 50 and then cannot
 * move: measured H2 -34.3 and crest -5.06 at BOTH 50 and 100, identical.
 *
 * Interpolating toward the bounds instead uses the whole travel at every
 * Hardness and needs no clamp, because the endpoints ARE the bounds:
 *
 *   u = |asymmetry/100 * direction|
 *   nPos = hardness * (target /hardness)^u      target  = MAX (or MIN if leaning)
 *   nNeg = hardness * (other  /hardness)^u      other   = the opposite bound
 *
 * At u = 0 both are Hardness — exactly symmetric, so the mode is absent at 0 by
 * construction rather than by a branch. At u = 1 the pair is 8/2, the widest
 * spread the measured-safe range allows.
 *
 * ⚠ FULL TRAVEL REACHES 8/2 AT EVERY HARDNESS, which the clamped form could not
 * promise — the endpoints ARE the bounds, so Hardness cannot run the knob out
 * of room. Measured H2 at Asymmetry 100: -34.3 dB at every Hardness from 2 to 8.
 *
 * What Hardness changes is the PATH, and there it matters: at Asymmetry 50 the
 * pair runs from 4.0/2.0 at Hardness 2 to 8.0/4.0 at Hardness 8, giving H2 of
 * -37.1 and -47.4 respectively. Same spread RATIO, 10 dB apart — so it is the
 * absolute knee orders, not the ratio between them, that set the even content,
 * and a softer Hardness gives more warmth at the same knob position.
 */
export function splitKnees(hardness, u, leanPositive) {
  const hi = leanPositive ? HARDNESS_MAX : HARDNESS_MIN
  const lo = leanPositive ? HARDNESS_MIN : HARDNESS_MAX
  const lh = Math.log(hardness)
  return {
    nPos: Math.exp(lh + u * (Math.log(hi) - lh)),
    nNeg: Math.exp(lh + u * (Math.log(lo) - lh)),
  }
}

/**
 * The split curve. Both halves are `shape`, so both have unity slope at the
 * origin and an asymptote of 1 — see the note above for why that is the whole
 * point rather than an implementation detail.
 */
export function splitShape(x, nPos, nNeg) {
  return x >= 0 ? shape(x, nPos) : shape(x, nNeg)
}

// ── Topology and the emphasis pair ─────────────────────────────────────────

/**
 * SERIES vs PARALLEL, and why this switch exists at all.
 *
 * ⚠ THE PARALLEL BLEND IS `x + wetDry*wet` — AN ADD, NOT A CROSSFADE. The dry
 * path sits at unity for every position of the Wet/Dry knob, so the dry
 * transient is never attenuated by anything. That is inherited faithfully from
 * `vocal_saturation.py` (`output = audio + wet_dry * wet`) and it is not a bug;
 * it is what parallel saturation IS. But it has a consequence nobody had
 * written down: THE STAGE CANNOT ABSORB A TRANSIENT AT ANY SETTING.
 *
 * Measured on bursts with instant onsets, crest factor against the dry:
 *
 *   wetDry     0     0.3    0.5     1      2      4
 *   d crest  0.00  -0.08  +0.09  +0.07  -0.31  -0.14  dB
 *
 * Flat, across the whole knob and past anything the panel offers. Meanwhile
 * THE SAME CURVE AT THE SAME DRIVE, IN SERIES, TAKES 11.7 dB OFF THE CREST.
 * The nonlinearity is doing enormous peak absorption and the topology throws
 * all of it away. That is the difference between a stage that makes onsets
 * crisper and more prominent and one that absorbs and rounds them, and it is a
 * property of the wiring rather than of the curve.
 *
 * Series is therefore `(1-wetDry)*x + wetDry*wet`, a real crossfade — AND ONE
 * BROADBAND CURVE INSTEAD OF THREE, because the crossfade alone recovered
 * almost nothing. Clipping three bands separately is not clipping their sum: a
 * transient is broadband, so each band saturates mildly and the sum puts the
 * peak back together. Crest against dry, series, asymmetry 0:
 *
 *   three curves (one per band)   +0.25 dB
 *   one curve on the summed bands  -4.80 dB   (at emphasis 0)
 *
 * The per-band Drive knobs survive the change as a tilt applied BEFORE the
 * single curve — see the topology branch in `process`.
 *
 * ⚠ -4.80 dB IS STILL NOT THE CURVE'S 11.69, and the remainder is accounted
 * for: the double RMS match hands back 6.8 dB of it (11.69 -> 4.92 measured on
 * the curve alone), because two 300 ms followers renormalising the wet to the
 * dry's MOVING level is by construction an expander. -11.69 + 6.8 is -4.9,
 * which is what this measures. THAT is the last mechanism still resisting, and
 * it is deliberately untouched: it is the Python's own level matching and the
 * plugin's level-neutrality guarantee rests on it.
 *
 * ⚠ THE KERNEL DEFAULT DOES NOT MOVE — AND THE PANEL DEFAULT SINCE HAS.
 * `parallel` with `emphasis: 0` is bit-identical to the build before this
 * existed, and a test pins that against VOCAL_SAT_KERNEL_DEFAULTS, which is
 * what `processVocalSatBuffer` runs with no arguments. That is the guarantee,
 * and it still holds. What it does NOT cover is the sound the plugin opens
 * with: VOCAL_SAT_DEFAULTS in vocalSatParams.js ships MODE_SERIES, chosen by
 * ear after this work, so a newly opened panel is not the parallel add it used
 * to be. The two are separate on purpose; keep them that way.
 */
export const MODE_SERIES = 'series'
export const MODE_PARALLEL = 'parallel'

/**
 * Emphasis depth at the top of the knob, dB.
 *
 * THE PAIR IS WHAT MAKES A WAVESHAPER ABSORB RATHER THAN EXCITE, and it is the
 * other half of the answer above. A memoryless curve reduces the INSTANTANEOUS
 * peak, but it generates harmonics loudest exactly where the signal is loudest
 * — so it drops a burst of new high frequency onto the onset. Squashed but
 * BRIGHTER, which the ear reads as edge, not softness. To absorb a transient
 * the nonlinearity has to bite high frequencies harder than low ones.
 *
 * A shelf boosted into the curve and cut after it does exactly that: HF reaches
 * the knee first, is compressed most, and the de-emphasis restores the level
 * with the edge already rounded. Measured on the same bursts, level-matched,
 * energy above 4 kHz against the dry:
 *
 * Measured IN THIS PLUGIN, series, one broadband curve, asymmetry 0, level
 * matched, energy above 4 kHz against the dry:
 *
 *   emphasis      0      25      50      75     100
 *   onset HF   -2.89   -3.29   -3.66   -4.49   -5.19  dB
 *   body HF   +12.70  +12.06  +11.59  +11.23  +10.90  dB
 *   d crest    -4.80   -3.90   -2.60   -1.35   -0.27  dB
 *
 * The onset's top end comes down while the body keeps essentially all of its
 * added harmonics — thick and soft rather than thick and sharp, which is the
 * whole point. It reaches -6.37 dB at drive 8.
 *
 * ⚠ IT TRADES CREST ABSORPTION FOR HF ABSORPTION AND THE TRADE IS INTRINSIC,
 * not a tuning miss: -4.80 dB of crest at emphasis 0 becomes -0.27 at 100. The
 * two goals are opposites. Saturation SQUARES the waveform, and a square wave
 * has a crest factor of 0 dB; the de-emphasis then low-passes that flat top
 * back toward a rounded shape, and a sine's crest is 3 dB. Rounding the edges
 * off is exactly what raises peak-to-RMS again. You cannot both square a wave
 * and round it.
 *
 * So these are two different characters rather than one axis: emphasis up for
 * SOFT (edges rounded, harshness gone), emphasis at 0 for SQUASHED (peaks
 * absorbed, sound harder). "Softer and mushier" is the first one.
 *
 * ⚠ AT DEPTH IT READS AS CHORUSING, AND THAT IS THIS MECHANISM WORKING RATHER
 * THAN A TIMING FAULT. Pre-emphasis boosts HF into the curve, the curve
 * compresses HF harder when the signal is loud, and the de-emphasis restores
 * the STATIC tilt but not the dynamic part — so the net shelf around
 * EMPHASIS_CORNER_HZ has a depth that moves with level, syllable to syllable. A
 * shelf whose depth breathes is what the ear reads as phasing.
 *
 * Coherence against the input (1.000 = linear and time-INVARIANT; any fixed EQ,
 * however wild, still scores 1.000, so this measures only the moving part):
 *
 *   emphasis        0       25       50      100
 *   mean       0.9997   0.9985   0.9902   0.9643
 *   min        0.9979   0.9877   0.9218   0.5336
 *
 * ⚠ IT IS NOT A SERIES/PARALLEL PROPERTY, though it is heard in series first.
 * Parallel scores 0.9949 and 0.9995 with emphasis at 50 and 0, so the artefact
 * is present there too — series simply carries more of it, because parallel
 * ADDS the wet under a unity dry (at wetDry 0.65 the dry is 60% of the sum)
 * while series CROSSFADES (the wet is 65%). It tracks the wet share in both:
 * parallel 0.9977 / 0.9949 / 0.9919 / 0.9861 at wetDry 0.35 / 0.65 / 1 / 2.
 *
 * ⚠ AND IT IS NOT A DELAY MISMATCH, which was checked before concluding any of
 * the above. In a linearised patch the wet path and the dry path each peak-
 * cross-correlate at lag 62, exactly the reported latency, in both modes; and
 * the residual against a plain scaled copy is captured by a STATIC 65-tap
 * filter (-21.6 dBc to -65.0), i.e. it is ordinary frequency response and not a
 * moving comb. Back Emphasis off to trade the modulation for onset softening:
 * 25 keeps most of the absorption (-3.29 dB against 50's -3.66) at a quarter of
 * the coherence cost.
 *
 * ⚠ AND IT IS WEAKER HERE THAN AROUND A BARE SINGLE CURVE, which is worth
 * knowing before anyone re-tunes EMPHASIS_MAX_DB chasing the difference. A
 * standalone curve with the same pair reaches -9.34 dB at the onset. In the
 * plugin the HF does not saturate on its own — it rides on the low-frequency
 * content into one shared curve — and the RMS match takes some back.
 *
 * ⚠ IT IS MUCH WEAKER IN PARALLEL AND THAT IS STRUCTURAL, not a bug to chase.
 * The pair can only shape what the curve sees, and in parallel the dry path
 * still delivers the transient at unity underneath whatever the wet path does.
 * Available in both modes because it is a wet-path pair either way and the
 * spectrum of the added harmonics is worth controlling on its own; just do not
 * expect it to round an onset that the dry path is holding up.
 *
 * 12 dB because that is what the measurement above used. Deeper keeps working
 * in the same direction but the de-emphasis starts to audibly dull the body,
 * which is the thing the pair is supposed to leave alone.
 */
export const EMPHASIS_MAX_DB = 12

/**
 * Corner of the emphasis shelf, Hz.
 *
 * Low enough to cover the consonant and attack region a voice puts its edge in,
 * high enough to leave the fundamental and the first formant out of it — the
 * pair must not turn into a bass control, because whatever it boosts into the
 * curve is what the curve distorts most.
 */
export const EMPHASIS_CORNER_HZ = 1800

/** Below this the pair is skipped outright rather than run flat. */
export const EMPHASIS_EPSILON = 1e-4

/**
 * SOFTEN — the slew limiter, and the reference it had to be given.
 *
 * ⚠ SERIES ONLY, AND THAT IS NOT A UI PREFERENCE. tapeCharacter's finding (2)
 * is that this needs four things at once: a CLEAN, BROADBAND signal, at the
 * OVERSAMPLED rate, just ahead of ONE nonlinearity, with its allowance
 * referenced near the level that nonlinearity acts at. In parallel this plugin
 * supplies NONE of them — there is no broadband oversampled point until after
 * the three curves — and that placement was measured there at +0.66 and
 * +1.38 dB of tilt, HF RISING, on a control that provably cannot boost. Slew
 * limiting an already-saturated, LF-dominated sum makes it triangular, and a
 * triangle is harmonics. THE KERNEL IGNORES THE KNOB IN PARALLEL rather than
 * trusting the panel to hide it; a stale param message must not be able to
 * reach the one placement the module says is actively harmful.
 *
 * The single broadband curve in series is the first place in this codebase that
 * supplies all four, which is what made wiring this possible at all.
 *
 * ── THE REFERENCE, WHICH IS THE WHOLE OF THE DIFFICULTY ────────────────────
 *
 * SOFTEN_REFERENCE is 1: the curve's knee, in post-drive units, the same
 * quantity ASYM_REFERENCE names. "The level the nonlinearity acts at" is the
 * knee, and the knee is at |x| ~ 1 for every hardness by construction.
 *
 * ⚠ THE OBVIOUS CHOICE WAS TRIED FIRST AND MADE THREE QUARTERS OF THE KNOB
 * INERT. Referencing to the largest amplitude a full-scale input can present,
 * `drive * max(mult)`, is the choice that preserves Bernstein's guarantee — a
 * signal bandlimited to the base Nyquist and bounded by A cannot move more than
 * (pi/L)*A per oversampled sample, so at scale 1 the limit provably cannot
 * bind. It measured:
 *
 *   soften     0      10      25      50      75      90     100
 *   d tilt  -2.588  -2.588  -2.588  -2.588  -2.600  -3.480  -4.963  dB
 *
 * Nothing at all until 75. The reference was about twelve times the level the
 * curve actually works at, so the allowance was twelve times too generous and
 * the entire useful range fell off the bottom of the knob. Against the knee:
 *
 *   soften     0      10      25      50      75      90     100
 *   d tilt  -2.588  -2.600  -3.474  -8.037 -14.764 -18.188 -20.138  dB
 *
 * Monotonic across the whole travel, negative at every setting — softening, not
 * the distortion generation the module warns the wrong placement produces.
 *
 * ⚠ THIS FORFEITS "CANNOT BIND AT SCALE 1", and that is deliberate and
 * pre-authorised: the module already records that "to do anything at all it
 * must bind below the threshold". Bit-identity at soften 0 does NOT rest on
 * Bernstein here — it rests on `softenActive` skipping the branch outright, so
 * the limiter's state never even advances on a patch that does not use it.
 *
 * ⚠ IT IS MOTIONLESS, WHICH IS THE OTHER HALF OF THE REQUIREMENT. tapeCharacter
 * records that anything whose depth scales with a TRACKED level cannot be
 * compared between a live preview and an offline region render, because the
 * tracker starts cold offline — that defect shipped once, with preview coming
 * out 1.5-2.3 dB more softened than the applied audio. A constant 1 cannot do
 * that. It does mean the knob's effect grows with Drive, which is correct
 * rather than incidental: more drive is faster edges.
 *
 * ⚠ SOFTEN_MIN_SCALE IS REUSED UNCHANGED, and the module's warning that a
 * reuser "must re-derive this or the knob will mean something else" is
 * satisfied by the table above rather than ignored. Against the knee the
 * shipped constant lands where its own doc says it should — "half the knob is
 * already down at 0.14 of the reference" — so re-deriving it would have moved a
 * shared constant to arrive back where it started.
 *
 * ⚠ ONE OF THE MODULE'S CLAIMS DOES NOT SURVIVE THE MOVE. "Output peak does not
 * move at any setting" was measured in the soft clipper; here the peak drifts
 * 0.6 dB across the knob (-11.13 to -10.51 dBFS), because this plugin
 * renormalises against moving RMS followers downstream of the limiter and the
 * soft clipper did not. Small, but it is not zero and should not be repeated as
 * though it were.
 */
export const SOFTEN_REFERENCE = 1

// ── Tame: lookahead peak control paid for out of latency we already spend ──

/**
 * TAME — the piece that makes the cubic worth having, at zero added latency.
 *
 * THE PROBLEM IT SOLVES. `cubicShape` generates exactly the third harmonic and
 * essentially no aliasing, but only while the signal stays inside |x| <= 1.5.
 * Past that it is a hard clipper and measures GRITTIER than the rational curve
 * it was meant to improve on. Nothing else in this plugin keeps it in domain.
 *
 * ⚠ AND IT CANNOT BE DONE WITH A PLAIN ENVELOPE FOLLOWER, WHICH IS CAUSALITY
 * RATHER THAN AN IMPLEMENTATION LIMIT. A causal follower cannot reduce the gain
 * before the peak arrives. Measured on bursts, cubic at drive 8, share of
 * samples the clamp caught:
 *
 *   no gain control                 0.26%
 *   zero-latency env, attack 5 ms   0.26%   the envelope never catches up
 *   zero-latency env, attack 1 ms   0.26%   still nothing
 *   zero-latency env, attack 0.3 ms 0.10%
 *   zero-latency env, attack 0.1 ms 0.07%   but high-order content ROSE
 *
 * The usable window is about 0.3-1 ms wide and barely moves the number, and
 * below it the gain changes appreciably WITHIN a cycle — which is waveshaping,
 * so you trade one distortion for another. At 0.1 ms the high-order content
 * came out worse than with no limiter at all.
 *
 * ── WHERE THE LOOKAHEAD COMES FROM, WHICH IS THE WHOLE TRICK ───────────────
 *
 * The 2x oversampler's upsampling FIR is linear phase and already delays the
 * signal by `upsampleDelaySamples` = 31 base samples before it reaches the
 * curve. A detector reading the signal BEFORE the upsampler therefore sees the
 * curve-side audio 31 samples early. That is lookahead we have already paid
 * for and were not spending.
 *
 * `LookaheadLimiter` needs 2L of delay to align its envelope, so the free
 * budget supports L = 15: a +/-15 sample (0.34 ms) window, with 2L = 30 against
 * the 31 available. THE GAIN IS THEREFORE APPLIED ONE SAMPLE EARLY, which is
 * the safe direction for a limiter — early is conservative, late is an
 * overshoot.
 *
 *   lookahead                     added latency   out of domain
 *   0.34 ms (this, free)              0 samples       0.00%
 *   1 ms                             88 samples       0.00%
 *   2 ms                            176 samples       0.00%
 *
 * ⚠ FREE LOOKAHEAD BUYS THE GUARANTEE, NOT THE SMOOTHNESS. A short window means
 * a fast gain envelope, and fast gain movement has its own modulation cost. On
 * a proxy for high-order content: 6.08% with no limiter, 5.78% here, 4.35% at
 * 1 ms, 3.36% at 2 ms. (That proxy is contaminated by programme content, so it
 * understates the spread; the out-of-domain column is the solid one.) If the
 * gain movement is ever audible, TAME_LOOKAHEAD_L is the one constant to raise
 * — and raising it stops being free.
 *
 * ⚠ SERIES ONLY, for the same reason Soften is: parallel has no single
 * broadband driven signal to detect on or apply a gain to. The kernel enforces
 * it rather than trusting the panel.
 *
 * ⚠ THE DETECTOR IS EXACT HERE, unlike Soften's reference. Soften had to bound
 * `drive * max(mult)` because it acts on the oversampled sum; this detector
 * runs on `low*lowDrive + mid*midDrive + high*highDrive` at the BASE rate,
 * which is the pre-curve signal itself rather than a bound on it.
 */
export const TAME_LOOKAHEAD_L = Math.floor(VOCAL_SAT_OVERSAMPLE.upsampleDelaySamples / 2)

/** Alignment: gains are stored for base time `i - TAME_ALIGN`. */
const TAME_ALIGN = 2 * TAME_LOOKAHEAD_L

/** Delay, in base samples, between the detector tap and the curve. */
const TAME_UP_DELAY = VOCAL_SAT_OVERSAMPLE.upsampleDelaySamples

/**
 * Ring of base-rate gains. Must exceed TAME_UP_DELAY + TAME_ALIGN so a block
 * can still read gains written during the previous one. Power of two so the
 * index can be masked — and JS bitwise AND wraps negatives correctly, which is
 * what lets the first blocks read "before the beginning" and find the 1s the
 * ring is primed with.
 */
const TAME_RING = 128
const TAME_MASK = TAME_RING - 1

/** Below this the whole thing is skipped and the ring is never touched. */
export const TAME_EPSILON = 1e-4

/**
 * Knob to threshold, as a multiple of the curve's own edge.
 *
 *   threshold = edge * 4^(1 - 2a)     4x edge at 0, exactly edge at 50, edge/4 at 100
 *
 * ⚠ THE FIRST MAPPING PUT THE WHOLE USEFUL RANGE IN THE TOP QUARTER, which is
 * the same failure Soften's first reference had and is worth recording twice
 * because it is easy to reach for. Running 8x edge down to 1x edge measured:
 *
 *   tame      0      25      50      75     100
 *   grit    6.59%  6.59%   6.59%   6.72%   6.70%
 *
 * — nothing at all below 75, because at any ordinary Drive the signal's peak
 * sits under a threshold of 2.8x the edge and the limiter never engages.
 *
 * Anchoring 50 AT the edge fixes it: the bottom half brings the threshold down
 * to where the curve's domain ends, and the top half goes below it, which is
 * what buys headroom against the intersample peaks the base-rate detector
 * cannot see. Geometric so the ratio, not the difference, is what the knob
 * moves — the quantity that matters is how far into the curve the signal gets.
 */
function tameThreshold(amount, edge) {
  const a = clamp(amount, 0, 100) / 100
  return edge * Math.pow(4, 1 - 2 * a)
}

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

/**
 * AUTO-DRIVE — makes Drive mean the same thing on a quiet file as a loud one.
 *
 * Saturation is not level-invariant: a selection 10 dB quieter is driven 10 dB
 * less at the same Drive setting, which is already in this plugin's help as a
 * caveat users have to work around by hand. This normalises the tracked
 * programme level toward a fixed reference before the drive is applied, so the
 * knob's meaning stops depending on how hot the recording is.
 *
 * It also completes what Tame started from the other end. Tame pins the
 * operating point for PEAKS, so loud material cannot leave the curve's domain;
 * it does nothing for quiet material, which simply gets less saturation. This
 * raises quiet passages INTO the curve. The two together hold the whole file at
 * a consistent operating point.
 *
 * ── TWO RECORDED FAILURES THIS IS BUILT AROUND ─────────────────────────────
 *
 * (1) BREATHING. tapeCharacter's HF Loss note: "Following the envelope gives
 *     full depth on a loud syllable and none through the pause after it — a
 *     room that BREATHES, which a listener hears as pumping long before they
 *     hear the colour." An ungated normaliser is worse than that shelf ever
 *     was, because a pause is where the tracked level is LOWEST and so the gain
 *     is HIGHEST — it would drive room tone hardest of all.
 *
 *     THE TRACKER IS THEREFORE GATED ON VOICE and holds its last value through
 *     a pause, reusing the VoicedGate the skew tracker already needs. A pause
 *     changes nothing at all.
 *
 * (2) PREVIEW AND OFFLINE DISAGREEING. Same module: "anything whose depth
 *     scales with a TRACKED level cannot be compared between a live preview and
 *     an offline region render: the tracker starts cold offline. That defect
 *     shipped once — preview came out 1.5-2.3 dB more softened than the applied
 *     audio. Reference colour to something MOTIONLESS, or accept that the two
 *     will never agree."
 *
 *     THE TARGET HERE IS MOTIONLESS — a fixed reference level, not a second
 *     tracker — so only the MEASUREMENT moves, and it converges to the same
 *     value from either start. What remains is the opening of a region, which
 *     is exactly what RmsFollower's warmup priming exists for and what the
 *     plugin's three existing level-matching followers already rely on. This is
 *     the fourth tracked gain in this kernel, not the first.
 *
 * ⚠ IT IS STILL A TRACKED GAIN, AND THAT IS A REAL COST. A region short
 * relative to AUTO_TAU_MS is normalised against a level the follower never
 * fully settled on. The priming bounds it; it does not remove it.
 */
const AUTO_TAU_MS = 1500

/**
 * The level the tracker is normalised toward, linear RMS.
 *
 * 0.1 is -20 dBFS, which is both a typical narration working level and ACX's
 * own RMS target, so a compliant file arrives already at the reference and is
 * left alone. MOTIONLESS BY CONSTRUCTION — see failure (2) above.
 */
const AUTO_REFERENCE_RMS = 0.1

/** Hard bound on the correction, dB. A near-silent passage must not run away. */
const AUTO_MAX_DB = 12

/** Below this the whole thing is skipped. */
export const AUTO_EPSILON = 1e-4

/**
 * Tracks programme level and reports the drive correction.
 *
 * The knob is an exponent rather than a blend: `pow(ref/level, amount/100)`
 * gives 1 at 0, full normalisation at 100, and a partial correction in between
 * that is still exact in dB terms — half the knob is half the correction.
 */
class AutoDrive {
  constructor(sampleRate) {
    this.level = new RmsFollower(sampleRate, AUTO_TAU_MS, 1e-6)
    this.gate = new VoicedGate(sampleRate)
    this.tracked = AUTO_REFERENCE_RMS
  }

  /** One base-rate sample of the signal the drive will act on. */
  update(x) {
    // GATED: a pause holds the last voiced level rather than dragging the
    // tracker down and the gain up. See failure (1).
    if (this.gate.update(x)) this.tracked = this.level.process(x)
  }

  /** Correction to multiply the per-band drives by. */
  gain(amount) {
    const raw = Math.pow(AUTO_REFERENCE_RMS / this.tracked, clamp(amount, 0, 100) / 100)
    const max = dbToLin(AUTO_MAX_DB)
    return clamp(raw, 1 / max, max)
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
    // The emphasis pair. One section each; the de-emphasis is the exact
    // inverse shelf, so with a LINEAR path between them the two cancel and the
    // wet path is unchanged. Everything the pair does, it does by changing what
    // the curve sees — which is the whole mechanism.
    this.preEmph = new BiquadCascade(1, 1)
    this.deEmph = new BiquadCascade(1, 1)
    this.soften = new SoftenLimiter(VOCAL_SAT_OVERSAMPLE.factor)

    // Tame. The limiter is used as a GAIN GENERATOR only — its own delayed
    // output is discarded, because the delay this design runs on is the
    // oversampler's, not the limiter's. See TAME_LOOKAHEAD_L.
    this.tame = new LookaheadLimiter(TAME_LOOKAHEAD_L)
    this.tameGain = new Float32Array(TAME_RING).fill(1)
    this.tameBase = 0

    this.autoDrive = new AutoDrive(sampleRate)
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
    this.curveFn = p.curve === CURVE_CUBIC ? cubicShape : shape
    // Read as 0-100 and ABSENT below the epsilon, so a patch at 0 runs no DC
    // blocker and takes no branch — the same rule HF Loss follows, and the
    // thing that keeps `asymmetry: 0` bit-identical to a build without any of
    // this. `asymmetryOffset` applies the same epsilon to the offset itself.
    this.asymmetry = clamp(p.asymmetry, 0, 100)
    this.asymActive = this.asymmetry / 100 > ASYM_EPSILON
    // ⚠ SPLIT FALLS BACK TO OFFSET ON THE CUBIC, which has no knee order to
    // split — see ASYM_MODE_SPLIT. Resolved here rather than in the loop so the
    // panel and the kernel cannot disagree about what is running.
    this.splitActive = this.asymActive
      && p.asymMode === ASYM_MODE_SPLIT
      && this.curveFn !== cubicShape
    this.splitAmount = this.asymmetry / 100
    this.series = p.mode === MODE_SERIES
    // Read as 0-100 and ABSENT below the epsilon — the same rule HF Loss and
    // asymmetry follow, and what keeps the shipped patch bit-identical.
    this.emphasis = clamp(p.emphasis ?? 0, 0, 100)
    this.emphasisDb = (this.emphasis / 100) * EMPHASIS_MAX_DB
    this.emphasisActive = this.emphasisDb > EMPHASIS_EPSILON
    if (this.emphasisActive) {
      this.preSections = [highShelf(this.sampleRate, EMPHASIS_CORNER_HZ, Math.SQRT1_2, this.emphasisDb)]
      this.deSections = [highShelf(this.sampleRate, EMPHASIS_CORNER_HZ, Math.SQRT1_2, -this.emphasisDb)]
      for (const c of this.channels) {
        c.preEmph.setSections(this.preSections)
        c.deEmph.setSections(this.deSections)
      }
    }

    this.wetDry = Math.max(0, p.wetDry)
    this.lowDrive = p.drive * p.lowDriveMult
    this.midDrive = p.drive * p.midDriveMult
    this.highDrive = p.drive * p.highDriveMult

    // SOFTEN — series only, absent at 0, and referenced to a motionless bound.
    // See SOFTEN_REFERENCE_NOTE. `softenScale` returns exactly 1 below its own
    // epsilon, but the branch is skipped outright as well so the limiter's
    // state never advances on a patch that does not use it.
    // TAME — series only, absent at 0. The threshold is the CURVE'S OWN edge:
    // 1.5 for the cubic, where its domain actually ends, and 1 for the rational
    // curve, which has no hard domain but whose knee is the level it acts at.
    // Same quantity ASYM_REFERENCE and SOFTEN_REFERENCE name.
    this.autoAmount = clamp(p.autoDrive ?? 0, 0, 100)
    this.autoActive = this.autoAmount / 100 > AUTO_EPSILON

    this.tameAmount = clamp(p.tame ?? 0, 0, 100)
    this.tameActive = this.series && this.tameAmount / 100 > TAME_EPSILON
    this.tameThresholdValue = tameThreshold(
      this.tameAmount, this.curveFn === cubicShape ? CUBIC_LIMIT : 1,
    )

    this.softenAmount = clamp(p.soften ?? 0, 0, 100)
    this.softenActive = this.series && this.softenAmount / 100 > SOFTEN_EPSILON
    this.softenScaleValue = softenScale(this.softenAmount)
    this.softenReference = SOFTEN_REFERENCE
  }

  _ensureChannels(n) {
    while (this.channels.length < n) {
      const c = new ChannelState(this.sampleRate)
      c.lp.setSections(this.lpSections)
      c.hp.setSections(this.hpSections)
      if (this.emphasisActive) {
        c.preEmph.setSections(this.preSections)
        c.deEmph.setSections(this.deSections)
      }
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

    const {
      hardness, asymActive, wetDry, lowDrive, midDrive, highDrive,
      series, emphasisActive, softenActive, tameActive, autoActive, curveFn,
      splitActive,
    } = this
    const L = VOCAL_SAT_OVERSAMPLE.factor

    const {
      low: lowBuf, high: highBuf, mid: midBuf, wet: wetBuf, emph: emphBuf,
    } = this._scratch(n)

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
      // PRE-EMPHASIS GOES HERE, ahead of the split, so it wraps all three
      // curves rather than one. The dry path is NOT emphasised — it is the raw
      // input via dryLine — so the pair lives entirely on the wet side and its
      // only effect is on what the curves see.
      let wetIn = input
      if (emphasisActive) {
        st.preEmph.process(input, emphBuf, n, 0)
        wetIn = emphBuf
      }

      st.lp.process(wetIn, lowBuf, n, 0)
      st.hp.process(wetIn, highBuf, n, 0)
      for (let i = 0; i < n; i++) midBuf[i] = wetIn[i] - lowBuf[i] - highBuf[i]

      // ── Which way the offset should lean ─────────────────────────────────
      // Fed the BROADBAND input, which is exactly what the three curves see
      // between them: the split is complementary, so the bands sum back to this
      // signal. Feeding one band instead would measure that filter's skew, and
      // tapeCharacter is explicit that a shelf changes a waveform's lean.
      //
      // Updated BEFORE the offset is read, so a block uses its own direction
      // rather than the previous one. The ramp is 200 ms; either would do.
      // ⚠ FED `wetIn`, NOT `input`, and tapeCharacter is explicit about why:
      // "FEED IT THE SIGNAL THE CURVE ACTUALLY SEES, post any emphasis or
      // shelving, because a shelf changes a waveform's skew." Emphasis is a
      // shelf on exactly that path, so reading the raw input here would choose
      // the offset's sign from a waveform the curve never sees.
      if (asymActive) {
        for (let i = 0; i < n; i++) {
          if (st.gate.update(wetIn[i])) st.skew.update(wetIn[i])
        }
      }
      // ⚠ THE TWO MECHANISMS ARE EXCLUSIVE. Split produces its asymmetry in the
      // curve's shape, so it takes NO offset — running both would put the
      // offset's bound imbalance straight back, which is the thing split exists
      // to avoid.
      const offset = asymActive && !splitActive
        ? asymmetryOffset(this.asymmetry, st.skew.direction, ASYM_REFERENCE)
        : 0
      // Constant for the block — see applyTransfer on why this is hoisted.
      const shapedOffset = curveFn(offset, hardness)

      // WHICH POLARITY GETS THE HARDER KNEE is the same question the offset's
      // sign answers, so it comes from the same tracker. The direction is
      // already smoothed over 200 ms and passes through 0, where the exponent
      // is 0 and the pair collapses to symmetric — so a sign change is a glide
      // through "no asymmetry" rather than a swap, and cannot click.
      let nPos = hardness
      let nNeg = hardness
      if (splitActive) {
        const t = this.splitAmount * st.skew.direction
        const knees = splitKnees(hardness, Math.abs(t), t >= 0)
        nPos = knees.nPos
        nNeg = knees.nNeg
      }

      // ── AUTO-DRIVE ───────────────────────────────────────────────────────
      // Fed the RAW input, NOT `wetIn`. Emphasis is a shelf and would change
      // the measured RMS, which would couple two unrelated knobs: raising
      // Emphasis would quietly pull the drive down. This control is about how
      // loud the RECORDING is, which is a property of the file rather than of
      // the patch, so it reads the file.
      //
      // Resolved once per block. The time constant is 1.5 s; per-block
      // granularity is three orders of magnitude finer than that.
      if (autoActive) {
        for (let i = 0; i < n; i++) st.autoDrive.update(input[i])
      }
      const autoGain = autoActive ? st.autoDrive.gain(this.autoAmount) : 1
      const lowD = lowDrive * autoGain
      const midD = midDrive * autoGain
      const highD = highDrive * autoGain

      // Up to the high rate one band at a time. Upsampling is linear, so the
      // three still sum back to the input there — the complementary split is
      // preserved, and each band meets its own transfer curve with room above
      // it for the harmonics that curve creates.
      const lowUp = st.upLow.up(lowBuf, n)
      const midUp = st.upMid.up(midBuf, n)
      const highUp = st.upHigh.up(highBuf, n)

      // ── ONE CURVE IN SERIES, THREE IN PARALLEL ───────────────────────────
      //
      // ⚠ CLIPPING THREE BANDS SEPARATELY IS NOT CLIPPING THEIR SUM, and that
      // is why series needs its own topology here rather than just a different
      // blend. A transient is BROADBAND: split three ways, each band sees only
      // part of it, saturates mildly, and the sum puts the peak back together.
      // Measured in series, crest against dry: three bands +0.25 dB against one
      // band -3.55 dB. The split was cancelling most of what the crossfade had
      // just bought.
      //
      // THE PER-BAND DRIVE KNOBS STILL DO SOMETHING, which is the reason this
      // sums the DRIVEN bands rather than ignoring the split. `low*lowDrive +
      // mid*midDrive + high*highDrive` is a tilt applied before a single
      // nonlinearity, so Low/Mid/High Drive go on shaping what the curve sees
      // instead of going dead the moment the mode changes. The split is still
      // complementary, so at equal mults this is exactly `mult * wetIn`.
      //
      // ⚠ THE OFFSET IS APPLIED ONCE HERE AND THREE TIMES IN PARALLEL, so the
      // same Asymmetry setting is a WEAKER effect in series. That is the honest
      // arrangement rather than a scaling bug to correct: one stage has one
      // operating point. Do not "fix" it by tripling the offset — that would be
      // a different, harder-clipped curve, not the same one applied evenly.
      const sum = st.downWet.scratch(n)
      if (series) {
        // TAME's DETECTOR PASS, at the BASE rate and BEFORE the upsampler —
        // which is the entire point. This signal is the pre-curve sum exactly,
        // and reading it here means the gain has seen TAME_UP_DELAY samples of
        // the future by the time the audio it modulates reaches the curve.
        // The limiter's returned sample is discarded; only its gain is wanted.
        if (tameActive) {
          const threshold = this.tameThresholdValue
          for (let i = 0; i < n; i++) {
            const d = lowBuf[i] * lowD + midBuf[i] * midD + highBuf[i] * highD
            st.tame.processSample(d, threshold)
            // Valid for base time (base + i - TAME_ALIGN); negative indices
            // wrap correctly under the mask and find the primed 1s.
            st.tameGain[(st.tameBase + i - TAME_ALIGN) & TAME_MASK] = st.tame.gain
          }
        }

        // SOFTEN sits HERE and nowhere else: on the summed, driven, broadband
        // signal, at the oversampled rate, with exactly one nonlinearity in
        // front of it. Those are tapeCharacter's four conditions, and this is
        // the only point in this plugin that satisfies them.
        const softenScaleValue = this.softenScaleValue
        const softenReference = this.softenReference
        const base = st.tameBase
        for (let j = 0; j < n * L; j++) {
          let pre = lowUp[j] * lowD + midUp[j] * midD + highUp[j] * highD
          // Zero-order hold across the two oversampled samples of a base
          // period. The gain is already triangular-smoothed at base rate, so
          // the residual stair is far below the envelope's own movement.
          if (tameActive) pre *= st.tameGain[(base + (j / L | 0) - TAME_UP_DELAY) & TAME_MASK]
          if (softenActive) pre = st.soften.process(pre, softenScaleValue, softenReference)
          sum[j] = splitActive
            ? splitShape(pre, nPos, nNeg)
            : applyTransfer(curveFn, pre, hardness, offset, shapedOffset)
        }
        st.tameBase += n
      } else {
        for (let j = 0; j < n * L; j++) {
          sum[j] = splitActive
            ? splitShape(lowUp[j] * lowD, nPos, nNeg)
              + splitShape(midUp[j] * midD, nPos, nNeg)
              + splitShape(highUp[j] * highD, nPos, nNeg)
            : applyTransfer(curveFn, lowUp[j] * lowD, hardness, offset, shapedOffset)
              + applyTransfer(curveFn, midUp[j] * midD, hardness, offset, shapedOffset)
              + applyTransfer(curveFn, highUp[j] * highD, hardness, offset, shapedOffset)
        }
      }

      st.downWet.down(wetBuf, n)

      // DE-EMPHASIS, and it must sit HERE: after the curve, and BEFORE the DC
      // blocker. tapeCharacter's blocker note is explicit — "Place it AFTER the
      // curve (and after any de-emphasis), so it blocks the DC that reaches the
      // output rather than one a later filter would reshape."
      if (emphasisActive) st.deEmph.process(wetBuf, wetBuf, n, 0)

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
        // PARALLEL: `output = audio + wet_dry * wet`, the Python's add, where
        // the dry sits at unity and the transient is never touched.
        // SERIES: a real crossfade, which is what lets the curve's 11.7 dB of
        // crest reduction actually reach the output. See MODE_SERIES.
        //
        // dryGain is clamped rather than written `1 - wetDry` because wetDry is
        // only clamped below: a patch above 1 would otherwise invert the dry
        // path's polarity and subtract it from the wet.
        const dryGain = series ? (wetDry >= 1 ? 0 : 1 - wetDry) : 1
        const blended = dryGain * x + wetDry * wetMatched
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
      this._emphBuf = new Float64Array(n)
    }
    return {
      low: this._lowBuf, high: this._highBuf, mid: this._midBuf,
      wet: this._wetBuf, emph: this._emphBuf,
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
