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
/**
 * ⚠ THE MAKEUP REFERENCE AND ITS CEILING ARE SHARED WITH OPTOSMOOTH, and
 * deliberately so: they are one mechanism, and two copies of a guarantee is two
 * guarantees. See `dsp/makeupReference.js`.
 */
import {
  MAKEUP_PERCENTILE, CEILING_KNEE_DB, ceilingKneeDbFor,
  softCeiling, float32AtOrBelow, percentileOfChannels, peakOfChannels,
} from './dsp/makeupReference.js'

export { OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES }
export { MAKEUP_PERCENTILE, CEILING_KNEE_DB, ceilingKneeDbFor }

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

// Input knob 0-100 -> drive into the fixed threshold, spanning 48 dB
// (-24 dB at knob 0, +24 dB at knob 100). IN_TAPER < 1 models the hardware's
// stepped audio-taper attenuator: level rises quickly off zero and flattens
// toward the top.
const IN_DRIVE_MIN_DB = -24
const IN_DRIVE_SPAN_DB = 48
const IN_TAPER = 0.8

/**
 * The Input knob's drive law, exported so nothing has to keep a second copy.
 *
 * ⚠ `scripts/fet-null.mjs` DID KEEP ONE, AND IT SILENTLY WENT STALE. Its
 * compensated reference undid the taper by re-declaring `IN_DRIVE_MIN_DB`,
 * `IN_DRIVE_SPAN_DB` and `IN_TAPER` locally; when the span went 40 -> 48 the
 * copy did not, so the fixture was undoing 40 dB of gain against a kernel
 * applying 48 and its "compensated" reference had a 5.3 dB real gain in it.
 * Two of its verdicts changed as a result. Same failure mode as the Scheps
 * defaults: a constant duplicated instead of imported.
 */
export function inputDriveDbForKnob(knob) {
  const k = clamp(knob, 0, 100) / 100
  return IN_DRIVE_MIN_DB + IN_DRIVE_SPAN_DB * Math.pow(k, IN_TAPER)
}

/**
 * Extra drive above the knee, so the top of the knob reaches the reference.
 *
 * ⚠ THE PLAIN FIX — RAISING `IN_DRIVE_SPAN_DB` — MOVES EVERY KNOB POSITION, and
 * that is not a cosmetic objection. `inputDrive` is a value presets SAVE, so a
 * wider span silently re-voices all five factory presets and every patch a user
 * has stored: at span 47 the knob's midpoint runs 3.4 dB hotter than the number
 * beside it used to mean. The Scheps inheritance bug, which shipped 4x the
 * intended gain reduction because a change landed on shared defaults, is the
 * precedent.
 *
 * So the extra travel is added ON TOP of the existing law, weighted by a
 * smoothstep that is zero at the knee with zero slope there. Below knob 80 the
 * drive is bit-identical to before — which covers every factory preset, the
 * hottest of which is 75 — and the curve has no kink at the join. At knob 100 it
 * reaches +24 dB, which puts a -12 dBFS source at 22.5 dB of reduction against
 * the 16.3 it managed before. FETish sat at 21.86 dB in the capture our own knob
 * could not follow, so the top of the travel now clears the reference rather
 * than landing just under it — 7 dB of extra drive stopped 0.13 dB short, which
 * is inside the scatter on the source level and not a margin worth shipping.
 *
 * ⚠ A USER PATCH SAVED ABOVE KNOB 80 WILL GET HOTTER. That is a real break and
 * there is no way to both extend the top and leave the top unchanged; the knee
 * is placed to make the affected band as small as it can be.
 */
/**
 * ⚠ THE SPAN WAS 40 AND EVERY KNOB POSITION HAS MOVED. This re-voices all five
 * factory presets and every stored user patch, deliberately and with the owner's
 * agreement, because the alternative was worse. The first attempt kept the old
 * law below knob 80 and added the extra travel above it through a smoothstep, so
 * nothing already saved would change — but that buys preset compatibility with a
 * knob whose RATE OF CHANGE is no longer monotonic: slope runs 0.335 dB per unit
 * below the knee, bulges past 0.7 around knob 90, and falls back to 0.384 at the
 * top. A hardware attenuator does not do that, and it is the sort of thing that
 * is felt rather than seen.
 *
 * One power law across the whole travel has a slope that only ever falls
 * (0.609 dB per unit at knob 10 down to 0.384 at 100), which is what `IN_TAPER`
 * below 1 is modelling in the first place. Presets are re-cut against it.
 */
export const IN_DRIVE_SPAN_DB_LEGACY = 40

// ── Ballistics ──────────────────────────────────────────────────────────────

// Dial 1 (slowest) and dial 7 (fastest) endpoints; positions in between are
// interpolated geometrically, as the hardware's switched resistor ladder does.
const ATTACK_SLOWEST_S = 0.0008
const ATTACK_FASTEST_S = 0.00002

/**
 * The attack range measured from FETish, selectable for A/B but NOT shipping.
 *
 * ⚠ THE TWO ARE A PAIR AND THERE IS NO MIDDLE. `attackRange` picks a whole
 * ladder, the same reasoning as `FET_LEGACY_PATCH`: "the FETish attack" is one
 * decision, and an endpoint moved without its partner is a configuration nobody
 * measured. The ladder shape is shared — five of six FETish settings gave
 * `t63 / declared` constant to 3 %, so its taper is the geometric one
 * `dialToSeconds` already interpolates, and only the endpoints differ.
 *
 * ⚠⚠ SOLVED BY SIMULATE-AND-MATCH, AND DIVIDING THE MEASURED t63 BY A FIXED
 * FACTOR WAS 44 % WRONG. The first cut took our "measured t63 runs ~2.75x the
 * constant" figure and applied it to FETish's readings, giving 4114 / 103 us —
 * which rendered every dial 44 % short of the reference. That factor is NOT
 * constant across the ladder: measured on our own kernel it is 1.64 at dial 1
 * (800 us -> 1313) and 2.76 at dial 5 (68 -> 188), because a slower attack is
 * resolved differently by a rectifier that only clears threshold near the
 * waveform peaks.
 *
 * So each endpoint is solved by driving our own kernel until it REPRODUCES the
 * reference's measured t63 at the reference's own depth: dial 1 to 11313 us
 * (FETish's 800 us setting) and dial 5 to 938 (its 66 us setting), then the
 * geometric ladder carries the rest. Third time this principle has been needed
 * — after the release endpoints and the depth-schedule slope — and the third
 * time the number the measurement printed was not the number to install.
 *
 * ⚠⚠ AND THE LADDER IS A SINGLE-DEPTH SNAPSHOT OF SOMETHING THAT IS NOT ONE
 * CONSTANT. FETish's attack SHORTENS with reduction depth, measured at one
 * setting with only the Input moving: 5438 / 2188 / 1563 / 1063 us of t63 at
 * 6.2 / 14.0 / 17.5 / 21.9 dB — a factor of 5.12. Fitted, `t63 = 10018 *
 * exp(-0.1047 * D)` at R2 0.995; our own kernel over the same span contributes
 * only -0.0194/dB, so the reference's own law is about **-0.085 per dB**.
 *
 * Its RELEASE schedule fitted at **+0.1389 per dB** — opposite sign, similar
 * size. Both limbs are program-dependent on depth: it grabs faster and lets go
 * slower the harder it is working.
 *
 * These endpoints were solved at ~15.9 dB and are only right there. Against that
 * law the ladder is **2.82x too fast at 6 dB and 0.53x too slow at 22 dB**. It is
 * an honest A/B of the reference's attack AT ONE DEPTH, and expressing the rest
 * needs an attack schedule of the kind `releaseSchedule` already provides.
 *
 * ⚠ THE FAST ENDPOINT IS ALSO AN EXTRAPOLATION AND THE MEASUREMENT COULD NOT
 * REACH IT. FETish's 20 us capture read 188 us of t63, which is 1.5 half-periods of the
 * 4 kHz probe — the measurement floor, not its behaviour. Resolving it needs a
 * faster probe; 10 kHz would give a 50 us half-period.
 *
 * ⚠ AND CHOOSING IT MEANS LEAVING THE DATASHEET BY 5x. The hardware 1176 is
 * specified at 20-800 us and `ATTACK_SLOWEST_S` / `ATTACK_FASTEST_S` quote it.
 * Release moved 2.73x in the OTHER direction, so the two are not one common
 * cause and following FETish here is a judgement about which to match, not a
 * correction.
 */
const FETISH_ATTACK_SLOWEST_S = 0.006370
const FETISH_ATTACK_FASTEST_S = 0.0001593
/**
 * Release endpoints, FITTED TO FETish rather than quoted from the datasheet.
 *
 * ⚠ THE TAPER SHAPE WAS ALREADY RIGHT AND ONLY THESE TWO NUMBERS WERE WRONG.
 * Seven captures varying only the release knob, at a depth matched to 0.44 dB,
 * give measured t63 over the declared setting as a CONSTANT 0.366 across a 22x
 * range of the knob — and the step ratios agree to three decimals (declared
 * 1.7200 / 1.6906 / 1.6723 against measured 1.7222 / 1.6863 / 1.6860). So the
 * geometric ladder `dialToSeconds` interpolates is the one FETish uses; the
 * endpoints were 2.73x too slow at both ends.
 *
 * The old 1.1 s / 50 ms had no provenance beyond a datasheet both plugins quote,
 * and agreement at the endpoints was never evidence of anything because our
 * constants came from the same sheet. These are measurements.
 *
 * ⚠ EVERY SAVED RELEASE DIAL NOW MEANS SOMETHING FASTER. That re-voices the
 * factory presets along with the Input span change, deliberately and with the
 * owner's agreement; they are to be re-cut together.
 *
 * ⚠⚠ THESE ARE NOT THE MEASURED 402 / 18.3 ms, AND THAT IS THE POINT. Those are
 * what a FIXED release needs to reproduce the ladder. With the depth schedule
 * shipping, the constant shrinks as the reduction decays DURING the recovery, so
 * the same endpoints render 45 % short. The schedule reads the state and not the
 * clock, so scaling the base constant scales the whole trajectory's timebase
 * exactly — measured uniformly at 0.5516 across all seven dials — and 1.8130x
 * puts the ladder back. Installing the measured numbers directly and trusting
 * them to compose is the same class of error as regressing t63 to get `k`: what
 * ships is the constant that makes the RENDER match, not the one the
 * measurement printed.
 */
