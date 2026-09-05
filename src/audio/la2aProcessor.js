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
 *    - Program-dependent attack, ~10 ms from a dark cell falling toward
 *      ~4.5 ms as it lights (not user-adjustable on the hardware). See
 *      ATTACK_DARK_S for what is measured and what is not.
 *    - Two-phase release of ONE reduction: a fast recovery handing over to a
 *      phosphorescent tail. ⚠ NOT a split of the reduction between two
 *      stages — that model left a pedestal on program material; see
 *      REL_FAST_S.
 *    - ⚠ No LDR memory integrator. Both reference units release identically
 *      across a 200x burst-length sweep; the photomemory shows up in the
 *      attack instead, and that is where this models it.
 *
 * 2. Program-dependent ratio
 *    - Compress mode: gentle, wide-knee curve whose effective ratio drifts
 *      from ~3:1 toward ~4:1 as the sidechain is driven harder.
 *    - Limit mode: narrower knee, ratio climbing from ~12:1 toward ~20:1.
 *    - There is no threshold control on the hardware: the Peak Reduction
 *      knob is sidechain amplifier gain, driving the signal into a fixed
 *      internal threshold. Modeled the same way here, with the knob-to-drive
 *      law fitted to a reference emulation — see SC_DRIVE_MAX_DB.
 *    - That threshold is anchored to nominal analog operating level
 *      (0 VU = -18 dBFS), not to digital full scale — see NOMINAL_DBFS.
 *
 * 3. Sidechain frequency mapping + tube stage
 *    - Sidechain: one-pole 80 Hz high-pass (the cell barely responds to
 *      rumble) plus the R37 pre-emphasis trimmer, which attenuates the
 *      side-chain below 1 kHz by up to 10 dB and so makes the unit
 *      progressively more sensitive to highs as it is turned down.
 *    - Output path: asymmetric tanh waveshaper approximating the harmonic
 *      profile of the input/driver/output tube stages (bias term → 2nd
 *      harmonic, tanh curvature → 3rd), followed by a DC blocker. FIXED, with
 *      no control over it — the hardware has none, and saturation follows the
 *      level arriving at the valves. See TUBE_DRIVE_LIN — and the ledger above
 *      it before trusting this stage for anything, because it rests on ONE
 *      measured point and the ledger is where that is said plainly.
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
 * signal than the raw defaults suggest, so the stage is driven hard exactly
 * when nobody has asked for distortion. ⚠ That is now the ONLY way it is
 * driven, the knob that used to scale it being gone: deep Peak Reduction plus
 * auto-makeup IS the overdrive path, which is what the hardware does too. At 44.1 kHz that measured
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

/**
 * ATTACK, PROGRAM-DEPENDENT — the T4 does not have one attack time.
 *
 * The cell is an electroluminescent panel lighting a cadmium-sulfide
 * photoresistor, and a CdS cell's speed depends on the light it has already
 * absorbed: one sitting in darkness responds sluggishly to a transient, one
 * already lit catches the next far faster. The familiar "about 10 ms" is an
 * average over that behaviour, not a time constant, and a fixed coefficient
 * cannot express it at any value.
 *
 * MEASURED, on a Waves CLA-2A capture (`npm run la2a:ballistics`,
 * `retrigger.wav`): the same test step, varying only how recently the cell was
 * lit, returns t63 of
 *
 *     gap 0.05 s -> 4.6 ms      gap 0.5 s -> 5.0 ms      gap 5 s -> 8.2 ms
 *
 * Shorter gap, faster attack. The direction is real: a FIXED-attack kernel run
 * through the identical harness returns 14.4 -> 11.4 ms over the same gaps, so
 * the measurement carries a +3.0 ms artefact of its OWN, in the OPPOSITE
 * direction (at a short gap the cell is still releasing, so the `rest` the fit
 * measures against is a moving target). The reference's -3.6 ms is therefore
 * about -6.6 ms of true spread, measured against that.
 *
 * ⚠ THESE TWO CONSTANTS ARE STILL NOT FITTED TO THAT CAPTURE, BUT THE REASON
 * HAS CHANGED — AND THE FIRST REASON WAS RIGHT. It used to be unfittable
 * outright: the cell state `gr/(gr + CELL_HALF_DB)` moved only 0.740 -> 0.489
 * across the gaps the test sweeps, because the old release left 2.4 dB standing
 * after a FIVE SECOND gap, and over a band that narrow the widest t63 ratio ANY
 * monotone speed-up law can produce is 1.51 against the 1.78 the reference
 * asks. Replacing the release split (see REL_FAST_S) widened the band to
 * 0.327 -> 0.782, a reachable 2.39, exactly as that prediction said it would.
 *
 * WHAT THE CAPTURE NOW SAYS, and why it is still not taken. Fitted through the
 * same harness the reference went through, the retrigger wants ATTACK_DARK_S
 * around 20-45 ms: at 10 ms the raw spread stays flat or slightly backwards,
 * and only a much slower dark end reproduces the reference's direction
 * (45/2.0/4.5 returns 4.8/5.0/5.8 ms against the reference's 4.6/5.0/8.2, still
 * missing the long gap by 2.4). Three things argue against taking it:
 *
 *   1. IT WOULD MAKE THE ORIGINAL BUG WORSE. A file that starts loud hits a
 *      fully dark cell, and that overshoot is where this whole investigation
 *      began. Peak in the first 50 ms above the settled level: 16.10 dB at
 *      10 ms, 16.52 at 20, 16.63 at 30, 16.77 at 45.
 *   2. IT BUYS NOTHING ON CREST. The release now does that work — crest change
 *      at 2/4/6/8 dB of reduction moves by under 0.3 dB across the entire
 *      20-45 ms range, so no acceptance criterion prefers it.
 *   3. THE DARK END IS STILL EXTRAPOLATED. Even widened, the test only reaches
 *      hNorm 0.327; a fully dark cell is never observed, and 45 ms is a
 *      two-point extrapolation through a reciprocal law far outside the data.
 *
 * SO THEY STAY ANCHORED to the reference's measured endpoints: 10 ms is the
 * published nominal and matches our behaviour from dark, 4.5 ms is the fastest
 * t63 the CLA-2A actually returns. A hardware capture, or any stimulus that
 * genuinely darkens the cell, is what settles this. Crest change vs dry on the
 * analog-unit dry Vox at matched median gain reduction, for the record:
 *
 *     GR                          2 dB     4 dB     6 dB     8 dB
 *     fixed 10 ms, old release   -0.37    +2.94    +5.02    +6.67
 *     10 / 4.5,    old release   -0.34    +2.96    +4.58    +5.49
 *     10 / 4.5,    new release   +0.19    +1.97    +2.98    +3.16
 *
 * ⚠ DO NOT CLOSE THE REMAINING GAP HERE EITHER. Under the old release, crest
 * alone was matched at ATTACK_LIT_S ~ 0.5 ms — an effective ~0.6 ms attack in
 * program, which is not an LA-2A at all and is flatly contradicted by the
 * 4.6-8.2 ms this same unit measures. That was the right number from the wrong
 * mechanism, and the release was the actual defect. It was.
 *
 * ⚠ THE HISTORY TERM IS THE CURRENT REDUCTION, NOT THE `memory` INTEGRATOR.
 * Tried `memory` first; it produced a spread in the wrong direction. See the
 * use site for why the current reduction is also the better physics.
 *
 * ⚠ COEFFICIENTS ARE BLENDED, NOT TIME CONSTANTS — and this one IS resolved by
 * measurement, so it is not merely the cheap option. Interpolating tau costs an
 * `exp` per sample and, at matched endpoints, does less: tau-blended 10/4.0
 * leaves +5.82 dB at 8 dB GR against +5.49 for coefficient-blended 10/4.5.
 * Blending coefficients puts more of the range near the lit end, which is where
 * program material actually sits — hNorm runs 0.73-0.87 on real speech, and
 * never approaches the dark end at all.
 *
 * WHY THIS IS NOT JUST "A FASTER ATTACK". A fixed attack fast enough to move
 * crest also clamps the transient the LA-2A is loved for letting through. On a
 * burst from 3 s of silence vs. the same burst 0.4 s after one (first 5 ms,
 * gain vs. input):
 *
 *                        from dark    already lit
 *     fixed 10 ms         -0.18 dB      -6.69 dB
 *     fixed  1 ms         -0.90 dB      -7.69 dB
 *     10 / 4.5            -0.18 dB      -6.86 dB
 *
 * The program-dependent cell keeps the dark onset intact — indistinguishable
 * from the 10 ms fixed attack — while catching the lit one harder. A fixed 1 ms
 * attack reaches further into the lit onset, but pays FIVE TIMES the dark-onset
 * cost to do it, and that first transient is the thing an LA-2A is chosen for.
 * ⚠ THE SECOND COLUMN DEPENDS ON THE RELEASE AND THESE NUMBERS MOVED WITH IT —
 * the gap here is 0.12 s, and under the old release the same test at 0.4 s read
 * -5.12 / -5.97 / -5.89. Faster recovery means less of the cell is still lit,
 * so the margin narrows with the gap; the ORDERING is the claim, not the size.
 */
export const ATTACK_DARK_S = 0.010
export const ATTACK_LIT_S = 0.0045

