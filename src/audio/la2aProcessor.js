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
 *      level arriving at the valves. See TUBE_DRIVE_LIN.
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
const DETECTOR_S = 0.0005 // light rectifier smoothing; the T4 model supplies the real ballistics

// Nominal operating level. The hardware's T4 threshold sits at line level
// (0 VU = +4 dBu), so Peak Reduction is referenced to that, not to digital
// full scale. Anchoring at 0 dBFS instead would make the cell ~18 dB deaf to
// normal program: narration at -20 dBFS RMS would need the knob near 95 to
// produce 3 dB of reduction. -18 dBFS is the EBU alignment.
const NOMINAL_DBFS = -18
const NOMINAL_LIN = Math.pow(10, NOMINAL_DBFS / 20) // reference level for the cell spike

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
 */
const SC_DRIVE_MAX_DB = 36.24
const SC_DRIVE_SPAN_DB = 105.9
const SC_TAPER = 0.4247

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
 * So the fix is STRUCTURAL: the distortion belongs with the gain cell, scaling
 * with gain reduction, and it should be odd-dominant. That is a redesign, not a
 * retune, and it is not done. These constants stay only because they are what
 * has been listened to; the "consistent with the published spec" argument below
 * is now known to be an argument about the WRONG STAGE — that spec is the unit
 * with no gain reduction, where the paper agrees the valves are nearly linear.
 *
 * ⚠ ALSO NOT MEASURED AGAINST HARDWARE DIRECTLY. The THD figures above are of
 * our own curve; the <0.5 % spec is a published number, not a capture.
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
 * ⚗ SPIKE — T4 CELL NONLINEARITY. Default 0, i.e. OFF and bit-identical.
 *
 * The hardware study (see TUBE_DRIVE_LIN above) puts the LA-2A's distortion in
 * the T4 electro-optical attenuator rather than the valves, makes it
 * ODD-dominant, and has it RISE with gain reduction. This models that
 * directly: a symmetric (unbiased) `tanh` applied to the signal AT THE CELL —
 * after the attenuation, before the makeup amplifier, which is where the
 * photoresistor actually sits — with its drive proportional to how hard the
 * cell is working.
 *
 * ODD BY CONSTRUCTION. No bias term, so it generates H3/H5/H7 and EXACTLY no
 * even harmonics. The small even content the hardware does show is left to the
 * tube stage's own TUBE_BIAS, which is what that term is for; the two together
 * are what has to land in the paper's +16 to +44 dB H3-over-H2 window.
 *
 * RISES WITH COMPRESSION, which is the behaviour our output-stage-only model
 * gets backwards. Drive is `CELL_DRIVE_PER_DB x grDb`, referenced to
 * NOMINAL_DBFS rather than to the signal, so the amount of shaping tracks the
 * cell's work and not the level arriving at it.
 *
 * `tanh(c*w)/c` has unity slope at the origin for any c, so the stage is
 * transparent as gain reduction goes to zero without any normalisation term.
 *
 * THE DEPTH LAW SATURATES, AND THAT CAME FROM LISTENING RATHER THAN FROM THE
 * PAPER. A drive linear in gain reduction hits the paper's point exactly and
 * then runs away — 2.15 / 7.98 / 13.41 / 17.84 % at 6 / 13 / 19 / 24 dB of GR.
 * Auditioned on narration at Peak Reduction 60 that was rejected as far too
 * much, and scaling the whole law down to taste (0.42x) fixed the listening
 * and broke the measurement: it lands at 0.43 % at the paper's 6 dB, BELOW the
 * quietest of the six units, with H3-H2 at +10 dB against a measured window of
 * +16 to +44.
 *
 * ⚠ THE TWO DISAGREED BECAUSE THEY WERE AT DIFFERENT DEPTHS. The paper measures
 * 6 dB of gain reduction; the listening test ran at Peak Reduction 60, which is
 * 10.2 dB average and 19.7 dB peak. The ear was judging an extrapolation, not
 * the calibration. So the magnitude was never the problem — the SLOPE was.
 *
 * `u` saturates instead: it rises fast out of zero and levels off, which
 * satisfies both at once. Measured, 1 kHz at -18 dBFS:
 *
 *   GR      THD      H3 - H2     the evidence at that depth
 *    0     0.271 %   -12.7 dB    <0.5 % manufacturer spec, no GR
 *    6     2.114 %   +25.2 dB    0.94-4.22 %, +16 to +44 (six units, median 2.19 / +25.7)
 *   13     2.983 %   +35.5 dB    no data — has to stay plausible, and does
 *   19     3.122 %   +41.8 dB    no data
 *   24     3.151 %   +47.2 dB    no data
 *
 * Every depth past the measurement now sits INSIDE the band the six units span
 * at 6 dB, rather than climbing out of it. On narration at PR 60 it is -14.5
 * dBc from the current model, against -16.4 for the by-ear favourite and -9.9
 * for the rejected one, and only -24.4 dBc from the favourite itself.
 *
 * ⚠ WHAT IS STILL UNMEASURED: everything below the 6 dB row. The saturation
 * point and time constant are shaped to satisfy one measured depth and one
 * listening session, which is better than one measured depth alone and is not
 * the same as evidence. THD at 12 / 18 / 24 dB of GR would settle it.
 * ⚠ AND H3-H2 DRIFTS OUT OF THE MEASURED WINDOW at depth (+47 against +16 to
 * +44) — the cell's odd content keeps growing while the tube sees less level
 * and makes less even. Small, past the data, and worth knowing.
 *
 * SO THIS IS STILL A SPIKE AND STAYS OFF, but what it establishes is stronger
 * than before: odd-dominant distortion AT THE CELL, saturating with gain
 * reduction, reproduces the hardware's harmonic signature where it was measured
 * AND survives a listening test where the output-stage model's replacement
 * did not.
 */