const RELEASE_SLOWEST_S = 0.7288
const RELEASE_FASTEST_S = 0.03318

// Program-dependent release: this share of the reduction recovers on a tail
// this many times slower than the dial setting.
/**
 * Depth-scheduled release — OFF BY DEFAULT, and off is bit-identical to before.
 *
 * ⚠ THIS IS A DIFFERENT MECHANISM FROM `TAIL_FRACTION`, NOT A RETUNE OF IT. The
 * tail makes recovery depend on how LONG the cell was held down; this makes it
 * depend on how DEEP the reduction is. Measured on FETish with one release
 * setting and only the Input moving, release t63 runs 30 / 70 / 93 / 139 ms at
 * 6.2 / 14.0 / 17.5 / 21.9 dB — 4.6x — while it reads flat on both the exposure
 * and the density plans. Our own kernel with the tail off reads 233 ms at every
 * depth to the millisecond, which is what a fixed exponential must do, so the
 * measurement is clean and the effect is the reference's.
 *
 * ⚠ THE SCHEDULE READS THE CURRENT REDUCTION, NOT THE DEPTH AT RELEASE ONSET.
 * That is the physical choice — a cap network's recovery rate follows its present
 * state — and it is why the recovery is NOT a pure exponential and why measured
 * t63 is no longer the constant behind it. Fitting `k` by regressing the numbers
 * above is therefore wrong; it has to go through the kernel and the same
 * analysis, as everything else here does.
 */
/**
 * ⚠ THE ANCHOR IS THE DEPTH THE RELEASE ENDPOINTS WERE FITTED AT, NOT A ROUND
 * NUMBER, AND GETTING THIS WRONG COSTS 42 %. The endpoint fit — the seven-dial
 * ladder that lands within 1.8 % of FETish — was measured at 12.5 dB of
 * reduction with the schedule off. The schedule multiplies by
 * `exp(k * (D - REF))`, so shipping both with REF at 10 would have made every
 * dial render `exp(0.1389 * 2.5)` = 1.415x long at the very depth the ladder was
 * matched at, and the two fits would have silently fought. At REF = 12.5 the
 * schedule is exactly 1.000 there and the ladder composes with it untouched.
 */
/**
 * Depth-scheduled ATTACK — off by default, and off is bit-identical to before.
 *
 * ⚠ THE MIRROR OF `releaseSchedule`, AND THE SIGN IS THE POINT. FETish's attack
 * SHORTENS with reduction depth where its release LENGTHENS: measured at one
 * setting with only the Input moving, attack t63 runs 5438 / 2188 / 1563 /
 * 1063 us at 6.2 / 14.0 / 17.5 / 21.9 dB, fitting exp(-0.1047 per dB) at R2
 * 0.995, against exp(+0.1389) for the release. Our own kernel contributes only
 * -0.0194 over the same span, so the reference's own law is about -0.085.
 *
 * It grabs faster and lets go slower the harder it is working. Two limbs of one
 * program-dependent detector, not two quirks.
 *
 * ⚠ THE SCHEDULE READS THE REDUCTION AS IT RISES, which is what makes this a
 * solve rather than an arithmetic conversion. During an attack the reduction
 * climbs from 0 to the target, so a schedule anchored at the reference depth
 * starts far off it — at k = -0.085 and a 15.9 dB anchor the constant begins
 * 3.9x LONG and shortens as the cell grabs. `k` and the ladder are therefore
 * fitted together by simulate-and-match, in `scripts/fet-attack-depth.mjs`.
 */
export const ATTACK_DEPTH_REF_DB = 15.9
export const ATTACK_DEPTH_K = -0.0926

// Exported alongside the attack pair so the preset re-cut can read the schedule
// analytically instead of re-deriving it — see `scripts/fet-recut-presets.mjs`.
export const RELEASE_DEPTH_REF_DB = 12.5
export const RELEASE_DEPTH_K = 0.1389
const RELEASE_DEPTH_MAX_DB = 36
const RELEASE_LUT_STEP_DB = 0.25

/**
 * ⚠ ZERO, BECAUSE THE REFERENCE MEASURABLY HAS NO EXPOSURE LIMB. FETish reads
 * flat on bursts.wav (release t63 identical to the millisecond after 50 ms and
 * 3 s holds, on every capture) and flat on transients.wav (train against train,
 * against a control that spreads 10.1 % with this stage and 0.1 % without). Its
 * program dependence is on DEPTH, which `releaseSchedule` now carries.
 *
 * Left at 0.22 alongside the fitted endpoints, every release dial rendered about
 * 50 % long against the reference — 27.7 ms against 18, 129.8 against 86, 603.8
 * against 407 — a uniform offset that was this stage and not the endpoints.
 *
 * ⚠ THE ALL-BUTTONS TAIL IS NOW ZERO TOO, AND THAT CHANGED WHEN THE CAPTURE
 * ARRIVED. It was 0.45 on a 6x stage, held on the grounds that no all-buttons
 * capture existed — see below.
 */
const TAIL_FRACTION = 0
const TAIL_MULT = 4

/**
 * ALL-BUTTONS-IN: NO TAIL EITHER, measured on CLA-76's one all-buttons
 * `bursts.wav` bounce (ratio all, attack 4, release 4, Input I3).
 *
 * ⚠⚠ THE OBSERVABLE THAT USED TO ARGUE FOR A TAIL IS FULLY EXPLAINED BY THE
 * DEPTH SCHEDULE. Release t63 does lengthen with hold — 77 / 82 / 105 / 124 ms
 * across the 0.05 / 0.2 / 1 / 3 s holds — which is exactly what a tail looks
 * like. But reduction deepens over those same holds (9.70 / 10.02 / 11.91 /
 * 13.34 dB), and `RELEASE_DEPTH_K` says a deeper release is slower. Against the
 * shortest hold:
 *
 *   hold          0.2 s    1 s     3 s
 *   observed      1.065   1.364   1.610
 *   depth alone   1.045   1.359   1.658
 *
 * Agreement at every hold, and **0.971x left over for a tail** end to end —
 * which is nothing. A 45 % share on a 6x stage would have shown as a large
 * extra lengthening on top of the depth term. It is not there.
 *
 * ⚠ ONE CAPTURE, ONE REFERENCE, AND IT LEANS ON A CONSTANT FITTED ELSEWHERE.
 * `RELEASE_DEPTH_K` was fitted to FETish at ratio 4, so using it to explain
 * CLA-76 at all-buttons assumes the same law applies — the agreement is itself
 * the evidence for that, but it is not independent of it. FETish has no
 * all-buttons mode, so a second reference cannot check this.
 *
 * ⚠ AND IT DOES NOT MAKE THE TWO MODES IDENTICAL. `ALL_TAIL_MULT` is now inert
 * (a fraction of zero), kept so the topology is still expressible; all-buttons
 * still differs by its threshold drop, knee, soft ratio law, attack lag and FET
 * drive — the constants this capture says nothing about.
 */
const ALL_TAIL_FRACTION = 0
const ALL_TAIL_MULT = 6

// ── Gain computer ───────────────────────────────────────────────────────────

const RATIO_VALUES = { 4: 4, 8: 8, 12: 12, 20: 20 }

/**
 * THE KNEE, AND IT IS NOT A PROPERTY OF THE RATIO BUTTON.
 *
 * ⚠ IT USED TO BE `{4: 10, 8: 8, 12: 6, 20: 3}` — "tighter knees as the ratio
 * climbs" — AND THAT HAS NO SUPPORT IN ANY CAPTURE. FETish's 16 `stairs.wav`
 * bounces read **5.85 / 5.85 / 5.84 / 5.84 dB across ratios 12 / 20 / 4 / 8** at
 * one Input position: one knee for every button, to a hundredth of a dB. The
 * four different values were invented, and the ratio sweep was added to the
 * capture matrix to test exactly that.
 *
 * ⚠ WHAT THE KNEE DOES TRACK IS THE INPUT KNOB — 5.85 dB at I1 to 10.86 at I4,
 * monotone, across 24.99 dB of drive. A constant per button cannot express that
 * at all, which is why this is a law and not a number.
 *
 * ⚠ AND THE GROWTH IS FETish'S, NOT THE INSTRUMENT'S, WHICH TOOK A CONTROL TO
 * ESTABLISH. The obvious suspicion is the tool: the attack-lag bias grows with
 * reduction depth, so a deeper capture could simply READ as a wider knee. Our
 * own kernel's knee was nailed to 10 dB by construction; run across the same
 * four drive offsets and fitted the same way it read **10.95 / 11.13 / 11.09 /
 * 10.91 — a 0.22 dB spread** against FETish's 5.01 dB of growth. The instrument
 * does not manufacture knee growth. `fetStairs.test.js` pins that control.
 */
const KNEE_AT_REF_DB = 4.7344
/**
 * The drive the knee is quoted at, and the dB of knee per dB of drive above it.
 *
 * FITTED BY SIMULATE-AND-MATCH against all four Input positions —
 * `scripts/fet-static-fit.mjs`, targets in `data/fet1176/fetish_stairs_fits.json`.
 *
 * ⚠ THE LAW IS LINEAR, AND THE CAPTURES SAY SO RATHER THAN THE FIT ASSUMING IT.
 * FETish's knee against its own drive: 5.85 at +0.00, 7.21 at +6.80, 9.53 at
 * +18.40, 10.86 at +25.00 — segment slopes 0.2000 / 0.2000 / 0.2015. Straight to
 * three-quarters of a percent over 25 dB.
 *
 * ⚠ AND 0.2004 IS NOT THE NUMBER TO INSTALL, because the instrument's knee bias
 * is WIDTH-DEPENDENT: measured on our own kernel, a true knee of 4 / 6 / 8 / 10 /
 * 12 dB reads back 5.92 / 7.90 / 9.53 / 11.11 / 12.76 — a bias of +1.92 shrinking
 * to +0.76. It therefore COMPRESSES the range, so reproducing a fitted growth of
 * 5.01 dB takes a true growth near 5.8. Fifth constant in this re-tune where the
 * printed number is not the number to install; the fit returns 0.21738, 8.5 %
 * steeper, and 4.7344 at drive 0 against a fitted reading of 5.85 at I1.
 *
 * VALIDATED ON POINTS THAT WERE NOT FITTED. Fitted on I1 and I4 alone the law
 * comes back 4.8955 / 0.22393 and predicts the held-out I2 and I3 to an rms of
 * 0.257 dB, worst +0.53. That is the test of the LINE, which is the whole claim
 * about the law's shape.
 *
 * ⚠ THE FULL-FIT RESIDUAL (0.384 dB rms) IS A STRUCTURAL MISMATCH, NOT NOISE,
 * and it has a direction: our fitted knee moves 0.32 dB across the ratio
 * buttons where FETish's moves 0.01, so no single law can match all sixteen
 * readings. The residual is worst at the high buttons and the deepest drive
 * (-0.84 dB at ratio 20 / I4). Known and left: closing it needs a knee that
 * knows about the button, which is the opposite of what the captures say.
 *
 * ⚠⚠ AN EARLIER VERSION OF THIS NOTE CLAIMED THE SLOPE WAS AMBIGUOUS BY 24 %,
 * AND THAT WAS MY ERROR, NOT THE DATA'S. It argued that FETish spends 24.99 dB
 * of drive going I1 -> I4 where our kernel reaches the same REDUCTION in 20.07,
 * so "per dB of drive" depended on which axis you meant. Wrong question: the
 * knee is a width on the INPUT-LEVEL axis, and `effThresholdDb` — `threshold -
 * drive` — is absolute, dBFS against the same stimulus, so both kernels report
 * where the bend sits in the same units. Put in correspondence on that, the two
 * drive axes coincide by construction. Reduction never enters it. FETish does
 * need more drive for the same reduction, because its slope is lower; that is a
 * fact about the slope and says nothing about where the bend is.
 */
