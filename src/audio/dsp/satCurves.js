/**
 * THE SATURATION TRANSFER CURVES — the pure, memoryless part of Tube
 * Saturation, with NO dependencies and NO worklet side effect.
 *
 * ⚠ THIS FILE EXISTS BECAUSE IMPORTING THEM FROM `vocalSatProcessor.js` BROKE
 * THE WORKLETS, AND NOTHING IN THE SUITE COULD SEE IT. That module ends in
 * `if (typeof registerProcessor === 'function') { ...
 * registerProcessor('vocal-sat-processor', ...) }`. Importing anything from it
 * into `la2aProcessor.js` pulled that module scope into the LA-2A worklet
 * bundle AND, through Scheps, into that one — so loading OptoSmooth or Scheps
 * alongside Tube Saturation in one AudioContext registered
 * `vocal-sat-processor` twice. The second `addModule()` throws
 * `NotSupportedError`, which aborts the whole module and takes that effect's
 * processor with it: one of the two plugins is dead, and which one is decided
 * by load order.
 *
 * ⚠ LA-2A ALREADY CARRIED THIS SCAR AND IT DID NOT GENERALISE. Its own
 * `registerProcessor` is wrapped in a try/catch for exactly this reason,
 * because Scheps composes `LA2AKernel`. Tube Saturation's is not, and an
 * import added long afterwards reached it. The lesson is this file rather than
 * a third try/catch: a module that REGISTERS A PROCESSOR is an ENTRY POINT,
 * not a library, and must never be imported by another entry point.
 * `test/dsp/workletEntryPoints.test.js` enforces it now.
 *
 * ⚠ IT IS STILL ONE DEFINITION. Importing rather than copying was the point —
 * a retune of Tube Saturation has to reach everything voiced against it — and
 * that still holds: these ARE the plugin's curves, `vocalSatProcessor.js`
 * imports them from here and re-exports them, and there is no second copy to
 * drift.
 */

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
/**
 * ⚠ EXPORTED BECAUSE THE KERNEL STILL NEEDS IT. Tame references the curve's
 * own edge — 1.5 for the cubic, 1 for the rational family — so this constant
 * has consumers outside the curve it belongs to.
 */
export const CUBIC_LIMIT = 1.5
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