const CELL_U_MAX = 0.648
const CELL_GR_TAU_DB = 3.82

const TUBE_DRIVE_LIN = 0.7 // knee at +3.1 dBFS, i.e. 21.1 dB above NOMINAL_DBFS
const TUBE_BIAS = 0.06 // operating-point offset, 4.2% of the linear range

const COMPRESS_KNEE_DB = 20 // wide knee — the "leveling" feel
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
   * ⚗ SPIKE, default 0 (off, bit-identical). Scales CELL_DRIVE_PER_DB; 1 is
   * the paper-calibrated depth. Nothing in the app sets it.
   */
  cellDrive: 0,
  r37: 100, // 0–100 side-chain pre-emphasis, as knob rotation: 100 = flat (factory)
  mix: 1, // wet/dry blend
  /**
   * Run the gain cell and tube stage oversampled. Always true for anything
   * anyone listens to; see `computeAutoMakeupDb` for the one caller that turns
   * it off and why that is sound.
   */
  oversample: true,
}

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

    this.attackCoef = 1 - Math.exp(-1 / (sampleRate * ATTACK_S))
    this.fastRelCoef = 1 - Math.exp(-1 / (sampleRate * FAST_RELEASE_S))
    this.detCoef = 1 - Math.exp(-1 / (sampleRate * DETECTOR_S))
    this.memChargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_CHARGE_S))
    this.memDischargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_DISCHARGE_S))
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
    // ⚗ SPIKE: the cell path needs the attenuation and the makeup SEPARATELY,
    // where the shipping path folds them into one `gain[i]`. Delayed to meet
    // the audio exactly as `gainDelay` is.
    this.preGainDelay = new DelayLine(Math.max(0, UPSAMPLE_DELAY_SAMPLES - 1))
    this.preGainDelayedScratch = new Float32Array(128)
    this.makeupScratch = new Float32Array(128)
    this.lastPreGain = 1
    this.lastMakeup = 1
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
    this.grFast = 0
    this.grSlow = 0
    this.memory = 0
    this.lastGain = 1
    this.dcX = this.dcX.map(() => 0)
    this.dcY = this.dcY.map(() => 0)
    this.gainDelay.reset()
    this.preGainDelay.reset()
    this.lastPreGain = 1
    this.lastMakeup = 1
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
      SC_DRIVE_MAX_DB - NOMINAL_DBFS - SC_DRIVE_SPAN_DB * (1 - Math.pow(knob, SC_TAPER))
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
    this.cellDrive = Number.isFinite(p.cellDrive) ? Math.max(0, p.cellDrive) : 0
    this.tubeDriveLin = TUBE_DRIVE_LIN
    this.tubeBias = TUBE_BIAS
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
   * runs even with the tube stage bypassed for measurement, so that bypass
   * cannot shift the timeline underneath a running preview. It is zero only in the
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
    if (this.preGainScratch.length < n) this.preGainScratch = new Float32Array(n)
    if (this.preGainDelayedScratch.length < n) this.preGainDelayedScratch = new Float32Array(n)
    if (this.makeupScratch.length < n) this.makeupScratch = new Float32Array(n)
    if (this.wetScratch.length < n) this.wetScratch = new Float64Array(n)
    const gain = this.gainScratch
    const preGain = this.preGainScratch
    const preGainDelayed = this.preGainDelayedScratch
    const makeupArr = this.makeupScratch
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

    let { hpfLp, shelfLp, env, grFast, grSlow, memory } = this

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
      makeupLinSmoothed += this.makeupSmoothCoef * (this.makeupLin - makeupLinSmoothed)
      const preG = Math.exp(-grNow * LN10_OVER_20)
      const g = preG * makeupLinSmoothed
      gain[i] = this.oversampleOn ? this.gainDelay.push(g) : g
      preGain[i] = preG
      if (this.cellDrive > 0) {
        preGainDelayed[i] = this.oversampleOn ? this.preGainDelay.push(preG) : preG
        makeupArr[i] = makeupLinSmoothed
      }
    }
    this.makeupLinSmoothed = makeupLinSmoothed

    this.hpfLp = hpfLp
    this.shelfLp = shelfLp
    this.env = env
    this.grFast = grFast
    this.grSlow = grSlow
    this.memory = memory
    this.grDb = grFast + grSlow

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
    for (let ch = 0; ch < nOut; ch++) {
      const src = inputChannels[Math.min(ch, nIn - 1)]
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
      if (this.cellDrive > 0) {
        /**
         * ⚗ SPIKE PATH — attenuation and makeup applied SEPARATELY so the
         * cell's nonlinearity can sit between them, which is where the
         * photoresistor is. See CELL_DRIVE_PER_DB.
         *
         * ⚠ A SEPARATE BRANCH RATHER THAN A GENERALISATION OF THE ONE BELOW,
         * deliberately: `(x*p)*m` and `x*(p*m)` differ in the last bits, so
         * folding the shipping path into this one would move every sample of
         * every render for a feature that is off by default. The duplication
         * is the price of `cellDrive: 0` being bit-identical, and it is the
         * right price while this is a spike.
         */
        let pCur = this.lastPreGain
        let mCur = this.lastMakeup
        for (let i = 0; i < n; i++) {
          const pNext = preGainDelayed[i]
          const mNext = makeupArr[i]
          const pStep = (pNext - pCur) * invL
          const mStep = (mNext - mCur) * invL
          for (let j = 0; j < L; j++) {
            const k = i * L + j
            const p = pCur + pStep * j
            // Attenuation first: this is the signal the cell actually passes.
            let w = hi[k] * p
            // Cell nonlinearity. Drive from how hard the cell is working —
            // `p` IS the attenuation, so -20log10(p) is its gain reduction —
            // referenced to nominal rather than to the signal, so the shaping
            // tracks the compression and not the level.
            const grHere = p > 0 ? -20 * Math.log10(p) : 0
            // ⚠ REFERENCED TO THE CELL'S INPUT, hence the 1/p: the drive has to
            // beat the attenuation, or the shaper sees an ever-smaller signal
            // as the cell works harder and THD PEAKS at ~6 dB of reduction and
            // falls away again — which contradicts the one direction the paper
            // is explicit about.
            //
            // SATURATING IN GAIN REDUCTION. `u` is the drive the shaper sees at
            // nominal level; it rises fast out of zero and levels off, so THD
            // climbs to the hardware's band and STAYS there instead of running
            // away. A drive linear in grDb hit 17.8 % at 24 dB of reduction.
            const u = CELL_U_MAX * (1 - Math.exp(-grHere / CELL_GR_TAU_DB))
            const c = this.cellDrive * u / (NOMINAL_LIN * Math.max(p, 0.03))
            if (c > 1e-9) w = Math.tanh(c * w) / c
            // Then the makeup amplifier, then the valves it feeds.
            w *= mCur + mStep * j
            if (this.applyTube) {
              w = (Math.tanh(this.tubeDriveLin * w + this.tubeBias) - this.tanhBias) / this.tubeNorm
            }
            hi[k] = w
          }
          pCur = pNext
          mCur = mNext
        }
        if (ch === nOut - 1) { this.lastPreGain = pCur; this.lastMakeup = mCur }
      } else {

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