const KNEE_DRIVE_REF_DB = 0
const KNEE_DRIVE_SLOPE = 0.21738
// The law is linear and the knob is not, so it needs ends. The floor keeps the
// knee from inverting into a corner at the bottom of the travel; the ceiling is
// where the knee would start swallowing the whole useful range of overshoot.
const KNEE_FLOOR_DB = 2
const KNEE_CEIL_DB = 16

/**
 * The knee at a given Input drive, dB.
 *
 * ⚠ IT TAKES THE KNOB'S DRIVE, NOT THE DRIVE THE DETECTOR SEES, and the
 * difference is `inputAlignDb`. Passing the aligned drive is the obvious reading
 * — the knee lives in the gain computer, which is detector side — and it would
 * UNDO INPUT ALIGNMENT. Alignment exists so that a knob position delivers the
 * same reduction on a -18 dBFS file as on a -1 dBFS one; it does that by adding
 * an offset to the detector's level so `over` comes out identical. Widen the
 * knee with that same offset and the two files get the same `over` through
 * DIFFERENT curves, so the quiet one compresses softer — which is precisely the
 * level dependence alignment was built to remove.
 *
 * ⚠ THE CAPTURES CANNOT SETTLE THIS AND ARE NOT BEING ASKED TO. They varied the
 * Input knob against a fixed stimulus, so knob drive and detector level moved
 * together and nothing separates them. FETish has no alignment, so the question
 * does not arise there. This is a design choice made where the data is silent,
 * and it is recorded as one.
 */
export function kneeDbForDrive(driveDb, atRefDb = KNEE_AT_REF_DB, slope = KNEE_DRIVE_SLOPE) {
  const knee = atRefDb + slope * (driveDb - KNEE_DRIVE_REF_DB)
  return clamp(knee, KNEE_FLOOR_DB, KNEE_CEIL_DB)
}

// ⚠ NOT `KNEE_MIN_DB` — `fet-stairs.mjs` exports that name for the FITTER's grid
// bound, which is a different quantity (how narrow a knee the search may report)
// and the two are imported side by side in `fetStairs.test.js`.
export { KNEE_AT_REF_DB, KNEE_DRIVE_SLOPE, KNEE_DRIVE_REF_DB, KNEE_FLOOR_DB, KNEE_CEIL_DB }

// All-buttons-in: a wide, badly-behaved knee whose effective ratio climbs
// with overshoot, over a threshold pulled down by ALL_THRESHOLD_DROP_DB.
/**
 * THE THRESHOLD AND THE RATIO BUTTON — `'moving'` SHIPS.
 *
 * ⚠ THIS CHANGED WHAT EVERY PATCH ON 8:1, 12:1 AND 20:1 DOES. Ratio 4 is the
 * anchor and is untouched; the others start compressing later, by up to 3.98 dB
 * of threshold at 20:1. The two factory presets on those buttons were re-cut in
 * the same change. It shipped on the hardware documentation's authority, over a
 * reference that disagrees — see below.
 *
 * ⚠⚠ WE HOLD THE THRESHOLD FIXED ACROSS ALL FOUR BUTTONS, AND FETish AGREES
 * EXACTLY: 16 captures, four buttons at four Input positions, effective
 * threshold identical to the printed digit at every position (-15.29 / -22.09 /
 * -33.68 / -40.28 dBFS, 0.00 dB of spread across the buttons). So `'fixed'` is
 * not an invention — it reproduces one of the two references perfectly.
 *
 * ⚠ CLA-76 MOVES IT, AND SO DOES THE HARDWARE. CLA-76 spreads 3.88-4.11 dB
 * across the same four buttons, monotone in ratio, at every drive. The UA
 * manual says the same — "The 1176 has been designed so that selecting higher
 * ratios also raises the threshold level" (quoted in Moore, JARP 2012, who
 * reads it off the Urei transfer-function diagram too). ⚠ AND FETish
 * CONTRADICTS ITS OWN MANUAL HERE, which is what the ratio sweep was added to
 * test.
 *
 * The law, fitted to CLA-76's 16 captures: the threshold RISES **1.712 dB per
 * octave of ratio**, worst residual 0.135 dB. Measured offsets against its own
 * ratio 4: +1.778 at 8:1, +2.673 at 12:1, +3.975 at 20:1.
 *
 * ⚠ THE ANCHOR AT RATIO 4 IS A CHOICE, NOT A MEASUREMENT. Captures give only
 * the offsets BETWEEN buttons; where the family sits absolutely is degenerate
 * with the Input drive, exactly as for all-buttons. Anchoring at 4:1 leaves the
 * most-used button — and the two presets that sit on it — untouched, so the
 * A/B is about the other three rather than about everything at once.
 *
 * ⚠ ALL-BUTTONS IS NOT AFFECTED. It keeps `ALL_THRESHOLD_DROP_DB` from the base
 * threshold; this switch is scoped to the four numbered buttons.
 */
export const RATIO_THRESHOLD_PER_OCTAVE_DB = 1.712

/** The threshold offset a ratio button carries, dB, under `'moving'`. */
export function ratioThresholdOffsetDb(ratio, perOctave = RATIO_THRESHOLD_PER_OCTAVE_DB) {
  const r = RATIO_VALUES[ratio] ?? 4
  return perOctave * Math.log2(r / 4)
}

export const ALL_KNEE_DB = 16
export const ALL_THRESHOLD_DROP_DB = 6

/**
 * THE ALL-BUTTONS SLOPE LAW — AND IT USED TO RUN THE WRONG WAY.
 *
 * ⚠⚠ IT WAS `ratio = MIN + SPAN*over/(over + HALF)` WITH MIN 6 AND SPAN 14, so
 * the ratio CLIMBED from 6 to 20 as overshoot grew. Measured on CLA-76's four
 * all-buttons captures through `fet-allbuttons-shape.mjs`, it **falls**: ratio
 * ~19.7 just clear of the knee down to ~6.3 some 19 dB above it, a trend of
 * -0.756 of ratio per dB. Our own kernel through the same extractor read
 * 0.9473 -> 0.9521 — flat at ratio ~20, because a 16 dB knee saturated the old
 * law everywhere it could be seen.
 *
 * ⚠ THE OLD FAMILY COULD NOT BE RESCUED BY FLIPPING ITS SIGN, which was checked
 * before replacing it: fitted to the falling region with negative spans allowed,
 * the best member reached 1.595 rms of ratio (~12 % of the measured range) and
 * wanted an asymptote of -13.0, which is not a ratio at all.
 *
 * ⚠ AND THE DATA WANTS A LINE, NOT A RECIPROCAL. Candidate families fitted to
 * the measured slope (which spans 0.107):
 *
 *   linear in slope, floored      rms 0.0115
 *   exponential decay in slope    rms 0.0092   <- tau 59.5 dB, i.e. linear here
 *   falling reciprocal in ratio   rms 0.0130   <- floor pinned at ratio 1.0
 *
 * The exponential's edge is illusory: at tau 59.5 dB it IS the line over the
 * 6-25 dB the captures cover, and its floor sits where nothing was measured.
 * The line is installed because it is the simplest thing that fits and it makes
 * its one extrapolation explicit.
 *
 * ⚠ CORROBORATED, NOT JUST FITTED. Shanks (UA Webzine 2003, via Moore, JARP
 * 2012) likens the all-buttons curve to a "plateau" — a region of very high
 * ratio with the curve resuming its rise above it, which is a falling ratio.
 * The UA manual puts all-buttons "between 12:1 and 20:1"; this matches near the
 * knee and goes below it at the top, which is where Moore's own drum test saw
 * "the occasional hit overshooting... close to 0dBFS" at low RMS.
 */
export const ALL_INCR_AT_KNEE = 0.949
export const ALL_INCR_FALL_PER_DB = 0.0057
/**
 * ⚠ THE FLOOR IS AN EXTRAPOLATION AND THE CAPTURES DO NOT REACH IT. The measured
 * curve stops at 0.8418 (ratio 6.32) about 19 dB above the knee, and this line
 * crosses the floor near 28 dB. It is set at ratio 6 — the old `ALL_RATIO_MIN`,
 * itself a guess — because a falling slope with no floor keeps falling until it
 * EXPANDS, and a stated extrapolation beats an unbounded one.
 */
export const ALL_INCR_FLOOR = 1 - 1 / 6