/**
 * RELEASE — ONE STATE RECOVERING FAST THEN SLOWLY, not two stages splitting the
 * reduction between them.
 *
 * ⚠ THE SPLIT THIS REPLACES WAS THE PLUGIN'S LARGEST SINGLE DEFECT, AND ITS
 * SIGNATURE WAS EXACT. The old model held `FAST_FRACTION` of the reduction in a
 * fast stage and the rest in a slow one, each decaying toward its OWN SHARE of
 * the target. At speech rates the slow stage cannot follow anything, so it
 * settles into a near-constant pedestal — reduction applied equally to loud and
 * quiet, doing nothing for peaks and pulling the body down. Only the fast
 * stage's share of the static curve ever reached program, and the measurement
 * said so to two figures: delivered slope / static slope came out at 68 %
 * against a `FAST_FRACTION` of 0.65. A reference capture delivers 105 %.
 *
 * THE PEDESTAL IS GONE BY CONSTRUCTION, not by retuning: there is one `gr`, it
 * always moves toward the target, and nothing owns a fixed fraction of it.
 *
 * MEASURED, on Waves CLA-2A `bursts.wav` (`npm run la2a:ballistics`) — gain
 * reduction remaining after the step down, normalised by the reduction at it:
 *
 *     ms        20     50    100    200    500   1000   2000   5000   fast%
 *     CLA-2A  .843   .695   .527   .345   .151   .084   .053   .017    47 %
 *     ours    .868   .708   .527   .333   .157   .094   .052   .010    47 %
 *     was     .735   .524   .402   .359   .334   .297   .236   .114    60 %
 *
 * The old row's STALL between 100 and 500 ms is the pedestal, visible directly.
 *
 * ⚠ ONE POLE WITH A SLIDING COEFFICIENT BEAT A BI-EXPONENTIAL ON THE SAME DATA,
 * which is why the structure is not simply the old one unstalled. Fitting both
 * to the curve above: a fixed-split bi-exponential reaches rms 0.0154, this
 * reaches 0.0104, and the gap is almost all in the tail (at 2 s it returns
 * 0.052 against the reference's 0.053, where the bi-exponential gives 0.035).
 * `REL_PHASE_S` is how quickly the cell hands over from its fast recovery to
 * the phosphorescent one; the coefficient, not the time constant, is blended,
 * for the reason given under the attack constants.
 *
 * ⚠ THE DOCUMENTED "50 % IN 50-60 ms" IS NOT WHAT THE UNIT DOES. It reaches
 * 50 % at about 110 ms, and REL_FAST_S is the measurement rather than the
 * folklore. Recorded because the old constants were built to hit the folklore.
 */
const REL_FAST_S = 0.130
const REL_SLOW_S = 1.800
const REL_PHASE_S = 0.260

/**
 * ⚠ THE LDR MEMORY INTEGRATOR IS GONE, AND BOTH REFERENCES KILLED IT. It
 * lengthened the release tail with exposure, over a 0.5-5 s range. Neither
 * reference does that: across a 200x burst-length sweep (0.05 s to 10 s) the
 * CLA-2A's release rows are identical to three figures and its fast% never
 * leaves 47 %, and LALA's rows are identical outright. Ours moved a lot — 0.114
 * against 0.010 remaining at +5 s over the same sweep — so the exposure
 * dependence was ours alone.
 *
 * ⚠ THE PHOTOMEMORY ITSELF IS NOT DENIED BY THIS, it has moved to where the
 * evidence actually puts it: the ATTACK, driven by the current reduction. That
 * is the same physical claim (a lit cell behaves differently from a dark one)
 * carried by a state that program material actually moves.
 *
 * CELL_HALF_DB is the reduction at which the cell counts as half-lit. It is the
 * old `MEM_HALF_DB` value in a new role, and unlike that one it is now FITTED —
 * see the attack constants.
 */
const CELL_HALF_DB = 2.5

// ── Sidechain constants ─────────────────────────────────────────────────────

const SC_HPF_HZ = 80

/**
 * R37 side-chain pre-emphasis.
 *
 * DIRECTION: THE PARAMETER RUNS THE WAY THE HARDWARE KNOB DOES. From the LA-2A
 * manual: "This potentiometer is factory set for a 'flat' side-chain response
 * (clockwise). Increasing the resistance of this potentiometer by turning it
 * counter clockwise will result in compression which is increasingly more
 * sensitive to the higher frequencies."
 *
 * So `r37` is 0-100 read as knob rotation: **100 is fully clockwise, flat, the
 * factory position and the default**; winding down toward 0 filters more low
 * end out of the side-chain, leaving the cell increasingly sensitive to highs.
 * It previously ran the opposite way as `emphasis`, with 0 meaning flat, which
 * inverted both the hardware and every reference plugin — the same number meant
 * opposite things in our panel and in anything we compared it against.
 *
 * MECHANISM: an ATTENUATOR of lows, not a booster of highs. On the hardware R37
 * is a trimmer in a passive network, and a passive network cannot boost:
 * "emphasis" is achieved by discarding low frequencies and letting the
 * side-chain amplifier make the level back up.
 *
 * That was modelled backwards too, until it was measured against a plosive. As
 * a high SHELF BOOST from unity it left the lows at full level, so sweeping it
 * moved the gain reduction on a 120 Hz thump by 0.06 dB — and upward, because
 * the Peak Reduction knob drives a FIXED internal threshold, so adding
 * side-chain gain adds compression. Attenuating instead gives the control
 * authority over the thing it exists to reject.
 *
 * Neither the 1 kHz corner nor the 10 dB depth is measured against hardware.
 */
const SC_SHELF_HZ = 1000
const SC_SHELF_MAX_DB = 10
/**
 * Rectifier smoothing. The T4 model supplies the real ballistics; this is only
 * meant to take the edge off the rectified waveform.
 *
 * ⚠ IT IS ALSO THE WHOLE OF OUR SIDE-CHAIN'S FREQUENCY RESPONSE, WHICH IS NOT
 * WHAT IT LOOKS LIKE, and `npm run la2a:ballistics -- --detector` prints the
 * evidence. The detector's MEAN output tracks SC_HPF_HZ exactly — to a
 * hundredth of a dB at every probe, so the filter does what it says. But the
 * ballistics do not read the mean, they ride the RIPPLE, and ripple collapses
 * as the probe rises past this corner: 13.5 dB at 100 Hz, 1.8 at 1 kHz, 0.4 at
 * 8 kHz. So the level the cell acts on FALLS with frequency (peak envelope
 * +0.78 / +0.27 / -0.56 / -1.07 dB at 200 / 400 / 1000 / 3000 against 100 Hz)
 * where the mean rises. Both reference units rise.
 *
 * ⚠ AND LENGTHENING IT TO FIX THAT WOULD BREAK THE DISTORTION MODEL, which is
 * why it has not been touched. `cellMod` is driven by `rect / env - 1` — the
 * same ripple — so a smoother envelope deepens the cell modulation that
 * CELL_MOD_MAX was fitted to hardware with. Measured at 6 dB of reduction on a
 * 220 Hz probe, 0.5 -> 5 ms:
 *
 *     side-chain tilt, 100-1000 Hz   +0.60 -> +1.37 dB   (references +1.50, +1.56)
 *     THD                             1.25 ->  2.28 %
 *     H3 - H2                        +22.9 -> +28.6 dB   (six hardware units: +25.7)
 *
 * It buys the tilt and pays with the one distortion relationship that ever
 * corroborated against hardware, and it was corroboration nobody aimed at.
 *
 * ⚠ SO THE QUESTION IS OPEN, AND IT IS ONE CAPTURE FROM BEING SETTLED. Either
 * this detector is about right and the references carry a real HF emphasis we
 * do not model — which belongs in the side-chain FILTER, where it is
 * independent of `cellMod` — or the detector is wrong and CELL_MOD_MAX absorbed
 * the error. ⚠ NOTE WE ALREADY MATCH BOTH REFERENCES BELOW 400 Hz, where
 * narration lives, and that the large divergence (LALA's +3.44 dB from 1 to
 * 3 kHz) rests on ONE reference: the CLA-2A frequency capture loses both its
 * 400 Hz and 3 kHz events to demo mutes. A clean one decides it.
 */
const DETECTOR_S = 0.0005

// Nominal operating level. The hardware's T4 threshold sits at line level
// (0 VU = +4 dBu), so Peak Reduction is referenced to that, not to digital
// full scale. Anchoring at 0 dBFS instead would make the cell ~18 dB deaf to
// normal program: narration at -20 dBFS RMS would need the knob near 95 to
// produce 3 dB of reduction. -18 dBFS is the EBU alignment.
const NOMINAL_DBFS = -18