/**
 * ⚠⚠ THESE ARE INCREMENTAL SLOPES — `d(reduction)/d(level)` — AND THE KERNEL'S
 * `slope` IS NOT. Everywhere else in this file reduction is `slope * over`, a
 * SECANT. For a law whose slope varies with level the two differ by the product
 * rule: with `gr = s(over)*over` the incremental slope is `s + over*s'`, so a
 * secant falling at k reads as an incremental falling at 2k. A first cut here
 * installed the measured 0.0057 as a secant, and the shape extractor's own
 * self-test caught it — our kernel came back falling twice as fast as the
 * reference it was fitted to.
 *
 * The extractor measures the INCREMENTAL slope, because that is what
 * `d(gr)/d(level)` is and what a compressor's ratio conventionally means. So the
 * law is stated incrementally and reduction is its INTEGRAL, which removes the
 * factor of two rather than leaving it in a comment for someone to trip over.
 *
 * ⚠ ANCHORED AT THE KNEE EXIT, NOT AT ZERO OVERSHOOT, WHICH COUPLES IT TO
 * `ALL_KNEE_DB`. The measurement's x-axis origin is unrecoverable — drive and
 * threshold drop enter as a sum — so the curve can only be placed by assuming
 * the reference's knee ends where ours does. ⚠ A CHANGE TO `ALL_KNEE_DB` OR
 * `ALL_THRESHOLD_DROP_DB` MOVES THIS LAW and it must be refitted.
 */
export function allButtonsIncrSlope(overDb, halfKneeDb, atKnee = ALL_INCR_AT_KNEE,
  fallPerDb = ALL_INCR_FALL_PER_DB, floor = ALL_INCR_FLOOR) {
  return clamp(atKnee - fallPerDb * (overDb - halfKneeDb), floor, atKnee)
}

/**
 * Reduction at an overshoot at or above the knee exit: the integral of
 * `allButtonsIncrSlope`, continuous with the knee's own curve at `halfKneeDb`.
 */
export function allButtonsGr(overDb, halfKneeDb, atKnee = ALL_INCR_AT_KNEE,
  fallPerDb = ALL_INCR_FALL_PER_DB, floor = ALL_INCR_FLOOR) {
  const grAtKnee = atKnee * halfKneeDb
  const x = overDb - halfKneeDb
  if (x <= 0) return grAtKnee
  // Where the falling line meets the floor and the law goes straight again.
  const xMax = fallPerDb > 0 ? (atKnee - floor) / fallPerDb : Infinity
  if (x <= xMax) return grAtKnee + atKnee * x - fallPerDb * x * x / 2
  const grAtMax = grAtKnee + atKnee * xMax - fallPerDb * xMax * xMax / 2
  return grAtMax + floor * (x - xMax)
}

// The famously late attack: the dial still sets the rate, but everything
// arrives slower than the number says.
const ALL_ATTACK_LAG = 2.5
// ...and the FET is driven much harder, which is most of the "sound".
const ALL_FET_BOOST = 1.6

/**
 * THE STATIC CURVE, MEASURED — Analog Obsession FETish, `npm run fet:curve`.
 *
 *   f(x) = x − 0.0100·x⁴ + 0.0100·x⁵   =   x − 0.01·x⁴·(1 − x)
 *
 * Fitted jointly over five tone levels spanning 24 dB and verified by rendering
 * the fitted curve back through the same tones: H2 matches to 0.1 dB at EVERY
 * level, worst error 1.39 dB over 17 usable harmonic readings. Held out the
 * loudest tone, refitted without it, and asked it to predict that tone: 1.41 dB.
 *
 * ⚠ THE ORDERS ARE MEASURED, NOT CHOSEN. A term of order n makes harmonics that
 * rise (n−1) dB per dB of level, of its own parity, at or below n. FETish reads
 * H2 3.00, H3 4.04, H4 3.02, H5 4.09 — orders 4 and 5 — and H6 through H9 sit
 * at the float noise floor, which is what a degree-5 polynomial and nothing else
 * looks like. H4/H2 measures −12.04 dB against a pure x⁴ term's −12.04.
 *
 * ⚠ AND THIS IS WHY THE `tanh` COULD NOT BE RETUNED INTO IT. A tanh is
 * cubic-dominant: its H2 rises about 1 dB per dB. No value of `fetDrive` moves
 * that to 3. The shape had to change, not the drive.
 *
 * ⚠ THE COEFFICIENTS ARE ±0.01 TO FOUR FIGURES, which is almost certainly the
 * reference's own design constants rather than anything our fit invented.
 */
const POLY_C4 = -0.0100
const POLY_C5 = 0.0100

/**
 * ⚠ THE POLYNOMIAL IS UNBOUNDED AND THE `tanh` IT REPLACES WAS NOT. Deviation
 * from linear is 0.00 at x = 1 and 0.02 at x = −1, but +0.16 at x = 2 and
 * +7.70 at x = 4 — and `inputDrive` can push the shaper's input well past
 * unity. Beyond this magnitude the curve continues LINEARLY at its own edge
 * slope, which is C1-continuous (no corner to alias) and grows no faster than
 * the input.
 *
 * 1.0 rather than something larger because the fit's own data only reaches a
 * peak of 0.5 (the −6 dBFS tone): past unity we would be extrapolating a
 * measurement by more than 6 dB, and a straight line is the honest extension.
 */
const POLY_XMAX = 1.0

const LN10_OVER_20 = Math.LN10 / 20

export const FET1176_KERNEL_DEFAULTS = {
  inputDrive: 50, // 0-100, drive into the fixed threshold (hardware Input knob)
  outputGainDb: 0, // makeup (hardware Output knob)
  attack: 4, // dial 1-7, 7 = fastest (hardware markings)
  release: 4, // dial 1-7, 7 = fastest (hardware markings)
  ratio: '4', // '4' | '8' | '12' | '20' | 'all'
  /**
   * Release-time schedule.
   *   'depth' — SHIPS. The constant scales with the CURRENT reduction, which is
   *             the limb FETish actually has. See RELEASE_DEPTH_K.
   *   'none'  — one constant per knob position, whatever the reduction. What
   *             shipped before the fit; reachable through FET_LEGACY_PATCH,
   *             though see the warning there about what that can no longer
   *             restore.
   */
  /**
   * Which attack ladder the dial interpolates.
   *   'datasheet' — 20-800 us, the 1176's published span. SHIPS.
   *   'fetish'    — 103 us - 4.1 ms, measured. A/B only; see the constants.
   */
  attackRange: 'datasheet',
  /**
   * Attack-time schedule.
   *   'depth' — SHIPS. The constant shortens as the TARGET reduction deepens,
   *             which is the limb both references have.
   *   'none'  — one constant per dial whatever the reduction. What shipped
   *             before the fit; reachable through FET_LEGACY_PATCH.
   */
  attackSchedule: 'depth',
  /**
   * Whether the ratio button moves the threshold.
   *   'moving' — SHIPS. The threshold rises with the ratio button, which is
   *              CLA-76's behaviour and the hardware manual's. See
   *              `RATIO_THRESHOLD_PER_OCTAVE_DB`.
   *   'fixed'  — one threshold for all four buttons. What shipped before, and
   *              what FETish measures to 0.00 dB, so it is a complete model of
   *              one reference rather than a legacy stub.
   * Still a bench A/B because the references genuinely disagree; the default
   * follows the hardware documentation.
   */
  ratioThreshold: 'moving',
  /** dB per octave of ratio, read only when `ratioThreshold` is 'moving'. */
  ratioThresholdPerOctaveDb: RATIO_THRESHOLD_PER_OCTAVE_DB,
  /** dB⁻¹ slope of that schedule, negative. Read only when it is 'depth'. */
  attackDepthK: ATTACK_DEPTH_K,
  releaseSchedule: 'depth',
  /**
   * Detector offset in dB that makes a knob position mean the same reduction on
   * every file. Null/absent is 0 \u2014 the un-aligned behaviour. Measured per file
   * from gated RMS, never stored in a preset: it is a property of the FILE.
   */
  inputAlignDb: 0,
  /**
   * The output ceiling, dBFS, and how softly it is enforced. Null is off.
   *
   * ⚠ THESE TWO AND THE PERCENTILE MAKEUP ARE ONE MECHANISM. A percentile
   * reference does not keep "never louder than the source" by arithmetic, so
   * the ceiling keeps it by enforcement; `computeFET1176AutoMakeupPlan` is the
   * only thing that issues either and it issues both. Measured per FILE, like
   * `inputAlignDb` and for the same reason — never stored in a preset.
   */
  ceilingDb: null,
  ceilingKneeDb: null,
  /**
   * The knee law's two parameters, exposed so the stairs fitter can search them
   * and so a control can turn the law OFF (`kneeDriveSlope: 0`) and get the
   * fixed knee this shipped with. Absent means the fitted constants — see
   * `kneeDbForDrive`. Not panel params and not preset keys: the law is a fit,
   * not a taste control.
   */
  kneeAtRefDb: null,
  kneeDriveSlope: null,
  /** Continuous ratio, bypassing the button. Fit only — see `setParams`. */
  ratioValue: null,
  /** The all-buttons law, overridable for the fit. See `setParams`. */
  allKneeDb: null,
  allThresholdDropDb: null,
  allIncrAtKnee: null,
  allIncrFallPerDb: null,
  allIncrFloor: null,
  /** dB⁻¹ slope of that schedule. Only read when releaseSchedule is 'depth'. */
  releaseDepthK: RELEASE_DEPTH_K,
  /**
   * FET / output-amp saturation amount, 0-1.
   *
   * ⚠ 1 IS THE MEASURED FETish CURVE, not an arbitrary top of travel, and the
   * default sits there deliberately: shipping 0.35 meant shipping 35 % of the
   * curve we had just gone and measured — 9 dB less H2 than the reference at
   * −6 dBFS. The old default of 0.35 was calibrated for the `tanh`, where the
   * knob also moved the asymmetry bias and the whole travel was far dirtier
   * (H2 −38 dBc at 0.35 against this curve's −73).
   */
  fetDrive: 1,
  /**
   * Which static curve the FET stage uses.
   *   'poly' — the measured FETish curve (see POLY_C4). `fetDrive` scales it,
   *            so 1 IS the reference curve and 0.35 is 35 % of it.
   *   'tanh' — the fitted asymmetric tanh this shipped with before the capture.
   * ⚠ `fetDrive` MEANS A DIFFERENT THING IN EACH. On 'tanh' it set a drive into
   * a fixed shaper; on 'poly' it is a fraction of a measured curve. A stored
   * preset value carries across numerically and NOT in voicing.
   */
  fetCurve: 'poly',
  /**
   * Where the static curve sits among the two gain stages.
   *
   *   'preInput' — ahead of the input attenuator: the shaper sees the SOURCE,
   *                so saturation is a property of the file and does not move
   *                when the Input knob does.
   *   'preCell'  — after the attenuator, before the cell. The topology measured
   *                on FETish (rms error 0.00 dB against 26.09 for the other).
   *   'postCell' — after the cell, on the compressed signal. What this kernel
   *                did before, and what CLA-76 measures (0.07 against 3.94).
   *
   * ⚠⚠ 'preCell' IS FETish's TOPOLOGY AND IS *NOT* FETish's BEHAVIOUR HERE, and
   * the difference is our Input knob. FETish's Input is internally compensated,
   * so its audio path sits at source level whatever the knob does and its
   * shaper sees a FIXED drive. Ours is a real gain. Bolting FETish's topology
   * onto our Input contract gives the shaper the knob's full travel with nothing
   * regulating it — measured on a −6 dBFS tone across Input 10→90, H2 moves:
   *
   *     preCell   79.6 dB        postCell  36.4 dB        FETish  0.0 dB
   *
   * So 'preCell' is the FURTHEST of the three from the reference it was taken
   * from. 'postCell' does better only by accident — the cell pulls down what
   * reaches the shaper as the knob pushes it up, regulating about half of it.
   *
   * 'preInput' reproduces FETish's saturation behaviour EXACTLY (0 dB of swing)
   * while leaving the Input knob a real gain and the makeup architecture
   * untouched. It is not physical — the hardware's attenuator comes first — but
   * neither is FETish's compensation, and this is the arrangement that matches
   * what the reference actually does. Same reasoning as `inputAlign.js`: make
   * the character a property of the FILE, not of a knob position.
   */
  fetPosition: 'preInput',
  scHpfHz: 0, // 0 = off (stock), or sidechain high-pass corner in Hz
  mix: 1, // wet/dry blend — parallel compression
  /**
   * Run the gain cell and FET stage oversampled. Always true for anything
   * anyone listens to; see `computeFET1176AutoMakeupDb` for the one caller
   * that turns it off and why that is sound.
   */
  oversample: true,
}

/**
 * ⚠ EVERY FET PUNCH RENDER MADE BEFORE THE FETish CAPTURE SOUNDS DIFFERENT NOW.
 * This patch reproduces the previous kernel exactly — the fitted asymmetric
 * `tanh`, sitting after the gain cell — and `test/dsp/fet1176Curve.test.js`
 * pins it bit-for-bit against a render, so it cannot rot.
 *
 * Same arrangement, and the same reason, as `LA2A_LEGACY_PATCH`: a measurement
 * that changes the voicing must leave the old voicing reachable, or there is no
 * way to A/B the change and no way back for anyone who preferred it.
 */
/**
 * The kernel as it shipped before the FETish fit.
 *
 * ⚠⚠ THIS NO LONGER REPRODUCES OLD RENDERS AND MUST NOT BE READ AS DOING SO.
 * It restores the TOPOLOGY — the tanh curve, the post-cell shaper position, a
 * fixed release — but four of the changes are CONSTANTS rather than parameters
 * and a patch cannot reach them: `IN_DRIVE_SPAN_DB` (40 -> 48, so every Input
 * position moved), `RELEASE_SLOWEST_S` / `RELEASE_FASTEST_S` (2.73x, so every
 * release dial moved), `TAIL_FRACTION`, and now the knee — `RATIO_KNEE_DB`'s
 * four per-button values are gone and `kneeAtRefDb`/`kneeDriveSlope` cannot
 * express them, since the whole finding is that there is ONE knee. Those were
 * changed with the owner's agreement to re-voice rather than preserve, so
 * bit-exact reproduction of pre-fit renders was already gone before this patch
 * was extended.
 *
 * Unlike `LA2A_LEGACY_PATCH`, which does reproduce its predecessor exactly.
 */
/**
 * Lead-in fed to an offline render so it matches a settled preview, seconds.
 *
 * ⚠ FET PUNCH COULD NOT BE PRE-ROLLED AT ALL UNTIL THE TAIL CAME OFF, and the
 * reason recorded in `previewApplyConvergence.test.js` was the wrong one. That
 * test blamed the live makeup tracker's running maximum; measured, the tracker
 * does not latch in the offline path at all — a fixture whose loudest moment
 * sits well before the pre-roll window still converges to exactly 0. What did
 * not converge was the TAIL, whose constant is `releaseS * TAIL_MULT` = 4.4 s
 * under the old law, longer than any pre-roll anyone was going to feed it.
 * With `TAIL_FRACTION` at 0 the worst difference over a 2 s lead-in goes from
 * 1.64e-1 to 7.11e-15.
 *
 * ⚠ IT IS BIT-EXACT NOW, AND THIS NOTE USED TO SAY IT WAS NOT. All-buttons was
 * the one mode still carrying a tail (`ALL_TAIL_FRACTION` 0.45, held because no
 * all-buttons capture existed), which made it the slow case at 5.46e-6 after
 * 2 s — convergent but never zero. CLA-76's `bursts.wav` at ratio all supplied
 * the capture and says there is no tail, so with the fraction at 0 the last
 * state with memory longer than the pre-roll is gone and the claim is now
 * exactness, pinned by `previewApplyConvergence.test.js`.
 *
 * ⚠ THE LIVE PREVIEW IS A SEPARATE QUESTION THIS DOES NOT SETTLE. `trkInPeak`
 * is still a running maximum with unbounded memory, so what the user HEARS can
 * still carry a loud moment from earlier in the session. This makes the offline
 * render match a settled preview; it does not make the preview reproducible.
 */
export const FET1176_PREROLL_S = 2

export const FET_LEGACY_PATCH = {
  fetCurve: 'tanh',
  fetPosition: 'postCell',
  releaseSchedule: 'none',
  attackSchedule: 'none',
  // The pre-capture kernel held one threshold for every ratio button.
  ratioThreshold: 'fixed',
}

/**
 * How much audio the live makeup tracker must hear before it will report.
 *
 * ⚠ WITHOUT IT A FRESHLY-RESET TRACKER REPORTS FROM ALMOST NO EVIDENCE, and
 * every compression-knob change resets it. Measured on a drag: the live value
 * came back as 4.6 / 4.1 / 12.1 / 8.5 / 8.1 dB from the first few blocks and
 * fought the offline measurement all the way down the knob. A quarter second is
 * long enough to hold several syllables and short enough that the tracker takes
 * over almost as soon as the hand stops.
 */