/**
 * Peak Reduction knob → side-chain drive, in dB above NOMINAL_DBFS.
 *
 * FITTED TO A REFERENCE EMULATION, not chosen. Eight captures of one narration
 * clip through Analog Obsession's LAEA at knobs 20/30/40/56/70/80/90/100, with
 * its own +1.34 dB insertion gain removed. The three constants below reproduce
 * the reference's average gain reduction at all eight positions with an **rms
 * residual of 0.17 dB across 0–27 dB of reduction** — 0.04/0.26/2.47/9.40/
 * 14.93/18.98/22.92/26.88 dB measured, 0.00/0.36/2.61/9.05/15.05/19.15/23.03/
 * 26.70 reproduced.
 *
 * FITTED IN GAIN REDUCTION, NOT IN DRIVE, and that is not a presentational
 * difference. The first attempt fitted the knob→drive law against drive values
 * recovered by interpolating a coarse drive→GR table, and landed constants whose
 * end-to-end error was **0.68 dB with a systematic +1 dB bias above knob 70** —
 * every position in the upper half compressing harder than the reference. The
 * residual was small in the fitted quantity and wrong in the audible one. The
 * drive axis is now walked exactly instead of interpolated: drive and level add
 * in dB inside the gain computer (`over = levelDb + scDriveDb`), so scaling the
 * input at a fixed knob moves the operating point through the real kernel with
 * no probe hook and no interpolation.
 *
 * WHAT WAS WRONG BEFORE. The old law was `-2 + 40*(knob/100)^0.7`, giving 11 dB
 * of drive at knob 20 and 38 dB at knob 100. Two independent errors: it started
 * compressing far too early (the reference does nothing until about knob 25),
 * and it could not reach the top at all — the reference delivers 55 dB at knob
 * 100 against our 38, so our whole travel topped out at 13.3 dB of gain
 * reduction where it reaches 26.9 dB on the same clip.
 *
 * Anchored at the TOP rather than the bottom, because that is the end whose
 * value means something: SC_DRIVE_MAX_DB is the drive at knob 100 relative to
 * nominal line level. The span is how far the curve reaches below it, and at
 * this taper most of that span is spent below the threshold where nothing
 * happens — which is exactly the "nothing until 25, then it arrives quickly"
 * behaviour the reference has.
 *
 * CAVEAT: inverting through our own gain computer means these constants absorb
 * any difference between its knee and ratio and the reference's. They are a
 * behavioural match on average gain reduction, not a claim about the
 * reference's literal side-chain gain. Fitted on ONE clip; a second source
 * would be worth checking before treating the shape as settled.
 *
 * ⚠⚠ THE REFERENCE WAS THE WRONG UNIT. Analog Obsession ships TWO opto
 * compressors and only LALA is the LA-2A; LAEA is a different device. Every
 * capture behind these three constants is LAEA, so the knob-to-drive law the
 * whole plugin is calibrated through is fitted to something that is not an
 * LA-2A emulation. That also retires the "second source would be worth
 * checking" line above as an understatement: the FIRST source was wrong.
 *
 * ⚠ THESE CONSTANTS ARE COUPLED TO THE KNEE, AND THE COUPLING IS NOT OPTIONAL.
 * The fit targets T1 — the input level at which reduction reaches 1 dB — and
 * T1 = O1 - drive(knob), where O1 is the overshoot at which OUR curve reaches
 * 1 dB. Narrowing COMPRESS_KNEE_DB from 20 to 5 moved O1 from 0.83 to 4.56 dB,
 * which put the shipping taper 3.58 dB off the reference until it was re-fitted.
 * The SPAN barely moved (50.36 -> 49.89, the knob law's own slope); MAX absorbed
 * the shift. Change the knee and this must be re-run.
 *
 * THE RE-FIT IS BUILT AND SELF-TESTED, AND IS WAITING ONLY ON CAPTURES:
 * `npm run la2a:ballistics -- --stimulus` writes `ramp.wav`, a slow sweep that
 * reads the threshold directly instead of bracketing it between staircase
 * steps; capture it at five knob positions with the knob in the filename and
 * `-- --taper` fits these three constants to it. Run against our own kernel it
 * returns 36.24 / 105.87 / 0.4247 for a shipping 36.24 / 105.9 / 0.4247, rms
 * 0.003 dB, so the machinery is not the uncertainty — the reference is.
 *
 * ⚠ AND THE RE-FIT WILL TARGET THE THRESHOLD, NOT THE CURVE. Drive decides
 * where compression starts; the knee and ratio decide the shape above it.
 * Fitting a knob law to the shape is what let the first fit absorb errors it
 * could not name. Any knee disagreement will survive the re-fit, in the open.
 */
export const SC_DRIVE_MAX_DB = 26.93
export const SC_DRIVE_SPAN_DB = 49.89
/**
 * ⚠ EXACTLY 1: THE KNOB IS LINEAR IN dB OF DRIVE, 0.504 dB per unit. Pinning
 * the exponent to 1 fits the reference BETTER than leaving it free (rms 0.053
 * against 0.090 dB), so this is a measured shape and not a simplification.
 */
export const SC_TAPER = 1.0
export { NOMINAL_DBFS }

/**
 * Knob (0-100) to side-chain drive, dB above NOMINAL_DBFS. The one place the
 * law lives, so a re-fit changes it here and nowhere else.
 */
export function scDriveDbFor(peakReduction,
  maxDb = SC_DRIVE_MAX_DB, spanDb = SC_DRIVE_SPAN_DB, taper = SC_TAPER) {
  const knob = clamp(peakReduction, 0, 100) / 100
  return maxDb - NOMINAL_DBFS - spanDb * (1 - Math.pow(knob, taper))
}

/**
 * DC blocker corner, Hz — a one-pole `y = x - x[-1] + R*y[-1]` after the tube
 * stage. The asymmetric shaper rectifies, so it shifts the operating point and
 * the offset has to come back off before it reaches a peak measurement.
 *
 * ⚠ INHERITED, THEN DERIVED — AND IT SURVIVES. It was a bare `5` beside a tape
 * blocker at 2 Hz that had a measurement behind it. The two are NOT the same
 * filter — that one is a Butterworth BIQUAD, this is a naive one-pole — so its
 * constant never ported, and this one is now argued on its own evidence.
 *
 * MEASURED ON TWO REAL NARRATORS (`npm run dcblock:real`), sweeping this
 * constant against an exact bypass (`R = 1` telescopes to the signal itself,
 * leaving the oversampler, the ballistics and the shaper bit-identical):
 *
 *   corner   residual DC        peak shift          tilt after plosives
 *      2     -128 / -165 dBFS   -0.035 / -0.004 dB   -53.7 / -55.8 dBc
 *      5     -134 / -173 dBFS   -0.076 / -0.016 dB   -46.9 / -49.5 dBc
 *     20     -144 / -185 dBFS   -0.304 / -0.112 dB   -37.0 / -39.3 dBc
 *
 * REJECTION IS TOTAL AT ANY CORNER >= 1 Hz, so nothing here trades against the
 * job the filter does — the whole choice is how much of the passband to pay for
 * a margin that is already enormous. The DC to remove is -76 dBc through the
 * shipped tube stage, and -65 dBc when it is driven hard.
 *
 * PEAK SHIFT IS THE COLUMN THAT DECIDES IT, because protecting the peak
 * measurement ACX compliance is built on is what this filter is for. Moving
 * 5 -> 2 Hz buys 0.04 dB of peak on the worse file. That is two orders of
 * magnitude under anything a compliance check or a listener resolves, and not a
 * reason to move a shipped constant.
 *
 * ⚠ THE SYNTHETIC EVIDENCE THAT STARTED THIS OVERSTATED IT BY ~24 dB, AND IT
 * IS THE SEVENTEENTH TIME SYNTHETIC MATERIAL HAS FAILED TO ANSWER THE QUESTION
 * ASKED OF IT — this time by EXAGGERATING, as the HF Emphasis sweep did. A
 * gated 60 Hz burst put the tilt at -23 dBc at 5 Hz and made the corner look
 * consequential; real plosives put it at -47. A burst stopping dead into
 * digital silence maximises the filter's error against a vanishing local
 * signal, which is not a thing speech does.
 *
 * ⚠ AND NO WINDOW COULD HAVE FOUND MORE, WHICH IS WORTH KNOWING BEFORE ANYONE
 * RE-OPENS THIS. The blocker is linear and sits last, so with `y = H(wet)` the
 * error is exactly `(H - 1)(wet)` — the frequency response applied to the
 * output, with no mechanism for a transient artefact distinct from it. The
 * "tilt" column is therefore the same linear error as the `err` column measured
 * in a narrower window, which is why the two track each other at a constant
 * offset across every corner and both files. There is no separate phenomenon
 * here to go looking for.
 *
 * ⚠ THE dBc "COST" A NAIVE SWEEP REPORTS IS PURE PHASE ROTATION —
 * `20*log10(2*sin(phi/2))` reproduces it to the last digit at every corner — so
 * it is inaudible and is not evidence for anything. Recorded because it is the
 * first number a sweep produces and it looks like damage.
 *
 * ⚠ AND THIS FILTER BOOSTS, WHERE THE TAPE ONE PROVABLY CANNOT. A naive
 * one-pole `(1 - z^-1)/(1 - R*z^-1)` peaks at Nyquist at exactly `2/(1+R)` —
 * +0.0028 dB at this corner, inaudible, and it scales with the corner, so it is
 * a cost of RAISING it. `makeDcBlocker` is a Butterworth biquad precisely to
 * keep a "never boosts" guarantee; nothing here claims that guarantee.
 *
 * Stays at 5, now on evidence rather than by default. ⚠ Two narrators, one of
 * them already normalised; the margins are wide enough that a third is unlikely
 * to move it, but it is two.
 */
export const DC_BLOCK_HZ = 5

// ── Gain computer constants ─────────────────────────────────────────────────

/**
 * OUTPUT TUBE STAGE — a fixed 12AX7-shaped curve, driven by LEVEL alone.
 *
 * ⚠ THIS REPLACED A `tubeDrive` KNOB, AND THE KNOB WAS NOT A THING THE
 * HARDWARE HAS. An LA-2A has no saturation control: the T4 cell attenuates,
 * the Gain knob feeds a 12AX7 makeup amplifier, and how hard those triodes are
 * pushed is a consequence of the level arriving at them. A knob scaling the
 * curve's drive is a knob moving the LEVEL AT WHICH THE STAGE SATURATES, which
 * is a property of the valve and its supply, not of the operator.
 *
 * The gain dependence is already wired and always was: makeup is applied
 * BEFORE the shaper (`g = preG * makeupLinSmoothed`, as on the hardware), so
 * Gain drives the tubes, and compression backing the level off backs the
 * saturation off with it. What changes here is only that the reference is
 * fixed rather than user-set.
 *
 * THE CALIBRATION IS THE OLD DEFAULT, AND MEASUREMENT IS WHY IT SURVIVED
 * RATHER THAN INERTIA. THD against level through this curve, at the knob's
 * old default and at its top:
 *
 *   peak dBFS   rel nominal    THD @ 0.30 (kept)    THD @ 1.00 (was reachable)
 *      -18          0 dB            0.27 %                2.16 %
 *      -12         +6 dB            0.58 %                4.25 %
 *       -6        +12 dB            1.40 %                8.25 %
 *        0        +18 dB            4.01 %               16.23 %
 *
 * The LA-2A's own spec is under 0.5% THD at nominal, so the old default is the
 * one position on that knob that lands on the hardware, and everything above it
 * was a valve nothing ever built. Keeping it means the stock patch is
 * BIT-IDENTICAL and Scheps (which pinned 0.3) does not move either.
 *
 * The two numbers are stated in linear form for that bit-identity; their
 * physical readings are the comments. The curve is `tanh(d*x + b)`, normalised
 * to unity small-signal gain, so H2 dominates at low level and H3 overtakes it
 * around -6 dBFS — the triode ordering — and it stays memoryless and strictly
 * monotone, which is what lets both auto-makeup paths invert it in closed form.
 *
 * ⚠⚠ SUPERSEDED IN PREMISE BY A HARDWARE STUDY — THIS STAGE IS MODELLING THE
 * WRONG PART OF THE UNIT, AND THE CONSTANTS BELOW ARE NOT THE FIX.
 * A. Moore, "Objective Analysis and Perceptual Evaluation of LA-2A Compressors
 * and Vocal Recordings," J. Audio Eng. Soc. 74(1/2):61-72 (2026),
 * doi:10.17743/jaes.2022.0240 — six hardware units, three vintage Teletronix
 * and three UA reissues, THD measured at five tones (63 Hz-1 kHz) with +4 dBu
 * in and 6 dB of gain reduction. Its findings against ours, at that same
 * operating point (1 kHz, -18 dBFS in, our Peak Reduction 54 for 6 dB GR):
 *
 *                        THD      H3 - H2
 *   six real units    0.94-4.22 %   +16 to +44 dB   (median 2.19 %, +25.7)
 *   this model          0.132 %     -16.3 dB
 *
 * Three separate errors, and only the first is a constant:
 *   1. MAGNITUDE — we are ~17x too clean at the normal operating point.
 *   2. ORDER BALANCE — hardware is ODD-dominant (H3 well above H2); we are
 *      EVEN-dominant here, because TUBE_BIAS exists to make H2. That is a
 *      42 dB error in H3/H2, and no value of these two constants fixes it: a
 *      biased tanh cannot be strongly odd-dominant and still be biased.
 *   3. DIRECTION AGAINST COMPRESSION — measured on this kernel, THD falls
 *      0.271 / 0.132 / 0.063 / 0.030 % across 0 / 6 / 13 / 24 dB of gain
 *      reduction. The hardware RISES, from the <0.5 % no-GR spec to 0.94-4.22 %
 *      at 6 dB GR. Ours falls because the cell backs the level off before the
 *      valves see it, which is a correct consequence of putting the
 *      nonlinearity in the output stage — and the paper says that is the wrong
 *      place: "the primary contributor to THD during GR is likely the T4
 *      electro-optical attenuator... the Class A valve stages (typically 12AX7
 *      and 12BH7) are generally operated near their most linear region in this
 *      topology and are therefore unlikely to be the dominant source of
 *      distortion."
 *
 * THE FIX WAS STRUCTURAL AND IT SHIPPED. The distortion now lives with the gain
 * cell, scales with gain reduction, and is odd-dominant: `cellMod`, below. The
 * tube stage stays — the paper does not say the valves are linear, it says they
 * are not DOMINANT — and it was recalibrated against the paper's H2 column
 * alone (see TUBE_DRIVE_LIN), which is the only thing it is still responsible
 * for. Measured at the paper's own operating point after the change — a
 * nominal-level tone at 6.0 dB of gain reduction, the knob solved for that
 * rather than assumed:
 *
 *                        THD      H3 - H2
 *   six real units    0.94-4.22 %   +16 to +44 dB   (median 2.19 %, +25.7)
 *   this model        1.34-2.13 %   +24.4 to +30.9   (median 1.54 %, +25.4)
 *
 * and the direction is right: at Gain +12 into a -12 dBFS tone, THD across
 * Peak Reduction 0 / 40 / 70 / 90 now runs 0.84 / 1.28 / 2.04 / 2.09 %, where
 * the valves ALONE run 0.84 / 0.46 / 0.12 / 0.09. The dip the valves alone show
 * is what an output-stage nonlinearity must do; the sum rising is the cell.
 * `test/dsp/la2aTube.test.js` pins all of it.
 *
 * ⚠ THE <0.5 % SPEC ARGUMENT NOW APPLIES TO THE RIGHT STAGE. That figure is
 * the unit with NO gain reduction, where the paper agrees the valves are nearly
 * linear and the cell modulation is absent by construction — so it is a valid
 * check on the tube stage and was never a valid check on the whole unit under
 * compression, which is how it came to justify a value 5.5 dB hot on H2.
 *
 * ⚠ STILL NOT MEASURED AGAINST HARDWARE DIRECTLY. The THD figures above are of
 * our own kernel; the paper's are of six units, and no capture of ours has been
 * taken on a bench beside one.
 *
 * ⚠ AND THE REFERENCE EMULATION CANNOT SUPPLY IT — measured, and it is not a
 * near miss. Analog Obsession's LAEA, the same plugin the side-chain taper was
 * fitted to, has NO output-stage saturation at all. Captured per
 * docs/la2a_tube_capture_protocol.md at 96 kHz / 32-bit float:
 *
 *   Peak Reduction 0, Gain 0, input -40 / -30 / -1 dBFS: perfectly linear at
 *   every level — unity gain to -0.00003 dB and a fixed 0.1481 deg phase shift
 *   (a ~2.6 Hz DC blocker), IDENTICAL across all 39 dB, with the whole
 *   difference from the source tone sitting at the fundamental and harmonics at
 *   the DFT's own numerical floor.
 *
 *   Peak Reduction 0, Gain 80 (+24.29 dB): output at +6.29 dBFS — ABOVE digital
 *   full scale — and still 0.0000 % THD. It is `tone x 16.3783` plus that same
 *   phase shift, to -51.7 dBc. Our curve at the same operating point asks for
 *   11.81 %.
 *
 * So its Gain knob is a clean linear multiply and there is no valve behind it.
 * (Its Peak Reduction does do real gain reduction — 24.9 dB measured — with
 * about 0.06 % of ODD-order content, which is the cell's detector ripple
 * modulating the gain, not a saturator: a steady tone through a compressor
 * whose detector ripples at 2f puts sidebands at f and 3f.)
 *
 * Second time this reference has been asked for a control it does not have —
 * see the R37 note above, where the knob taken for the emphasis trimmer was a
 * mix control. The capture tooling stays (`npm run la2a:tube:tones` /
 * `la2a:tube:fit`) and is correct; it is waiting on a reference that models the
 * output stage, or on a bench measurement of a real unit.
 */
/**
 * THE T4 CELL'S GAIN MODULATION — the LA-2A's DOMINANT distortion mechanism,
 * per the paper quoted above, and the reason this plugin's THD now rises with
 * compression instead of falling.
 *
 * The gain the cell applies is not perfectly smooth: it ripples with the
 * signal's own instantaneous level around the envelope the detector has
 * smoothed. On a steady tone at f the detector ripples at 2f, and a carrier at
 * f multiplied by a 2f ripple puts sidebands at f and 3f — ODD content, which
 * is what the hardware shows and what a biased tanh structurally cannot make.
 * It costs one `exp` per base-rate sample; measured, 4.8 % of the kernel.
 *
 * DEPTH SATURATES IN GAIN REDUCTION, and that is derived rather than chosen. A
 * depth linear in grDb hits the paper's operating point and then runs away —
 * 9.3 % THD by 24 dB of reduction, far outside anything measured. These two
 * constants put the model inside the six units' band at the one depth anyone
 * measured and keep it there. Measured on a 200 Hz tone at -18 dBFS, Gain 0:
 *
 *   Peak Reduction     0     30     54     70     85    100
 *   gain reduction  0.00   0.05   7.02  14.05  19.89  25.16 dB
 *   THD             0.090  0.092  1.509  1.943  2.055  2.092 %
 *   H3 - H2        -21.6  -13.2   +30.8  +40.7  +48.2  +56.2 dB
 *
 * against six real units at 6 dB GR: 0.94-4.22 % THD (median 2.19), H3 sitting
 * +16 to +44 dB over H2 (median +25.7). ⚠ PR 54 IS NOT THE PAPER'S OPERATING
 * POINT — it is 7.02 dB of reduction here, not 6.00, and this table is a sweep
 * rather than the comparison. The like-for-like figure is on TUBE_DRIVE_LIN,
 * where the knob is solved per frequency for 6.0 dB: THD 1.39 %, H3-H2 +29.0.
 * Reading a sweep row as the operating point is the error that put the drive
 * constant 4 dB hot for a release.
 *
 * ⚠ IT IS CALIBRATED AT ONE DEPTH, AND THE TOP OF THE TRAVEL IS EXTRAPOLATION.
 * The paper measures 6 dB of gain reduction and nothing else, so the saturation
 * law is a shape chosen to be well-behaved past the data, not a fit to it. By
 * 20 dB of reduction the order balance runs well past the six units' spread
 * (+48 and +56 against a +44 maximum) — outside the measured range in a regime
 * nobody measured, which is a statement about the evidence, not a defect that
 * can be tuned away without more of it. The margin WIDENED when the drive was
 * re-derived, because a quieter tube stage lowers H2 without touching the
 * cell's H3; nothing about the cell changed.
 *
 * ⚠ A WAVESHAPER AT THE CELL WAS TRIED FIRST AND IS GONE. Same placement, same
 * saturating depth law, but bending the waveform instead of modulating the
 * gain. It hit the paper's numbers at 6 dB GR exactly — 2.15 % THD, H3-H2
 * +25.3 dB — and was rejected by ear twice, at two different depth laws.
 *
 * The reason is measurable and is why it is not coming back: a memoryless
 * waveshaper distorts every pair of partials against every other, so on speech
 * it ran 11.1 dB HOTTER than its own tone-THD figure predicted (tone 5.27 %,
 * speech 18.9 %). This mechanism measures -6.7 dB on the same test. Tone THD
 * cannot tell the two apart; program material can, which is the reusable half.
 */