const MAKEUP_TRACKER_WARMUP_S = 0.25

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
export function attackSecondsForDial(dial, attackRange = 'datasheet') {
  return attackRange === 'fetish'
    ? dialToSeconds(dial, FETISH_ATTACK_SLOWEST_S, FETISH_ATTACK_FASTEST_S)
    : dialToSeconds(dial, ATTACK_SLOWEST_S, ATTACK_FASTEST_S)
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

    /**
     * LIVE AUTO-MAKEUP TRACKER — running extrema, O(1) per sample.
     *
     * The same affine identity the offline solve rests on: `out = a + b·g` with
     * `a = dry·(1−mix)` and `b = wet·mix`, because the output gain is the last
     * multiply on the wet path and the detector reads the INPUT. BOTH are
     * independent of `g`, which is what lets the panel write the answer back
     * onto the knob without the measurement chasing itself.
     *
     * ⚠ TWO SHAPES WERE TRIED AND BOTH FAILED. A running MINIMUM of the
     * per-sample bound LATCHES, because the bound is taken against an input
     * peak that grows and the earliest, smallest bound wins forever: measured,
     * it froze at −0.83 dB against a true 10.25. And tracking the largest |b|
     * is exact at Mix 1 and +2.4 dB too generous at Mix 0.3, in the too-loud
     * direction, because with a large dry share the wet peak is not the sample
     * that binds.
     *
     * WHAT IS TRACKED IS `max|a|` AND `max|b|` SEPARATELY, and the bound is
     * `(P − max|a|) / max|b|`. Since `|a_i + b_i·g| <= max|a| + max|b|·g` for
     * every sample, that bound PROVABLY keeps the output peak at or under `P` —
     * the guarantee the offline solve makes, kept by the live one. It is EXACT
     * at Mix 1, where `a` is zero, and conservative below it: the two maxima
     * need not fall on the same sample, so the live makeup can come out a
     * little small at parallel settings. Under-delivering is the safe
     * direction, and APPLY re-measures offline for the exact number anyway.
     *
     * ⚠ TWO TIGHTER SHAPES WERE TRIED AND BOTH BROKE THE GUARANTEE. A running
     * MINIMUM of the per-sample bound LATCHES — the bound is taken against an
     * input peak that grows, so the earliest and smallest wins forever, and it
     * froze at −0.83 dB against a true 10.25. And tracking the single sample
     * that maximises `|a| + |b|·ĝ` is not a bound at all: measured at Mix 0.4
     * it asked for 11.66 dB against a true 7.60 and drove the output 2.75 dB
     * hotter than its source.
     */
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkAAbs = 0     // largest |a| seen
    this.trkBAbs = 0     // largest |b| seen
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
    /**
     * ⚠ THE ALL-BUTTONS LAW IS OVERRIDABLE SO IT CAN BE FITTED, and every one of
     * these five is currently a GUESS — no capture from either reference stands
     * behind them, and CLA-76's stairs already say the first two are too big.
     * `scripts/fet-allbuttons-fit.mjs` searches them. Fit only: not panel
     * params, not preset keys.
     */
    this.allKneeDb = Number.isFinite(p.allKneeDb) ? p.allKneeDb : ALL_KNEE_DB
    this.allIncrAtKnee = Number.isFinite(p.allIncrAtKnee) ? p.allIncrAtKnee : ALL_INCR_AT_KNEE
    this.allIncrFallPerDb = Number.isFinite(p.allIncrFallPerDb)
      ? p.allIncrFallPerDb : ALL_INCR_FALL_PER_DB
    this.allIncrFloor = Number.isFinite(p.allIncrFloor) ? p.allIncrFloor : ALL_INCR_FLOOR
    const allDrop = Number.isFinite(p.allThresholdDropDb) ? p.allThresholdDropDb : ALL_THRESHOLD_DROP_DB
    if (this.isAllButtons) {
      this.thresholdDb = THRESHOLD_DBFS - allDrop
      this.tailFraction = ALL_TAIL_FRACTION
      this.tailMult = ALL_TAIL_MULT
    } else {
      const ratioKey = RATIO_VALUES[p.ratio] ? p.ratio : '4'
      /**
       * ⚠ `ratioValue` BYPASSES THE BUTTON, and exists for the static-curve fit.
       * `ratio` is a four-position switch, so a search cannot move through it;
       * this is the continuous quantity underneath, which is what gets fitted.
       * Not a panel param and not a preset key — the buttons are the product.
       */
      this.ratio = Number.isFinite(p.ratioValue) && p.ratioValue > 1
        ? p.ratioValue
        : RATIO_VALUES[ratioKey]
      this.slope = 1 - 1 / this.ratio
      /**
       * ⚠ 'moving' SHIPS; 'fixed' reproduces FETish exactly. See
       * `RATIO_THRESHOLD_PER_OCTAVE_DB`.
       *
       * ⚠⚠ AN ABSENT VALUE RESOLVES TO THE DEFAULT, AND IT DID NOT. `setParams`
       * merges `{ ...this.params, ...partial }`, so a caller spreading an object
       * that happens to carry `ratioThreshold: undefined` — which is what
       * `{ ...defaults, ...extra }` produces whenever `extra` names the key
       * without a value — overwrote the default with `undefined`. A bare
       * `=== 'moving'` then read that as `fixed` and SILENTLY SHIPPED THE OTHER
       * MODEL. Caught by this key's own default test, in its own test helper.
       * Every other param in this method guards the same way (`Number.isFinite`
       * for the numeric ones); this one was the exception.
       */
      const ratioThresholdMode = p.ratioThreshold == null
        ? FET1176_KERNEL_DEFAULTS.ratioThreshold
        : p.ratioThreshold
      this.thresholdDb = ratioThresholdMode === 'moving'
        ? THRESHOLD_DBFS + ratioThresholdOffsetDb(ratioKey, p.ratioThresholdPerOctaveDb)
        : THRESHOLD_DBFS
      this.tailFraction = TAIL_FRACTION
      this.tailMult = TAIL_MULT
    }
    // ⚠ THE KNEE IS NOT SET HERE ANY MORE. It is a function of the Input drive,
    // which this method computes further down, so it is assigned after that —
    // see `kneeDbForDrive`. Setting it here would read a stale drive on every
    // call that changes the Input knob, which is most of them.
    this.mainFraction = 1 - this.tailFraction

    // Ballistics. Attack is applied to the whole reduction; release splits
    // across a main stage and a slower tail.
    //
    // ⚠ THE SPLIT IS NOT A CLAIM THAT THE 1176 HAS TWO RELEASE CIRCUITS. It
    // has one, heavily program-dependent: recovery is quick after a transient
    // and lengthens under sustained compression. Two stages filling
    // proportionally on attack and decaying at different rates is how we
    // produce that observable — the longer the cell is held down, the more of
    // the reduction sits on the slow stage. Measured on our own kernel, release
    // t63 grows 21-25 % from a 50 ms hold to a 3 s one.
    let attackS = attackSecondsForDial(p.attack, p.attackRange)
    if (this.isAllButtons) attackS *= ALL_ATTACK_LAG
    const releaseS = dialToSeconds(p.release, RELEASE_SLOWEST_S, RELEASE_FASTEST_S)

    this.attackCoef = 1 - Math.exp(-1 / (sr * attackS))
    this.releaseCoef = 1 - Math.exp(-1 / (sr * releaseS))
    this.tailCoef = 1 - Math.exp(-1 / (sr * releaseS * this.tailMult))

    /**
     * \u26a0 A TABLE, NOT A `Math.exp` PER SAMPLE. The schedule reads the current
     * reduction, so a closed form would put two transcendentals in the envelope
     * loop at 4x oversampling. Quantising the DEPTH to 0.25 dB costs nothing
     * audible \u2014 the coefficient moves 2.4 % per step at k = 0.098 \u2014 and the
     * table is rebuilt only when a parameter changes.
     */
    /**
     * \u26a0 A SECOND TABLE, SAME REASONING AS THE RELEASE ONE. The schedule reads
     * the current reduction, so a closed form would put a transcendental in the
     * envelope loop at 4x oversampling. 0.25 dB of depth quantisation moves the
     * coefficient ~2 %.
     */
    this.attackScheduled = p.attackSchedule === 'depth'
    if (this.attackScheduled) {
      const ka = Number.isFinite(p.attackDepthK) ? p.attackDepthK : ATTACK_DEPTH_K
      const n = Math.round(RELEASE_DEPTH_MAX_DB / RELEASE_LUT_STEP_DB) + 1
      if (!this.attackLut || this.attackLut.length !== n) this.attackLut = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const depthDb = i * RELEASE_LUT_STEP_DB
        const tau = attackS * Math.exp(ka * (depthDb - ATTACK_DEPTH_REF_DB))
        this.attackLut[i] = 1 - Math.exp(-1 / (sr * tau))
      }
    }

    this.releaseScheduled = p.releaseSchedule === 'depth'
    if (this.releaseScheduled) {
      const k = Number.isFinite(p.releaseDepthK) ? p.releaseDepthK : RELEASE_DEPTH_K
      const n = Math.round(RELEASE_DEPTH_MAX_DB / RELEASE_LUT_STEP_DB) + 1
      if (!this.releaseLut || this.releaseLut.length !== n) this.releaseLut = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const depthDb = i * RELEASE_LUT_STEP_DB
        const tau = releaseS * Math.exp(k * (depthDb - RELEASE_DEPTH_REF_DB))
        this.releaseLut[i] = 1 - Math.exp(-1 / (sr * tau))
      }
    }

    // Input attenuator: audio path and detector both, as on the hardware.
    this.inputDriveDb = inputDriveDbForKnob(p.inputDrive)

    /**
     * The knee, which the Input knob moves — see `kneeDbForDrive`, including
     * why it reads the knob's drive rather than the aligned one.
     *
     * All-buttons keeps its own fixed width: `ALL_KNEE_DB` has no captures
     * behind it from either reference (FETish does not have the mode, and
     * CLA-76's knee readings came back on a search bound), so there is nothing
     * to justify giving it a drive law too.
     */
    this.kneeDb = this.isAllButtons
      ? this.allKneeDb
      : kneeDbForDrive(
        this.inputDriveDb,
        Number.isFinite(p.kneeAtRefDb) ? p.kneeAtRefDb : KNEE_AT_REF_DB,
        Number.isFinite(p.kneeDriveSlope) ? p.kneeDriveSlope : KNEE_DRIVE_SLOPE,
      )
    this.halfKnee = this.kneeDb / 2

    /**
     * \u26a0 A DETECTOR OFFSET, AND FOR FET PUNCH THAT IS NOT WHERE THE INPUT KNOB
     * LIVES. On OptoSmooth the alignment can ride the side-chain drive because
     * `scDriveDb` is side-chain only and the audio path never sees it. Here
     * `inputLin` gains the AUDIO as well \u2014 the hardware's input attenuator feeds
     * both \u2014 so folding the offset into it would raise the output level and
     * drive the saturator harder, which is exactly the "input gain that has to
     * undo itself downstream" that `dsp/inputAlign.js` argues against.
     *
     * So it is added to the detector's level instead, leaving `inputLin` at
     * whatever the knob says. The reduction a knob position delivers stops
     * depending on how hot the file is; the output level still tracks the file,
     * which is the user's gain staging and not ours to correct.
     */
    this.inputAlignDb = Number.isFinite(p.inputAlignDb) ? p.inputAlignDb : 0
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

    this.fetPoly = p.fetCurve !== 'tanh'
    // 0 = postCell, 1 = preCell, 2 = preInput. A number so the hot loop
    // branches on an integer rather than comparing strings per sample.
    this.fetPos = p.fetPosition === 'postCell' ? 0 : p.fetPosition === 'preCell' ? 1 : 2
    /**
     * The measured curve, scaled by the same amount the tanh path uses. All
     * buttons in drives it harder, exactly as it does the tanh.
     *
     * ⚠ THIS WAS CLAMPED AT 1 AND THE CLAMP WAS WRONG. The reasoning was "never
     * deeper than what was measured" — but the fitted range is a range of x,
     * which `POLY_XMAX` already guards, and scaling the coefficients only makes
     * the curve deeper, not wider. It stays monotonic there: at 1.6x depth
     * f'(x) = 1 + 4c₄x³ + 5c₅x⁴ bottoms out at 1.016 across [−1, 1].
     *
     * What the clamp actually did was flatten the top of the knob in
     * all-buttons mode from 0.625 upward — neutering the one mode whose whole
     * point is that the FET is driven harder.
     */
    const polyAmount = amount * (this.isAllButtons ? ALL_FET_BOOST : 1)
    this.polyC4 = POLY_C4 * polyAmount
    this.polyC5 = POLY_C5 * polyAmount
    // Edge value and slope at each end, for the linear continuation. Held
    // separately per side because the curve is asymmetric: f(−1) is −1.02 where
    // f(1) is exactly 1.
    const fAt = x => x + this.polyC4 * x ** 4 + this.polyC5 * x ** 5
    const dAt = x => 1 + 4 * this.polyC4 * x ** 3 + 5 * this.polyC5 * x ** 4
    this.polyEdgePos = fAt(POLY_XMAX)
    this.polySlopePos = dAt(POLY_XMAX)
    this.polyEdgeNeg = fAt(-POLY_XMAX)
    this.polySlopeNeg = dAt(-POLY_XMAX)
    // Lets the pre-cell path recover the cell's own gain from the folded
    // coefficient without a per-sample divide.
    this.invInputLin = 1 / this.inputLin

    this.wetMix = clamp(p.mix, 0, 1)
    this.dryMix = 1 - this.wetMix

    /**
     * The ceiling, memoryless and at the very output — after the wet/dry sum,
     * because a ceiling inside the wet path would be undone by the dry side.
     * Rounded DOWN to the nearest float32 so a sample sitting exactly on the
     * ceiling cannot round up through it.
     */
    this.ceilingLin = Number.isFinite(p.ceilingDb)
      ? float32AtOrBelow(Math.exp(p.ceilingDb * LN10_OVER_20)) : 0
    /**
     * ⚠ THE KNEE IS SIZED BY THE SOLVE, NOT FIXED — see `ceilingKneeDbFor`. A
     * ceiling with nothing to catch must cost nothing, and a fixed width costs
     * 0.3-0.5 dB of peak on a render that was already legal. Absent, fall back
     * to the widest fixed width: conservative, never unsafe.
     */
    const ceilingKneeDb = Number.isFinite(p.ceilingKneeDb)
      ? clamp(p.ceilingKneeDb, 0, CEILING_KNEE_DB) : CEILING_KNEE_DB
    this.ceilingKneeLin = this.ceilingLin > 0
      ? this.ceilingLin * Math.exp(-ceilingKneeDb * LN10_OVER_20) : 0

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

  /**
   * The FET stage's static curve, whichever one is selected.
   *
   * ⚠ ONE ENTRY POINT FOR BOTH CURVES AND BOTH PATHS. The oversampled and
   * base-rate loops each used to carry their own copy of the tanh expression,
   * and a third copy would have made a curve change a three-place edit with two
   * chances to diverge. The measurement path (`oversample: false`) has to agree
   * with the render path exactly or the auto-makeup solves against a different
   * plugin than the one anybody hears.
   */
  _shapeFet(x) {
    if (!this.fetPoly) {
      return (Math.tanh(this.fetDriveLin * x + this.fetBias) - this.tanhBias) / this.fetNorm
    }
    if (x > POLY_XMAX) return this.polyEdgePos + (x - POLY_XMAX) * this.polySlopePos
    if (x < -POLY_XMAX) return this.polyEdgeNeg + (x + POLY_XMAX) * this.polySlopeNeg
    const x2 = x * x
    const x4 = x2 * x2
    return x + this.polyC4 * x4 + this.polyC5 * x4 * x
  }

  /** Static curve: overshoot in dB -> gain reduction in dB. */
  _grForOvershoot(over) {
    if (over <= -this.halfKnee) return 0
    /**
     * ⚠ ALL-BUTTONS RETURNS AN INTEGRAL, NOT `slope * over`. Its slope varies
     * with overshoot, so a secant multiply is not the area under the law — see
     * `allButtonsIncrSlope` for the factor of two that costs.
     */
    if (this.isAllButtons) {
      if (over >= this.halfKnee) {
        return allButtonsGr(over, this.halfKnee, this.allIncrAtKnee,
          this.allIncrFallPerDb, this.allIncrFloor)
      }
      // Inside the knee, the knee's own curve, meeting the law at the exit.
      const tk = over + this.halfKnee
      return this.allIncrAtKnee * tk * tk / (2 * this.kneeDb)
    }
    if (over >= this.halfKnee) return this.slope * over
    const t = over + this.halfKnee
    return this.slope * t * t / (2 * this.kneeDb)
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
    // The tracker's target: the loudest input sample heard so far.
    //
    // ⚠ THIS IS A RUNNING MAXIMUM WITH UNBOUNDED MEMORY, AND IT IS WHY THIS
    // STAGE CANNOT BE MADE PREVIEW/APPLY EXACT BY A PRE-ROLL. `trkInPeak` only
    // ever rises, so it carries the loudest sample of the entire preview
    // session, while an offline render sees only what it was handed. Measured
    // against a settled preview on an adversarial region (loud right up to the
    // boundary, then quiet), energy over the first 0.5 s:
    //
    //   pre-roll        0 s      0.5 s      1 s      2 s      4 s
    //   stock         -0.668    -0.253   -0.106   -0.022   -0.001
    //   attack/rel 1  -5.252    -1.784   -1.460   -0.998   -0.470
    //
    // A pre-roll helps a great deal and still does not converge; at the slowest
    // ballistics it is 0.47 dB out after four seconds, and the residue is
    // DATA-DEPENDENT — a loud passage anywhere earlier in the session raises
    // the preview's tracker and nothing the apply path renders can match it.
    //
    // OptoSmooth, Scheps and ResoTame all reach BIT-EXACT at 2 s because every
    // piece of their state is driven by the input and decays. The test that
    // separates them is simply: does anything LATCH, or does it all decay?
    // Tube Saturation fails it too (a sticky skew sign, a valley floor).
    //
    // Fixing this properly means giving the tracker a bounded reference — a
    // decaying peak, or a percentile over a window — which changes this
    // plugin's makeup behaviour and is a deliberate design decision, not a
    // pre-roll. No pre-roll is wired here for that reason.
    this.trkSamples += n
    for (let ch = 0; ch < nIn; ch++) {
      const src = inputChannels[ch]
      for (let i = 0; i < n; i++) {
        const a = src[i] < 0 ? -src[i] : src[i]
        if (a > this.trkInPeak) this.trkInPeak = a
      }
    }

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
      const levelDb = (rect > 1e-6 ? 20 * Math.log10(rect) : -120) + this.inputAlignDb
      const grTarget = this._grForOvershoot(levelDb - this.thresholdDb)

      // Attack pulls both stages toward their share of the target together;
      // release lets each stage decay at its own rate, which is what makes
      // recovery depend on how dense the program was.
      const gr = grMain + grTail
      if (grTarget > gr) {
        /**
         * \u26a0\u26a0 INDEXED ON THE TARGET, NOT ON THE CURRENT REDUCTION, AND THE
         * RELEASE SCHEDULE'S CHOICE IS WRONG HERE. At the START of every attack
         * the reduction is 0, whatever depth it is heading for, so a constant
         * indexed on the instantaneous value cannot express "a deeper settled
         * reduction attacks faster" — the deep case merely spends longer
         * climbing through the slow region and comes out RELATIVELY SLOWER.
         * Measured that way over the first 20 ms, the deep-to-shallow energy
         * ratio went 3.24 with the schedule on against 2.54 off: the opposite of
         * the law it was built from.
         *
         * `grTarget` is the depth the detector is heading for and is known on
         * the first sample, which is the quantity the reference's t63 actually
         * tracks. Release keeps the current-value indexing because there the
         * trajectory STARTS at the depth in question.
         */
        let ac = this.attackCoef
        if (this.attackScheduled) {
          let idx = (grTarget * (1 / RELEASE_LUT_STEP_DB) + 0.5) | 0
          if (idx < 0) idx = 0
          else if (idx >= this.attackLut.length) idx = this.attackLut.length - 1
          ac = this.attackLut[idx]
        }
        const delta = (grTarget - gr) * ac
        grMain += delta * this.mainFraction
        grTail += delta * this.tailFraction
      } else {
        /**
         * \u26a0 THE SCHEDULE IS INDEXED ON THE REDUCTION, WHICH IS FALLING, so the
         * constant shortens as the cell recovers and the trajectory is not an
         * exponential. That is the point \u2014 it is what produces a t63 that moves
         * with depth \u2014 and it is also why the fit for `k` cannot be a regression
         * on measured t63.
         */
        let rc = this.releaseCoef
        if (this.releaseScheduled) {
          let idx = (gr * (1 / RELEASE_LUT_STEP_DB) + 0.5) | 0
          if (idx < 0) idx = 0
          else if (idx >= this.releaseLut.length) idx = this.releaseLut.length - 1
          rc = this.releaseLut[idx]
        }
        grMain += (grTarget * this.mainFraction - grMain) * rc
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
      // ⚠ `gain[]` HOLDS `inputLin * cellGain` FOLDED TOGETHER, and the pre-cell
      // path needs them apart: the shaper sees the attenuator's output and the
      // cell follows it. Unfolding with `invInputLin` keeps the seam
      // interpolation and `lastGain` in the units they were already in, which
      // is a smaller change than splitting the array.
      const pos = this.fetPos
      let gCur = seamGain
      for (let i = 0; i < n; i++) {
        const gNext = gain[i]
        const step = (gNext - gCur) * invL
        for (let j = 0; j < L; j++) {
          const k = i * L + j
          const g = gCur + step * j
          let w
          if (!this.applyFet) w = hi[k] * g
          // preInput: the shaper sees the source, and the folded `inputLin *
          // cellGain` then applies as one multiply — the cheapest of the three.
          else if (pos === 2) w = this._shapeFet(hi[k]) * g
          else if (pos === 1) w = this._shapeFet(hi[k] * this.inputLin) * (g * this.invInputLin)
          else w = this._shapeFet(hi[k] * g)
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
        const wetUnity = w
        w *= outGain[i]
        // The dry side of the blend is the untouched input, delayed to meet the
        // wet side, so a parallel setting stays level-sane and phase-coherent
        // and bypass A/B compares like for like.
        const dry = dryLine.push(input[i])
        this._trackMakeup(dry, wetUnity)
        const mixed = dry * this.dryMix + w * this.wetMix
        out[i] = this.ceilingLin > 0
          ? softCeiling(mixed, this.ceilingLin, this.ceilingKneeLin)
          : mixed
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
    const pos = this.fetPos
    for (let i = 0; i < n; i++) {
      const dry = input[i]
      let w = dry * gain[i]
      if (this.applyFet) {
        const shaped = pos === 2
          ? this._shapeFet(dry) * gain[i]
          : pos === 1
            ? this._shapeFet(dry * this.inputLin) * (gain[i] * this.invInputLin)
            : this._shapeFet(w)
        dcY = shaped - dcX + this.dcR * dcY
        dcX = shaped
        w = dcY
      }
      const wetUnity = w
      w *= outGain[i]
      this._trackMakeup(dry, wetUnity)
      const mixed = dry * this.dryMix + w * this.wetMix
      out[i] = this.ceilingLin > 0
        ? softCeiling(mixed, this.ceilingLin, this.ceilingKneeLin)
        : mixed
    }
    this.dcX[ch] = dcX
    this.dcY[ch] = dcY
  }

  /** Forget what has played — see the LA-2A kernel's note of the same name. */
  resetAutoMakeupTracker() {
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkAAbs = 0
    this.trkBAbs = 0
  }

  /**
   * The makeup the audio heard so far asks for, dB, or null before anything has
   * been heard. Only knows what has PLAYED; APPLY keeps the offline solve.
   */
  liveAutoMakeupDb() {
    if (this.trkSamples < this.sampleRate * MAKEUP_TRACKER_WARMUP_S) return null
    /**
     * ⚠ FULLY WET ONLY. Below Mix 1 the bound `(P − max|a|)/max|b|` is safe but
     * loose — the two maxima need not fall on the same sample — and measured on
     * a hard probe it came out 3.35 dB under the truth at Mix 0.3. A preview
     * several dB quieter than the render it is previewing is worse than no live
     * value at all, so the parallel settings keep the offline solve, which is
     * one render and exact. Reported rather than hidden: the panel shows the
     * offline number there, which is the right one.
     */
    if (this.dryMix > 0) return null
    const P = this.trkInPeak
    if (!(P > 0) || !(this.trkBAbs > 0)) return null
    const g = (P - this.trkAAbs) / this.trkBAbs
    if (!(g > 0) || !Number.isFinite(g)) return null
    return 20 * Math.log10(g)
  }

  /**
   * One sample's contribution to the tracker.
   *
   * `wetUnity` is the wet path BEFORE the output gain, so nothing here depends
   * on the makeup — see the constructor for why that is the whole design.
   */
  _trackMakeup(dry, wetUnity) {
    const aAbs = Math.abs(dry * this.dryMix)
    if (aAbs > this.trkAAbs) this.trkAAbs = aAbs
    const bAbs = Math.abs(wetUnity * this.wetMix)
    if (bAbs > this.trkBAbs) this.trkBAbs = bAbs
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
 * ⚠ THE MAKEUP REFERENCE MOVED, AND SO DID THE ARGUMENT ABOUT IT. Both the peak
 * reference and the percentile-plus-ceiling pair that supersedes it live in
 * `dsp/makeupReference.js` now, shared with OptoSmooth, because they are one
 * mechanism and FET Punch failed in exactly the way that note describes: on
 * narration with one plosive, the Output knob ran BACKWARDS above Input ~80 —
 * auto makeup 9.99 / 9.12 / 8.23 / 7.32 dB at Input 70 / 80 / 90 / 100 for a
 * delivered rms of -13.47 / -13.44 / -13.51 / -13.73 dB. One uncompressed onset
 * pinned the reference for the whole file, so compressing harder delivered LESS
 * level. See `peakOfChannels` there for the whole of it.
 */

/**
 * RMS across every sample of every channel, optionally skipping a leading
 * stretch — see the counterpart in la2aProcessor.js for why.
 */
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
  return computeFET1176AutoMakeupPlan(channelData, sampleRate, params, options).makeupDb
}

/**
 * The makeup AND the ceiling that has to ship with it. See the note on
 * `peakOfChannels` in `dsp/makeupReference.js` for why they are one thing.
 *
 * `reference: 'peak'` (the default) is the one-render affine solve documented
 * above, unchanged, and returns `ceilingDb: null`: its guarantee is arithmetic
 * and there is nothing for a ceiling to catch. `reference: 'percentile'` gives
 * up that guarantee on purpose — it is what stops one plosive pinning the whole
 * file — and hands back `ceilingDb`/`ceilingKneeDb`, which put it back by
 * enforcement. There is no option that yields one without the other.
 *
 * ⚠ THE PERCENTILE SOLVE IS ALSO EXACT, AND FOR THE SAME REASON THE PEAK ONE
 * IS. The output is affine in the makeup — `out[i] = a[i] + b[i]·g`, with the
 * wet path independent of `g` — so neither reference needs a second render.
 * OptoSmooth's equivalent must iterate because its output valve sits AFTER the
 * makeup amp; nothing here does. At Mix 1 the percentile answer is closed form
 * (every sample scales with `g`, so the quantile does too); below Mix 1 the dry
 * sum breaks that proportionality and it is bisected on `g` instead — over the
 * knob's own travel, against the already-rendered wet path, so the cost is a
 * handful of O(n) passes and not a handful of renders. ⚠ ITERATING THE RENDER
 * HERE WOULD NOT CONVERGE: see the measured table above, where three passes at
 * Mix 0.3 came out 6.1 dB short.
 *
 * @returns {{makeupDb:number, ceilingDb:number|null, ceilingKneeDb:number|null}}
 */
export function computeFET1176AutoMakeupPlan(channelData, sampleRate, params = {}, options = {}) {
  const { minDb = -36, maxDb = 36, reference = 'peak' } = options
  if (reference !== 'peak' && reference !== 'percentile') {
    throw new Error(`unknown makeup reference: ${reference}`)
  }
  const NONE = { makeupDb: 0, ceilingDb: null, ceilingKneeDb: null }

  const inputPeak = peakOfChannels(channelData)
  if (inputPeak <= 0) return NONE

  const mix = clamp(params.mix ?? FET1176_KERNEL_DEFAULTS.mix, 0, 1)
  // Mix 0 is the dry signal: there is nothing to make up, and the solve below
  // would be unconstrained (every b[i] is zero).
  if (mix <= 0) return NONE

  /**
   * The wet path alone, at unity output gain. Taken at mix 1 so the render IS
   * `wet[i]`; mix feeds nothing but the final blend, so this changes no other
   * part of the kernel's behaviour.
   *
   * ⚠ IT IS RENDERED OVERSAMPLED — THE SAME WAY APPLY RENDERS IT — AND THAT WAS
   * NOT ALWAYS TRUE. This solve used to run `oversample: false`, which is a
   * cheaper and DIFFERENT algorithm from the one the timeline gets: the
   * oversampled path interpolates the gain across sub-samples and filters
   * through two halfbands, and on a transient it lands a lower peak. So the
   * makeup was solved against a render nobody hears, and the applied result
   * came out UNDER the target — measured on the narration-like fixture in
   * `liveMakeup.test.js`, **0.77 dB** of headroom left on the table, with the
   * live preview (which runs in the real oversampled path) reporting the higher
   * figure and apply delivering the lower one.
   *
   * ⚠ THE OLD `tanh` WAS HIDING IT: it squashed peaks hard enough that the two
   * paths agreed to 0.58 dB, just inside the test's 0.6 dB tolerance. The
   * measured polynomial that replaced it is nearly linear at these levels and
   * passes the difference straight through, which is what surfaced it.
   *
   * ⚠ AND THE LATENCY IS WHY IT WAS AVOIDED. Oversampled, the kernel delays by
   * `latencySamples`, and this solve pairs `dry[i]` with `wet[i]` sample for
   * sample — a 50-sample slip would compare a transient against the silence
   * before it. The input is padded by that many samples so the whole tail is
   * rendered, and the delay is dropped off the front.
   */
  const latency = new FET1176Kernel(sampleRate).latencySamples
  const padded = channelData.map(ch => {
    const out = new Float32Array(ch.length + latency)
    out.set(ch)
    return out
  })
  const { channelData: wetPadded } = processFET1176Buffer(padded, sampleRate, {
    // ⚠ THE SOLVE MEASURES WITHOUT THE CEILING, DELIBERATELY — the same reason
    // OptoSmooth's does. The ceiling is enforcement placed downstream of the
    // answer; measuring through it would fold the enforcement into the thing
    // being enforced, and `b[i]` would stop being the wet path at unity.
    ...params, outputGainDb: 0, mix: 1, ceilingDb: null, ceilingKneeDb: null,
  })
  const wet = wetPadded.map(ch => ch.subarray(latency))

  const dryMix = 1 - mix
  if (reference === 'peak') {
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
    if (!Number.isFinite(gMax) || gMax <= 0) return NONE
    // The peak reference needs no ceiling, so it needs no knee either.
    return { makeupDb: clamp(20 * Math.log10(gMax), minDb, maxDb), ceilingDb: null, ceilingKneeDb: null }
  }

  const inputRef = percentileOfChannels(channelData, MAKEUP_PERCENTILE)
  if (!(inputRef > 0)) return NONE

  /** The output at makeup `g`, written into scratch buffers the caller owns. */
  const scratch = wet.map(w => new Float32Array(w.length))
  const outAt = (g) => {
    for (let ch = 0; ch < wet.length; ch++) {
      const dry = channelData[ch]
      const w = wet[ch]
      const o = scratch[ch]
      for (let i = 0; i < o.length; i++) o[i] = dry[i] * dryMix + w[i] * mix * g
    }
    return scratch
  }

  let gainLin
  if (dryMix === 0) {
    /**
     * Closed form. Every sample is `b[i]·g`, so the quantile of magnitudes is
     * the quantile of `|b|` times `g` — one pass, no search, exact.
     */
    const wetRef = percentileOfChannels(wet, MAKEUP_PERCENTILE)
    if (!(wetRef > 0)) return NONE
    gainLin = inputRef / (wetRef * mix)
  } else {
    /**
     * Bisection over the knob's own travel. The quantile is monotone
     * non-decreasing in `g` once the wet share dominates, and the bracket is
     * the range the answer is allowed to land in anyway, so an answer pinned to
     * an end is the clamp doing its job rather than a failed solve. Sixteen
     * halvings of the travel land inside a thousandth of a dB.
     */
    let loDb = minDb
    let hiDb = maxDb
    for (let i = 0; i < 16; i++) {
      const midDb = 0.5 * (loDb + hiDb)
      const ref = percentileOfChannels(outAt(Math.exp(midDb * LN10_OVER_20)), MAKEUP_PERCENTILE)
      if (ref < inputRef) loDb = midDb
      else hiDb = midDb
    }
    gainLin = Math.exp(0.5 * (loDb + hiDb) * LN10_OVER_20)
  }

  const makeupDb = clamp(20 * Math.log10(gainLin), minDb, maxDb)
  const ceilingDb = 20 * Math.log10(inputPeak)
  /**
   * How far the un-ceilinged render actually overshoots, measured at the makeup
   * that ships — not estimated. The affine form gives it for one more O(n)
   * pass, where OptoSmooth has to carry a stale render forward.
   */
  const outPeak = peakOfChannels(outAt(Math.exp(makeupDb * LN10_OVER_20)))
  const outPeakDb = outPeak > 0 ? 20 * Math.log10(outPeak) : -Infinity
  return {
    makeupDb,
    // The guarantee, restated as a number the kernel can enforce: the source's
    // own peak.
    ceilingDb,
    // How soft that enforcement has to be, from how much there is to enforce.
    ceilingKneeDb: ceilingKneeDbFor(outPeakDb - ceilingDb),
  }
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
        // A new region is new material: the running extrema describe audio the
        // user has moved on from, so they are forgotten rather than diluted.
        else if (e.data?.type === 'resetMakeupTracker') this.kernel.resetAutoMakeupTracker()
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
        this.port.postMessage({
          type: 'gr',
          grDb: this.kernel.grDb,
          // The live auto-makeup, riding the ~46 Hz cadence the meter already
          // pays for. null until something has been heard.
          liveMakeupDb: this.kernel.liveAutoMakeupDb(),
        })
      }
      return true
    }
  }

  registerProcessor('fet1176-processor', FET1176WorkletProcessor)
}