const CELL_MOD_MAX = 0.1225
const CELL_MOD_TAU_DB = 5.505


/**
 * ── WHAT THIS STAGE RESTS ON ────────────────────────────────────────────────
 *
 * The two constants below each carry their own provenance. This is the thing
 * neither of them can say alone: what the tube stage as a whole is validated
 * against, and what it is not. It exists because the notes below were each
 * individually careful and TWO BAD PREMISES STILL SURVIVED A RELEASE — a fit
 * run at an operating point nobody re-derived, and an H3 column read as H2 —
 * which is what happens when every constant is documented and the stage is not.
 *
 * ⚠ THE HEADLINE: ONE EXTERNAL ANCHOR AND ONE ONE-SIDED BOUND. Everything else
 * about this stage — how its distortion scales with level, with frequency,
 * where it saturates, what it does when driven hard — is unconstrained by any
 * measurement. Do not read the detail below as saying more than that.
 *
 * VALIDATED, against something outside this model
 *
 *   1. THAT THE STAGE SHOULD BE SMALL. Moore, JAES 74(1/2):61-72 (2026), names
 *      the T4 attenuator and not the valves as the primary THD contributor
 *      during gain reduction. Qualitative, and the architecture reflects it:
 *      the cell carries the odd content, the valves the small even.
 *
 *   2. H2 MAGNITUDE, AT EXACTLY ONE OPERATING POINT. Mean -63.80 dBc against
 *      the median of the paper's 30 measurements, at nominal in / 6.0 dB gain
 *      reduction / Gain 0. THIS IS THE ONLY QUANTITATIVE ANCHOR THE STAGE HAS.
 *      Reproducible: `npm run la2a:h2:refit`. Pinned by la2aTube.test.js, which
 *      solves for the operating point rather than assuming a knob position.
 *
 *   3. THE <0.5 % NO-COMPRESSION SPEC. 0.128 % at true nominal with the cell
 *      idle. ⚠ ONE-SIDED — it is a ceiling, and the superseded 0.7 drive passed
 *      it too at 0.271 %. It rules out gross error and nothing finer.
 *
 *   4. A NEGATIVE RESULT, AND IT IS A REAL ONE. The reference emulation has no
 *      output stage at all (see the LAEA note above). That is why
 *      docs/la2a_tube_capture_protocol.md is complete and unused: the tooling
 *      is verified end to end against synthetic captures and is waiting on a
 *      reference that models the stage, or on a bench.
 *
 *   ⚠ CORROBORATION IS NOT VALIDATION. With the cell running, THD 1.34-2.13 %
 *   and H3-H2 +24.4 to +30.9 dB land inside the six units' bands at every
 *   frequency, and neither was a fit target. Worth something — but those are
 *   mostly the CELL's numbers with this stage supplying the H2 denominator, so
 *   they are weak evidence about the valves alone.
 *
 * NOT VALIDATED
 *
 *   1. TUBE_BIAS, and therefore the even/odd split within this stage. One
 *      target, two constants; see its own note.
 *
 *   2. H2 VERSUS LEVEL — THE MOST LOAD-BEARING GAP. The model asserts 1 dB per
 *      dB because that is what a tanh's second-order term does. ONE level has
 *      ever been compared to hardware. Everything audible about "Gain drives
 *      the valves" rides on an unmeasured slope — including the extra makeup
 *      the lookahead control asks for, which is the one path that routinely
 *      pushes this stage somewhere nothing has checked.
 *
 *   3. H2 VERSUS FREQUENCY. The model is nearly flat, -63.5 to -64.5 dBc from
 *      63 Hz to 1 kHz, and structurally so: a memoryless shaper has no
 *      frequency dependence, so the little spread there is comes from the
 *      side-chain changing the level reaching it. The paper measured five
 *      frequencies but only the median ACROSS ALL 30 is transcribed here, so
 *      per-frequency hardware H2 is unknown. If real units tilt with frequency,
 *      this stage cannot express it and nothing here would notice.
 *
 *   4. THE KNEE, +12.4 dBFS. No hardware data of any kind. It moved 4 dB as a
 *      side effect of the H2 re-fit — a free rider on a fit that never targeted
 *      it — and it is load-bearing, being what stops auto-makeup running away.
 *
 *   5. BEHAVIOUR UNDER HEAVY DRIVE. +24 dB into the stage is extrapolation. The
 *      (bias, drive) pairs that all satisfy the anchor span 9 dB of H2 there,
 *      so the answer in that regime is a consequence of the inherited bias.
 *
 *   6. THE CURVE SHAPE. `tanh` is a modelling choice. At one operating point
 *      nothing distinguishes it from any other odd shaper with a bias term.
 *
 *   7. THE TOPOLOGY. Makeup before the shaper is argued from the hardware's
 *      signal flow, not measured.
 *
 *   8. H3 AND H4 FROM THIS STAGE. Never fitted, never measured, and effectively
 *      arbitrary while the bias is.
 *
 *   9. NO COMPARISON TO A REAL UNIT HAS EVER HAPPENED. The paper's figures are
 *      of six units; every figure in this repo is of our own kernel.
 *
 *  10. THE -63.80 TARGET ITSELF. The paper's per-unit table is not transcribed,
 *      so the median cannot be recomputed here. The one number taken on trust.
 *
 * ⚠ MOST OF THE TUBE TESTS ARE SELF-CONSISTENCY, NOT VALIDATION. They assert
 * DIRECTIONS — THD rises with level, falls with Peak Reduction, the cell adds
 * odd and not even. Exactly two compare against an external number: the H2
 * median test and the <0.5 % spec test. Adding a test does not move a row from
 * the second list to the first; only a measurement does.
 *
 * WHAT WOULD BUY THE MOST, IN ORDER
 *
 *   1. A bench capture of a real unit. The protocol is written and the tooling
 *      verified. Unblocks 2, 3, 4 and 6 at once.
 *   2. Transcribe the paper's H4 column. H4 is even, so it is this stage's too,
 *      and it pins the (drive, bias) pair outright — closing 1 with no new
 *      measurement, only a trip to the paper.
 *   3. Transcribe the per-unit, per-frequency H2. Turns one median into a
 *      spread and makes 3 and 10 testable.
 *
 * ── end ledger ──────────────────────────────────────────────────────────────
 */

/**
 * DERIVED AGAINST THE H2 COLUMN, which is the only thing this stage is now
 * responsible for. The T4 cell modulation supplies the odd content (see
 * CELL_MOD_MAX); the valves supply the small even component, which is what the
 * paper says they do and what nothing else in the model can make — measured,
 * the cell modulation adds even content of 0.0 to 0.2 dB at every frequency,
 * i.e. none at all.
 *
 * ⚠ THE DERIVATION IS A SCRIPT, NOT THIS COMMENT: `npm run la2a:h2:refit`
 * reports at the shipping value, `-- --fit` re-solves. It exists because the
 * previous derivation lived only in prose, could not be re-run, and two of its
 * premises did not survive being checked — see below. Re-run it rather than
 * trusting this paragraph.
 *
 * Target: the median of all 30 of the paper's H2 measurements, -63.80 dBc, at
 * the paper's operating point — a nominal-level tone (NOMINAL_DBFS, standing in
 * for its +4 dBu) with the knob solved PER FREQUENCY for 6.0 dB of gain
 * reduction, because the 80 Hz side-chain high-pass makes one knob position
 * produce different reduction at 63 Hz and at 1 kHz. Fitted at 44.1 kHz, the
 * rate the app processes at, across every frequency the record names.
 *
 * At 0.2388 the model gives a mean H2 of -63.80 dBc, spanning -64.44 at 63 Hz
 * to -63.91 at 1 kHz. With the cell modulation running — the shipping path, and
 * the configuration the paper's other two columns describe — THD lands
 * 1.34-2.13 % and H3-H2 +24.4 to +30.9 dB at those same points, inside the six
 * units' 0.94-4.22 % and +16 to +44 dB at every frequency. Neither of those was
 * fitted; H3-H2 moving toward the paper's +25.7 median is corroboration, not a
 * target that was aimed at.
 *
 * ⚠ IT REPLACED 0.381, WHICH WAS FITTED AT THE WRONG OPERATING POINT. That
 * derivation recorded "Peak Reduction 54 for 6 dB GR". PR 54 produces 8.4 dB at
 * 1 kHz and 9.2 dB at 250 Hz; 6 dB lands near PR 48. Fitting with ~2.5-3 dB too
 * much reduction means the valves saw that much less level, so the drive that
 * hit the target there was hot at the paper's real operating point — measured,
 * 0.381 gives a mean H2 of -59.78 dBc against the -63.80 target, 4.02 dB hot.
 *
 * ⚠ AND THE REASON IT USED ONLY TWO FREQUENCIES DID NOT HOLD. It excluded the
 * low tones because "the compressor's OWN gain ripple swamps H2" there, quoting
 * -47 to -50 dBc with the tanh bypassed. Bypassed, H2 at those frequencies
 * measures -83 to -88 dBc — 25 to 55 dB BELOW the tanh's own contribution, not
 * above it. What sits at -51 to -66 dBc bypassed is H3, the detector ripple
 * doing exactly what the note on CELL_MOD_MAX describes: a 2f ripple on an f
 * carrier lands at f and 3f, odd content. H3 was read for H2. The refit script
 * prints that comparison on every run, so the claim stays falsifiable.
 *
 * ⚠ BEFORE THAT IT WAS 0.7, FITTED TO A DIFFERENT QUANTITY AGAIN — the LA-2A's
 * <0.5 % THD spec, a TOTAL-THD figure from a time when this stage was the
 * plugin's only distortion. Wrong target once the cell carries the odd content.
 *
 * ⚠ THE -63.80 TARGET IS THE ONE NUMBER STILL TAKEN ON TRUST. This repo has no
 * copy of the paper's per-unit table, so the median cannot be recomputed here.
 * Everything else above is measured by the script.
 *
 * The knee moves with the drive, +8.4 dBFS to +12.4 dBFS (26.4 to 30.4 dB above
 * nominal), so the valves saturate later. They still saturate, which is what
 * stops the makeup running away the way LAEA's does.
 */
export const TUBE_DRIVE_LIN = 0.2388 // knee at +12.4 dBFS, i.e. 30.4 dB above NOMINAL_DBFS

/**
 * ⚠ CHOSEN, NOT FITTED, AND INHERITED FROM A CONTROL THAT NO LONGER EXISTS.
 *
 * H2 for a biased tanh goes as drive^2 * tanh(bias) at the drives this stage
 * runs at, so the -63.80 dBc target above defines a CURVE in
 * (TUBE_DRIVE_LIN, TUBE_BIAS) rather than a point. One target, two constants:
 * the fit solves for the drive with this one held. Pairs that all land on the
 * target at the paper's operating point, measured:
 *
 *     bias    drive      H3          H2 under +24 dB of makeup
 *     0.02    0.725      -69.2 dBc    -42.9 dBc
 *     0.06    0.239      -88.3 dBc    -35.3 dBc
 *     0.40    0.038     -125.3 dBc    -33.8 dBc
 *
 * So this constant decides everything about the stage EXCEPT the quantity that
 * was fitted. The H3 column is the cell's job now and its spread here is moot;
 * the last column is not, and it is the regime auto-makeup pushes the valves
 * into.
 *
 * WHERE 0.06 CAME FROM. It is the removed Tube Drive knob's default position,
 * frozen. Before the knob went this read `tubeBias = 0.2 * amount` with
 * `amount` the knob, default 0.3 — so 0.2 x 0.3 = 0.06, and neither the 0.2 nor
 * the 0.3 has a derivation anywhere in the history. It survives on the strength
 * of the fit landing inside the paper's other two columns with it held, which
 * is evidence that it is not badly wrong and is not a derivation.
 *
 * WHAT WOULD SETTLE IT: a second measured even-order quantity, H4 being the
 * obvious one — it is even, so it is the valves' too, and it would pin the pair
 * outright. The paper's H4 column is not transcribed in this repo.
 */
export const TUBE_BIAS = 0.06 // operating-point offset, 4.2% of the linear range

/**
 * COMPRESS-MODE KNEE, MEASURED — and it was the larger of the two errors in the
 * static curve, bigger than the ratio.
 *
 * Fitted to two LA-2A emulations' ramp captures (`npm run la2a:ballistics`), a
 * three-parameter soft-knee model against a continuous sweep, rms 0.017-0.078 dB:
 *
 *   LALA    knob 60 / 75 / 90 : ratio 1.98 / 1.98 / 2.00 : 1, knee 1.0 / 1.0 / 2.0 dB
 *   CLA-2A  knob 60 / 75      : ratio 4.08 / 3.92 : 1,       knee 6.5 / 5.0 dB
 *
 * So the references bracket the knee at 1-6.5 dB where this constant was 20 —
 * three to twenty times too wide. A knee that wide is most of why our delivered
 * gain-reduction slope on program came out at two thirds of our own static
 * curve: at moderate drive the operating point never leaves the knee, so the
 * ratio above it never applies.
 *
 * 5 dB sits inside the measured band and near CLA-2A's, which is the reference
 * whose ratio was adopted below. It is NOT itself a fitted value — the two
 * references disagree by 6x on this constant as they do on everything else, so
 * it is a choice inside a measured range, which is the most that data supports.
 */
const COMPRESS_KNEE_DB = 5
const LIMIT_KNEE_DB = 6

const LN10_OVER_20 = Math.LN10 / 20

export const LA2A_KERNEL_DEFAULTS = {
  mode: 'compress', // 'compress' | 'limit'
  peakReduction: 50, // 0–100, sidechain drive (hardware Peak Reduction knob)
  gainDb: 0, // makeup gain (hardware Gain knob)
  /**
   * Output tube stage. There is no user control over it — saturation follows
   * level, see TUBE_DRIVE_LIN. This exists so measurement code can difference
   * the stage against itself, the same role `oversample` plays below; nothing
   * in the app sets it.
   */
  tube: true,
  /**
   * T4 cell gain modulation depth, 1 being the calibrated value. A measurement
   * bypass rather than a control — nothing in the app sets it, and 0 recovers
   * the pre-cell build for differencing. See CELL_MOD_MAX.
   */
  cellMod: 1,
  r37: 100, // 0–100 side-chain pre-emphasis, as knob rotation: 100 = flat (factory)
  mix: 1, // wet/dry blend
  /**
   * Run the gain cell and tube stage oversampled. Always true for anything
   * anyone listens to; see `computeAutoMakeupDb` for the one caller that turns
   * it off and why that is sound.
   */
  oversample: true,
  /**
   * Lookahead, in milliseconds. 0 (the default) is the hardware.
   *
   * See LOOKAHEAD_MAX_MS for what it is for and what it costs.
   */
  lookaheadMs: 0,
}

/**
 * Lookahead ceiling, milliseconds.
 *
 * WHAT IT IS. The audio path is delayed; the side-chain is not. Nothing else
 * changes — not the detector, not the static curve, not the T4's ballistics.
 * The gain envelope is bit-identical at every depth, which
 * was verified before this shipped. Only WHEN that envelope meets the audio
 * moves, so a transient arriving at the cell is met by the gain the cell would
 * otherwise have reached `lookaheadMs` later.
 *
 * WHY IT EXISTS. ATTACK_S is 10 ms, so the first ~20 ms of every onset out of
 * silence passes at 6-12 dB less reduction than the surrounding program. That
 * is the T4 and it is wanted. What is not wanted is what it does to
 * `computeAutoMakeupDb`, which is peak-referenced by construction (see
 * `peakOfChannels`): one un-compressed onset sets the reference for the whole
 * file, so the makeup comes out small and the compressor ends up REDUCING
 * average loudness while INCREASING crest factor. Measured on a synthetic
 * narration signal at Peak Reduction 70, peak-matched: -5.8 dB rms and +5.8 dB
 * crest against the source, with the binding peak the file's FIRST SYLLABLE.
 *
 * The same table, sweeping this control:
 *
 *     lookahead   makeup    d-rms    d-crest
 *     0 (off)     +10.10    -5.81     +5.81
 *     5 ms        +12.93    -3.78     +3.78
 *     10 ms       +15.23    -1.87     +1.87
 *     20 ms       +16.94    -0.65     +0.65
 *     40 ms       +18.28    +0.58     -0.58
 *
 * ⚠ THE CEILING IS WHERE PRE-DUCK BECOMES THE PROBLEM, not where the numbers
 * stop improving — and the two point opposite ways, which is why the ceiling is
 * argued rather than maximised. The gain starts falling `lookaheadMs` BEFORE the
 * onset that caused it. At 40 ms that is an audible suck into every hard
 * consonant, and the table above shows it is already over-correcting there:
 * crest below the source means the compressor has become a transient designer.
 * 20 ms keeps the correction one-sided.
 *
 * ⚠ IT IS OFF BY DEFAULT AND MUST STAY OFF BY DEFAULT. An LA-2A has no
 * lookahead, the transient pass-through is the instrument, and every preset and
 * every rendered file that predates this control was made without it.
 */
export const LOOKAHEAD_MAX_MS = 20

// Gain-knob smoothing time — the same 8 ms the soft clipper and FET Punch use.
const MAKEUP_SMOOTH_MS = 8

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

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass (the slow
 * release coefficient refreshes once per block, so keep blocks <= a few ms —
 * the 128-sample render quantum is ideal).
 */
export class LA2AKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate

    this.attackCoefDark = 1 - Math.exp(-1 / (sampleRate * ATTACK_DARK_S))
    this.attackCoefLit = 1 - Math.exp(-1 / (sampleRate * ATTACK_LIT_S))
    this.relFastCoef = 1 - Math.exp(-1 / (sampleRate * REL_FAST_S))
    this.relSlowCoef = 1 - Math.exp(-1 / (sampleRate * REL_SLOW_S))
    this.relPhaseCoef = 1 - Math.exp(-1 / (sampleRate * REL_PHASE_S))
    this.detCoef = 1 - Math.exp(-1 / (sampleRate * DETECTOR_S))
    this.hpfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_HPF_HZ / sampleRate)
    this.shelfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_SHELF_HZ / sampleRate)
    // DC blocker pole — the asymmetric shaper shifts the operating point.
    // See DC_BLOCK_HZ for what is and is not measured about the corner.
    this.dcR = 1 - 2 * Math.PI * DC_BLOCK_HZ / sampleRate

    /**
     * GAIN KNOB (MAKEUP), SMOOTHED — it was applied as a bare step.
     *
     * `makeupLin` was recomputed in setParams and multiplied straight into the
     * gain envelope, so every param message stepped it discontinuously. That is
     * inaudible for a knob nudged by hand and a click for anything writing the
     * knob rapidly, which is what AUTO makeup does — reported as zippering on
     * rapid adjustment.
     *
     * ⚠ `null` = not yet seeded. The first block adopts the target exactly, so
     * an offline render carries its makeup from sample 0 rather than swelling
     * into it over the smoothing time.
     */
    this.makeupLinSmoothed = null
    this.makeupSmoothCoef = 1 - Math.exp(-1 / (sampleRate * (MAKEUP_SMOOTH_MS / 1000)))

    // Sidechain / T4 state
    this.hpfLp = 0
    this.shelfLp = 0
    this.env = 0
    // The cell's reduction, and how far its recovery has handed over from the
    // fast phase to the phosphorescent one (0 = just released, 1 = deep tail).
    this.gr = 0
    this.relPhase = 0

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
    this.preGainScratch = new Float32Array(128)

    /**
     * LIVE AUTO-MAKEUP TRACKER — running extrema, O(1) per sample.
     *
     * ⚠ IT DOES NOT NEED THE MAKEUP MOVED AFTER THE TUBE STAGE. The makeup sits
     * BEFORE the tube as on the hardware, so the output is not affine in it —
     * and it does not have to be. The shaper is memoryless and STRICTLY
     * MONOTONE, so the output peak is a monotone function of the makeup fixed
     * entirely by two extrema of the PRE-makeup signal, and inverting the
     * shaper at the target peak solves it in closed form. Verified against the
     * four-pass offline iteration on 30 s of real narration: within 0.025 dB at
     * Peak Reduction 40 / 55 / 60 / 75 / 85.
     *
     * ⚠ PRE-MAKEUP IS LOAD-BEARING, AND TRACKING POST-MAKEUP DIVERGED. A first
     * build tracked the signal AFTER the makeup and divided by the makeup in
     * effect — valid only while that is constant. The panel writes the reported
     * value back onto the knob, so with the loop closed the division was
     * applied to extrema accumulated at other gains and it ran away to −4635 dB.
     * Everything tracked here is independent of the makeup by construction,
     * which is what makes the loop stable rather than merely tuned.
     */
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkVMax = 0
    this.trkVMin = 0

    /**
     * The gain reduction WITHOUT makeup — a second array rather than dividing
     * the makeup back out of `gain[]`, which is precisely the coupling that
     * made the loop unstable.
     *
     * ⚠ UNDELAYED, WHERE `gain[]` IS DELAYED, and that is not an oversight.
     * `gainDelay` exists to hold the envelope back until the audio emerges from
     * the upsampler, which has delayed it. The tracker pairs this with the
     * BASE-RATE input, which no upsampler has delayed, so applying the same
     * hold would misalign the two by UPSAMPLE_DELAY_SAMPLES — measured, that
     * paired each transient with the gain from before its own attack and asked
     * for 7.03 dB against a true 4.22.
     */
    this.wetScratch = new Float64Array(128)

    /**
     * LOOKAHEAD — per-channel delay on the AUDIO path only. See
     * LOOKAHEAD_MAX_MS. Zero-length while the control is off, which is the
     * default, so the lines are grown on demand like every other per-channel
     * resource here.
     */
    this.lookaheadSamples = 0
    this.laLines = []
    this.laScratch = []

    this.params = { ...LA2A_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /**
   * Forget what has played. The tracker is a running measurement over the audio
   * it has SEEN, so a new region means new material and the old extrema would
   * keep answering for audio the user has moved on from.
   */
  resetAutoMakeupTracker() {
    this.trkInPeak = 0
    this.trkSamples = 0
    this.trkVMax = 0
    this.trkVMin = 0
  }

  /**
   * The makeup the audio heard so far asks for, dB, or null before anything has
   * been heard.
   *
   * Inverts the tube shaper at the target peak. Monotone, so the two extrema of
   * the pre-makeup signal are all it takes; the binding side is whichever hits
   * the target first.
   *
   * ⚠ IT ONLY KNOWS WHAT HAS PLAYED, so early in a pass it can read high — the
   * loudest moment may not have arrived. That is why APPLY keeps the
   * deterministic offline solve rather than committing this number.
   */
  liveAutoMakeupDb() {
    if (this.trkSamples < this.sampleRate * MAKEUP_TRACKER_WARMUP_S) return null
    const P = this.trkInPeak
    if (!(P > 0)) return null
    const vMax = this.trkVMax
    const vMin = this.trkVMin
    if (!(vMax > 0) && !(vMin < 0)) return null

    let g = Infinity
    if (this.applyTube) {
      const inv = (y) => {
        const a = y * this.tubeNorm + this.tanhBias
        // The shaper saturates below the target: no makeup reaches it.
        if (a >= 1 || a <= -1) return null
        return (Math.atanh(a) - this.tubeBias) / this.tubeDriveLin
      }
      const up = inv(P), dn = inv(-P)
      if (up !== null && vMax > 0) g = Math.min(g, up / vMax)
      if (dn !== null && vMin < 0) g = Math.min(g, dn / vMin)
    } else {
      if (vMax > 0) g = Math.min(g, P / vMax)
      if (vMin < 0) g = Math.min(g, P / -vMin)
    }
    if (!Number.isFinite(g) || g <= 0) return null
    return 20 * Math.log10(g)
  }

  /** Clear every feedback path in the cell and the tube stage. */
  resetState() {
    this.hpfLp = 0
    this.shelfLp = 0
    this.env = 0
    this.gr = 0
    this.relPhase = 0
    this.lastGain = 1
    this.dcX = this.dcX.map(() => 0)
    this.dcY = this.dcY.map(() => 0)
    this.gainDelay.reset()
    for (const line of this.dryLines) line?.reset()
    // ⚠ THE LOOKAHEAD LINES TOO. They hold `lookaheadSamples` of the PREVIOUS
    // region's audio, and a reset that left them would splice that tail onto
    // the head of the next one — audible, and exactly the class of thing a
    // reset exists to prevent.
    for (const line of this.laLines) line?.reset()
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
    this.scDriveDb = scDriveDbFor(p.peakReduction)
    // Gain applied to the side-chain's sub-1 kHz content: 1 at r37 100 (fully
    // clockwise, flat, factory), down to -10 dB at r37 0 (fully counter-
    // clockwise). Above the corner the side-chain stays at unity, so this only
    // ever removes drive — see SC_SHELF_MAX_DB.
    const r37 = Number.isFinite(p.r37) ? clamp(p.r37, 0, 100) : LA2A_KERNEL_DEFAULTS.r37
    this.shelfLowGain = Math.pow(10, (-SC_SHELF_MAX_DB * (1 - r37 / 100)) / 20)
    this.makeupLin = Math.exp((Number.isFinite(p.gainDb) ? p.gainDb : 0) * LN10_OVER_20)

    // Tube stage. Drive can go sub-unity (slope is normalized back to 1
    // below): at the default amount a -6 dBFS peak lands around H3 ≈ -40 dBc
    // — tube warmth at nominal level, not overdrive. Max reaches ~-22 dBc.
    this.applyTube = p.tube !== false
    this.cellMod = Number.isFinite(p.cellMod) ? Math.max(0, p.cellMod) : 1
    this.tubeDriveLin = TUBE_DRIVE_LIN
    this.tubeBias = TUBE_BIAS
    this.tanhBias = Math.tanh(this.tubeBias)
    // Normalize so the shaper has unity small-signal gain
    this.tubeNorm = this.tubeDriveLin * (1 - this.tanhBias * this.tanhBias)

    this.wetMix = clamp(p.mix, 0, 1)
    this.dryMix = 1 - this.wetMix

    this.oversampleOn = p.oversample !== false

    // Lookahead in ms rather than samples so the same params mean the same
    // thing at any rate, and so `toKernelParams` needs no sample rate.
    const laMs = clamp(Number.isFinite(p.lookaheadMs) ? p.lookaheadMs : 0, 0, LOOKAHEAD_MAX_MS)
    const laSamples = Math.round((laMs / 1000) * this.sampleRate)
    if (laSamples !== this.lookaheadSamples) {
      this.lookaheadSamples = laSamples
      // Dropped rather than resized: a delay line's contents are a length's
      // worth of history, and there is no meaning to carry across a change of
      // length. Rebuilt on the next block.
      this.laLines = []
      this.laScratch = []
    }
  }

  /**
   * Algorithmic latency, in samples. Reported to the offline apply path, which
   * renders long and trims.
   *
   * Constant across every setting a listener can reach — the oversampled path
   * runs even with the tube stage bypassed for measurement, so that bypass
   * cannot shift the timeline underneath a running preview. It is zero only in the
   * measurement mode described on `oversample`, which nothing renders through.
   */
  get latencySamples() {
    return (this.oversampleOn ? OVERSAMPLE_LATENCY_SAMPLES : 0) + this.lookaheadSamples
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
    // own: env, gr and relPhase all feed back into themselves, so one NaN makes
    // every future block NaN and the effect goes silent for good.
    // Params are validated at the boundary, but this kernel is embedded by
    // other plugins and reached from a message port, so it also heals itself.
    // One comparison per block.
    if (!Number.isFinite(this.env + this.gr + this.relPhase)) {
      this.resetState()
    }

    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    if (this.gainScratch.length < n) this.gainScratch = new Float32Array(n)
    if (this.preGainScratch.length < n) this.preGainScratch = new Float32Array(n)
    if (this.wetScratch.length < n) this.wetScratch = new Float64Array(n)
    const gain = this.gainScratch
    const preGain = this.preGainScratch
    const chScale = 1 / nIn

    // The tracker's target: the loudest input sample heard so far.
    this.trkSamples += n
    for (let ch = 0; ch < nIn; ch++) {
      const src = inputChannels[ch]
      for (let i = 0; i < n; i++) {
        const a = src[i] < 0 ? -src[i] : src[i]
        if (a > this.trkInPeak) this.trkInPeak = a
      }
    }

    let { hpfLp, shelfLp, env, gr, relPhase } = this

    // Seeded on the first block; advanced once per sample HERE rather than
    // per channel, because this envelope loop is already the shared one.
    if (this.makeupLinSmoothed === null) this.makeupLinSmoothed = this.makeupLin
    let makeupLinSmoothed = this.makeupLinSmoothed

    for (let i = 0; i < n; i++) {
      // Mono sidechain tap
      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale

      // Sidechain frequency mapping: 80 Hz HPF, then the R37 emphasis filter.
      hpfLp += (x - hpfLp) * this.hpfLpCoef
      const hp = x - hpfLp
      // Split at the corner and attenuate only the low half. Run
      // unconditionally rather than skipped at r37 100: it is algebraically
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
        // ⚠ COMPRESS MODE'S RATIO IS FIXED, AND THAT IS MEASURED. It used to
        // drift 3:1 -> 4:1 with drive, which nothing in the references does:
        // LALA holds 1.98-2.00:1 and CLA-2A 3.92-4.08:1 across every knob
        // position captured. Ours was the only one of the three that moved.
        //
        // 3:1 is the LA-2A's documented compress-mode figure, and it sits
        // between the two emulations rather than picking a side — they
        // disagree by 2x, and neither is hardware. Swapping to CLA-2A's 4:1 is
        // a one-line change if the documented figure ever loses the argument.
        //
        // ⚠ LIMIT MODE IS UNTOUCHED AND STILL UNMEASURED. Every capture in this
        // branch is compress mode, so its ratio keeps the shape it had rather
        // than inheriting a change nothing tested.
        const ratio = this.isLimit
          ? 12 + 8 * (over > 0 ? over / (over + 6) : 0)
          : 3
        const slope = 1 - 1 / ratio
        if (over <= this.halfKnee) {
          const t = over + this.halfKnee
          grTarget = slope * t * t / (2 * this.kneeDb)
        } else {
          grTarget = slope * over
        }
      }

      // T4 dynamics: ONE reduction, moving toward the target at a rate that is
      // program-dependent going up and two-phase coming down. Nothing here owns
      // a fixed share of the reduction — see REL_FAST_S for the stage split
      // this replaced and the pedestal it left on program material.
      if (grTarget > gr) {
        // How lit the cell is RIGHT NOW, 0 (dark) to 1 (saturated).
        //
        // ⚠ THE CURRENT REDUCTION, NOT THE `memory` INTEGRATOR — tried that
        // first and it produced a spread in the WRONG DIRECTION. `memory`
        // discharges over 8 s, so across the 0.05-5 s gaps that decide this it
        // barely moves: hNorm went 0.545 -> 0.39, a 15 % swing on the
        // coefficient, not enough to overcome the measurement's own ~2 ms
        // artefact. The result was 8.4 ms at a 0.05 s gap against 7.4 at 5 s —
        // backwards.
        //
        // The current reduction is also the better physics. A CdS cell's speed
        // depends on its conductance, which is its state now; a cell that is
        // attenuating IS lit. That falls out correctly at every point: silent
        // start -> gr 0 -> slow; mid-phrase -> gr high -> fast, so transients
        // inside speech are caught; after a long gap -> released -> slow again.
        const hNorm = gr / (gr + CELL_HALF_DB)
        const attackCoef = this.attackCoefDark
          + (this.attackCoefLit - this.attackCoefDark) * hNorm
        gr += (grTarget - gr) * attackCoef
        // The panel is lit again, so the recovery starts over from its fast
        // phase. This is what keeps the slow tail out of program material:
        // between syllables the cell is re-lit long before the tail engages,
        // and the tail only takes over after the signal actually stops.
        relPhase = 0
      } else {
        relPhase += (1 - relPhase) * this.relPhaseCoef
        const relCoef = this.relFastCoef
          + (this.relSlowCoef - this.relFastCoef) * relPhase
        gr += (grTarget - gr) * relCoef
      }

      const grNow = gr
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
      makeupLinSmoothed += this.makeupSmoothCoef * (this.makeupLin - makeupLinSmoothed)
      let preG = Math.exp(-grNow * LN10_OVER_20)
      if (this.cellMod > 0 && env > 1e-6) {
        // Ripple as a fraction of the smoothed envelope, scaled by how hard
        // the cell is working. Sign is compressive: an instantaneously loud
        // sample means an instantaneously brighter lamp, so more attenuation.
        const rel = rect / env - 1
        // Saturating in gain reduction: a
        // depth linear in grDb hits the paper's point and then runs away, 9.3 %
        // by 24 dB of reduction. This levels off inside the band the six units
        // span at the one depth anyone measured.
        const depth = this.cellMod * CELL_MOD_MAX * (1 - Math.exp(-grNow / CELL_MOD_TAU_DB))
        const m = 1 - depth * rel
        preG *= m > 0.05 ? (m < 4 ? m : 4) : 0.05
      }
      const g = preG * makeupLinSmoothed
      gain[i] = this.oversampleOn ? this.gainDelay.push(g) : g
      preGain[i] = preG
    }
    this.makeupLinSmoothed = makeupLinSmoothed

    this.hpfLp = hpfLp
    this.shelfLp = shelfLp
    this.env = env
    this.gr = gr
    this.relPhase = relPhase
    this.grDb = gr

    /**
     * PRE-MAKEUP EXTREMA, tracked here rather than inside either per-channel
     * branch.
     *
     * ⚠ THE FIRST BUILD TRACKED ONLY IN THE BASE-RATE BRANCH, which the panel
     * never takes — the shipping path is oversampled — so the tracker never
     * fired at all and reported null forever. Once, in one place, covering both.
     *
     * Base rate even on the oversampled path: it is the same quantity the
     * offline solve measures, and the tracker's job is to agree with that.
     */
    /**
     * LOOKAHEAD — the audio path is delayed here, and ONLY here.
     *
     * Everything above this line is the side-chain: the detector, the static
     * curve and the T4 ballistics have all just run on the UNDELAYED
     * input, which is what makes the envelope identical at every
     * lookahead depth. Everything below consumes audio, and takes the delayed
     * copy — the tracker's extrema, the oversampled gain cell, the tube stage
     * and the dry side of the wet/dry blend.
     *
     * ⚠ THE TRACKER MUST TAKE THE DELAYED COPY, and that is the whole reason
     * this sits above it rather than below. `trkVMax`/`trkVMin` pair a sample
     * with the gain applied TO IT; pairing undelayed audio with `preGain` would
     * hand every transient the gain from `lookaheadSamples` before its own
     * attack, which is the same misalignment the note on `wetScratch` describes
     * and it fails the same way — the live makeup reads high and fights the
     * offline solve.
     *
     * `trkInPeak` above is deliberately left on the undelayed input: it is the
     * loudest sample HEARD, a target the delay only re-times.
     */
    let audioChannels = inputChannels
    if (this.lookaheadSamples > 0) {
      while (this.laLines.length < nIn) {
        this.laLines.push(new DelayLine(this.lookaheadSamples))
        this.laScratch.push(new Float32Array(0))
      }
      const delayed = []
      for (let ch = 0; ch < nIn; ch++) {
        if (this.laScratch[ch].length < n) this.laScratch[ch] = new Float32Array(n)
        const dst = this.laScratch[ch]
        const line = this.laLines[ch]
        const src = inputChannels[ch]
        for (let i = 0; i < n; i++) dst[i] = line.push(src[i])
        delayed.push(dst.subarray(0, n))
      }
      audioChannels = delayed
    }

    for (let ch = 0; ch < nOut; ch++) {
      const src = audioChannels[Math.min(ch, nIn - 1)]
      for (let i = 0; i < n; i++) {
        const v = src[i] * preGain[i]
        if (v > this.trkVMax) this.trkVMax = v
        else if (v < this.trkVMin) this.trkVMin = v
      }
    }

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
      const input = audioChannels[ch < nIn ? ch : nIn - 1]
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
 * The kernel's algorithmic latency for a set of params, without building one.
 *
 * ⚠ THE APPLY PATH CANNOT ASK A KERNEL. `applyWorkletRegion` sizes its
 * OfflineAudioContext from this number, so it needs it BEFORE any node exists —
 * which is why the value used to be a module constant, and why that constant
 * silently became wrong the moment latency stopped being fixed. The soft
 * clipper hit this first; see `softClipperLatencySamples` for the seam it left
 * (a region spliced in shifted late, with that much of its tail dropped).
 *
 * Mirrors the `latencySamples` getter rather than sharing code with it, and is
 * pinned against a real kernel by its test so the two cannot drift.
 *
 * `params` are KERNEL params (`lookaheadMs`), not the panel's.
 */
export function la2aLatencySamples(params, sampleRate) {
  const osLatency = params?.oversample === false ? 0 : OVERSAMPLE_LATENCY_SAMPLES
  const laMs = clamp(
    Number.isFinite(params?.lookaheadMs) ? params.lookaheadMs : 0, 0, LOOKAHEAD_MAX_MS,
  )
  return osLatency + Math.round((laMs / 1000) * sampleRate)
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

  /**
   * ⚠ THE MEASURED SPAN MUST BE THE SPAN APPLY WRITES BACK, not the raw render.
   *
   * With lookahead the output lags its input, so the last `latency` samples of
   * the region never emerge and the first `latency` are the delay line filling
   * with silence. Measuring the render as-is therefore compares a region's
   * input peak against an output missing that region's tail — and on a short
   * selection the tail is where the peak often is. `applyWorkletRegion` already
   * solves this the same way for the render it splices in: extend, then trim.
   * This is that, so the solve and the apply see the same audio.
   *
   * Zero at lookahead 0, where it telescopes to the old behaviour exactly.
   */
  const latency = la2aLatencySamples(measureParams, sampleRate)
  const padded = latency > 0
    ? channelData.map((ch) => {
      const p = new Float32Array(ch.length + latency)
      p.set(ch, 0)
      return p
    })
    : channelData

  let makeupDb = 0
  for (let i = 0; i < maxIterations; i++) {
    const { channelData: rendered } = processLA2ABuffer(padded, sampleRate, {
      ...measureParams,
      gainDb: makeupDb,
    })
    const out = latency > 0
      ? rendered.map((ch) => ch.subarray(latency, latency + channelData[0].length))
      : rendered
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
