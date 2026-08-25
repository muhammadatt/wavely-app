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
 * 6. THE CURVE IS LEVEL-INVARIANT AND REDUCTION-BOUNDED, WHICH §4.4's CURVE IS
 *    NEITHER. Reported from use: the stage does almost nothing on a quieter
 *    file. It doesn't — measured, the same audio attenuated 18 dB went from
 *    5.11 dB of reduction to 0.00, with its relative dynamics untouched. §3.3
 *    states level invariance as the whole point of deriving T from the
 *    speaker's own level, and the detector delivers it; the curve then threw
 *    it away by normalising to digital full scale. The replacement works in
 *    dB on the RATIO x/T, so invariance holds by construction. See
 *    MAX_REDUCTION_DB / KNEE_DB for the derivation and the measurements.
 *
 *    Two things fell out of that change, both worth keeping in view:
 *
 *    a) An INPUT TRIM would have been the wrong fix, and the reason is a
 *       useful test in general: on a correctly scale-invariant design an input
 *       trim provably does nothing but change output level. A control that
 *       only has a function because of a defect is a workaround for it.
 *
 *    b) BOUNDING THE REDUCTION IS A SAFETY REQUIREMENT, not a preference,
 *       once the curve is invariant. Under the old full-scale anchor a badly
 *       wrong threshold was self-limiting — the curve did nothing down there.
 *       Under any invariant curve, reduction is a function of x/T alone, so a
 *       wrong threshold is punished in proportion. The first attempt at this
 *       fix kept an unbounded invariant curve and was caught by the reference
 *       clip: during detector convergence T sat at -46 dBFS while real speech
 *       arrived 29 dB above it, and the stage took 29 dB off a signal it
 *       exists to trim by 3-6. Invariance without a bound converts every
 *       detector error into destruction.
 *
 *    T_MIN moved with this (-20 dBFS -> -60 dBFS): at -20 it was a second,
 *    independent level wall, pinning the threshold on any file quieter than a
 *    mastered one. A noise-floor-relative floor was tried in its place and
 *    removed; see the note above T_MIN for why it broke continuous material.
 *
 * 7. THE SPEECH-LEVEL TRACKER IS PEAK-REFERENCED, NOT RMS-REFERENCED (spec
 *    §3.2). Reported from listening on headphones: subtle distortion across the
 *    whole file rather than on peaks. Measured and confirmed — at the default
 *    the stage was shaping 4.4% of all voiced SAMPLES, with 32% of voiced 50 ms
 *    blocks carrying residual above -40 dBc and p90 residual at -27 dBc. That
 *    is waveshaping the programme, not taming transients.
 *
 *    The cause is a units mismatch the spec carries: §3.2 tracks fast_rms,
 *    §3.3 sets T = speech_level + headroom, and T is then compared against
 *    individual SAMPLES. Speech has a large crest factor, so an RMS-referenced
 *    threshold lands INSIDE the normal peak distribution. Measured on the
 *    reference clip: the median voiced block's peak sat 5.3 dB above the
 *    tracked level, p90 13.0 dB above, p99 18.0 dB above — so at the 10 dB
 *    default, T was below the peak of a quarter of all voiced blocks. No
 *    setting in the spec's 4-16 dB range escapes it; the range is ~9 dB too
 *    low for the quantity it was measured against.
 *
 *    Tracking a short-term peak envelope instead makes Headroom mean "dB above
 *    where syllable peaks normally land", which is what a transient tamer
 *    needs and is stable across speakers with different crest factors. Simply
 *    raising the Headroom range would have worked on this one file and needed
 *    re-tuning per recording — the same class of error as calibrating against
 *    absolute level, which deviation 6 had just finished removing.
 *
 *    Result at the default: 0.23% of voiced samples touched (from 4.4%), 4% of
 *    blocks above -40 dBc (from 32%), residual p90 -64 dBc (from -27), and
 *    3.17 dB of peak reduction — inside §7.1's stated range where the old
 *    build's nominal 3.94 dB was bought by distorting everything.
 *
 *    §8.3's onset-excess histogram — the diagnostic that names this exact
 *    failure, deferred as an offline exercise when this was built and
 *    therefore never run — now reports median and mode moving 0.00 dB, which
 *    is its stated pass condition.
 *
 *    The default Headroom moved 10 -> 8 with the reference change. The 4-16
 *    range is kept: against a peak reference, 4 is the aggressive end and 16 is
 *    effectively off.
 *
 * 8. THE WARM-UP FAILS SAFE: NO PROCESSING UNTIL THE DETECTOR HAS EVIDENCE.
 *    Reported from listening: a second or so of distortion at the start of the
 *    file and after pauses, absent in fixed-threshold mode. Measured on the
 *    reference clip, the opening 3 s took 5.98 dB — the ceiling — against
 *    3.17 dB for the rest, and speech onsets following >=300 ms of quiet saw
 *    5.98 and 1.45 dB against a steady-state p99 of 0.78. At t = 0.45 s the
 *    tracked level read -50.4 dBFS while speech peaked at -6.8: a 44 dB error.
 *
 *    Cause: spec §3.2's initialisation, both halves. The -24 dBFS seed is an
 *    absolute constant unrelated to the material, and averaging "the first
 *    500 ms of gate-open audio" averages, on a real file, a quiet lead-in and
 *    the onset ramp of the first phrase rather than representative speech.
 *    See SPEECH_INIT_HOLD_DB for the replacement.
 *
 *    TWO PLAUSIBLE FIXES WERE TRIED AND MEASURED AWAY FIRST, both because the
 *    cost of a wrong tracked level is asymmetric (too low over-processes, too
 *    high merely does less) and it seemed the ballistics should reflect that:
 *
 *    a) An asymmetric tracker, fast rise and slow fall. It did NOTHING for the
 *       reported spike — 5.98 dB at attack times from 3000 ms down to 120 ms,
 *       unchanged — because the spike happens during the warm-up, which does
 *       not use the tracker's coefficients at all. And it destroyed the effect
 *       in steady state, monotonically: 3.17 -> 2.26 -> 1.42 -> 0.68 -> 0.34 dB
 *       across those attack times. A tracker that chases peaks upward raises
 *       the very threshold those peaks would have crossed.
 *
 *    b) Shortening SPEECH_TAU_S. Same shape of result: a +12 dB level jump
 *       after a pause barely improved (3.88 -> 3.59 dB from tau 3.0 to 1.0)
 *       while settled reduction collapsed (2.01 -> 0.12 dB).
 *
 *    So the 3 s constant is right and the cure was the warm-up. Result: the
 *    opening 3 s goes 5.98 -> 0.01 dB with steady state preserved at 3.15, and
 *    post-onset reduction now sits BELOW the rest of the file (0.17 against a
 *    0.65 p99) rather than five times above it.
 *
 *    WHAT REMAINS IS INHERENT, and worth stating plainly rather than tuning
 *    at. A genuine level jump after a pause — the tracker holds through the
 *    pause, so a following passage 12 dB louder finds T 12 dB low — still
 *    draws about 1.9 dB more than settled for roughly 1.5 s, bounded by
 *    MAX_REDUCTION_DB. Both experiments above show why that cannot be tuned
 *    out: any tracker fast enough to erase the lag is fast enough to chase the
 *    peaks it exists to catch. Fixed-threshold mode has no lag because it does
 *    not adapt at all; that is its trade, not a bug in adaptive mode.
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

import { LookaheadLimiter } from './dsp/lookaheadLimiter.js'
import { BandSplitLimiter } from './dsp/bandSplitLimiter.js'
import {
  Oversampler, OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES,
  COMPRESSOR_OVERSAMPLE, COMPRESSOR_OVERSAMPLE_8X,
} from './dsp/oversample.js'
import {
  highShelf, invertBiquad, biquadZerosInsideUnitCircle, BiquadCascade,
} from './dsp/biquad.js'
import { riseCoeff } from './dsp/envelope.js'

export { OVERSAMPLE_FACTOR, OVERSAMPLE_LATENCY_SAMPLES as SOFT_CLIPPER_LATENCY_SAMPLES }

// ── Detector constants ──────────────────────────────────────────────────────

const FAST_RMS_TAU_MS = 10

/**
 * The speech-level tracker follows a short-term PEAK envelope, not fast RMS.
 *
 * Spec §3.2 tracks fast_rms and §3.3 sets T = speech_level + headroom. But T is
 * then compared against individual SAMPLES, and speech has a large crest
 * factor, so an RMS-referenced threshold sits inside the normal peak
 * distribution rather than above it. Measured on the reference clip: the median
 * voiced block's peak sits 5.3 dB above the tracked RMS level, p90 sits 13.0 dB
 * above and p99 18.0 dB above. With Headroom at its 10 dB default that put T
 * below the peak of 25% of all voiced blocks, and the curve was shaping
 * ordinary syllables rather than outliers — 4.4% of voiced SAMPLES touched,
 * with 32% of voiced 50 ms blocks carrying residual above -40 dBc.
 *
 * Reported from listening, on headphones, as subtle distortion across the whole
 * file rather than on peaks. That is exactly the failure §8.3 describes
 * ("headroom_db too low: the entire distribution slides down — the stage is
 * attenuating normal speech, not just outliers") and exactly what the
 * onset-excess histogram it prescribes exists to catch. That diagnostic was
 * deferred as an offline exercise when this was built, so nothing caught it.
 *
 * Referencing the tracker to peaks makes Headroom mean "dB above where syllable
 * peaks normally land", which is the quantity a transient tamer needs and is
 * stable across speakers with different crest factors. Raising the Headroom
 * range instead would have worked on this file and needed re-tuning per
 * recording — the same class of mistake as calibrating against absolute level.
 *
 * Fast attack so a real peak is not missed, ~150 ms release so the envelope
 * follows syllables rather than individual glottal pulses. The gate and the
 * noise-floor estimate stay on fast RMS, where an energy measure is correct.
 */
const FAST_PEAK_ATTACK_MS = 1
const FAST_PEAK_RELEASE_MS = 150
const NOISE_FOLLOW_TAU_MS = 2000 // creep-up rate of the valley follower
const GATE_MARGIN_DB = 12 // ⚠ spec-flagged for calibration; not user-exposed in v1
const GATE_HOLD_MS = 200
const SPEECH_TAU_S = 3.0

// AN ASYMMETRIC TRACKER (fast rise, slow fall) WAS TRIED HERE AND REMOVED.
// The reasoning was sound — a tracked level that is too LOW over-processes
// while one that is too HIGH merely does less, so the dynamics should favour
// rising — but measurement killed it twice over. It did nothing for the
// reported start-of-file distortion (5.98 dB at attack times from 3000 ms
// right down to 120 ms, unchanged), because that spike happens DURING the
// warm-up, which does not use the tracker's coefficients at all. And it
// destroyed the effect in steady state, monotonically: peak reduction after
// the first 3 s fell 3.17 -> 2.26 -> 1.42 -> 0.68 -> 0.34 dB across those same
// attack times, because a tracker that chases peaks upward raises the very
// threshold those peaks would have crossed. The cure was the warm-up (see
// SPEECH_INIT_HOLD_DB), not the ballistics.
const SPEECH_INIT_WINDOW_MS = 500
/**
 * The level the tracker reports WHILE it is still warming up — high enough
 * that T lands above any possible sample and the stage processes nothing.
 *
 * Spec §3.2 seeds -24 dBFS and averages the first 500 ms of gate-open audio.
 * Both halves misfire on a cold start, and together they were the reported
 * "second or so of distortion at the start of the file": the seed is an
 * absolute constant unrelated to the material, and the average is taken over a
 * window that on a real file begins with a quiet lead-in and the onset ramp of
 * the first phrase rather than with representative speech. Measured on the
 * reference clip, at t = 0.45 s the tracked level read -50.4 dBFS while speech
 * in the following second peaked at -6.8 — a 44 dB error, which put T far
 * under everything and clipped the lot at the 6 dB ceiling.
 *
 * The principle is simply that an estimator with no data yet should not be
 * driving anything: hold T above full scale until there is enough gate-open
 * audio to trust, and process nothing until then. Erring toward inaction is
 * free here — a missed plosive in the first half second is inaudible, where
 * half a second of everything clipped is exactly what was reported.
 *
 * The estimate handed over at the end of warm-up is the MAX of the peak
 * envelope across that window, not its mean. A max is biased HIGH, which is
 * the safe direction (too high merely does less), and the 3 s tracker then
 * settles down onto the typical peak from above rather than climbing to it
 * from below.
 */
const SPEECH_INIT_HOLD_DB = 0

// A linear one-pole decaying toward silence can sit in denormal range for the
// whole length of a pause, which is measured to spike CPU on x86 (spec §6.1).
// Every kernel with a long-release one-pole in this codebase is exposed to
// this in principle; this one's the first with a multi-second LINEAR (not
// dB-domain) follower, so it is the first to need the guard.
const DENORMAL_GUARD = 1e-30

// Threshold clamp (spec §3.3) — linear amplitude.
//
// T_MIN WAS 0.10, i.e. -20 dBFS, and that was the stage's hard level wall.
// The spec sets it to "prevent pathological thresholds on silence", which is
// a real concern, but -20 dBFS is far above where real material sits: a raw
// narrator recording with speech RMS near -30 dBFS and Headroom 10 asks for
// T = -20 and lands exactly on the clamp, at which point the threshold stops
// tracking the speaker and the whole adaptive premise is dead. Measured on
// the reported clip: 6 dB of input attenuation was enough to pin T at the
// floor for the entire file.
//
// -60 dBFS is now the absolute backstop, low enough that no real recording
// reaches it. Damage from a wrong threshold is bounded by MAX_REDUCTION_DB.
const T_MIN = 0.001 // -60 dBFS
const T_MAX = 0.95

// A noise-floor-relative floor on T was tried here and REMOVED, which is worth
// recording because the reasoning for adding it was sound and the measurement
// still killed it.
//
// The worry was real: under the old full-scale-anchored curve an erroneously
// tiny T was self-limiting (the curve did nothing down there), whereas under a
// level-invariant curve reduction depends only on x/T, so a wrong T is punished
// in proportion. Guarding T against the measured noise floor looked principled
// and free — the detector already has that number.
//
// It fails on material without pauses. The floor estimate is a valley follower
// on fast RMS, so on a continuous tone it settles at the TONE's own level, the
// guard binds at signal+12 dB, and Headroom stops doing anything at all:
// measured 0.253 dB of reduction at every setting from 4 to 16 on a sustained
// synthetic. Real speech has pauses and would not have shown this.
//
// It is also unnecessary, which is the stronger reason. T is speechLevel plus
// a strictly POSITIVE Headroom, so it cannot be low relative to the tracker's
// estimate by construction — the only way T goes wrong is if the estimate
// itself is wrong, and that is covered twice over: the detector warm-up fixes
// the convergence case that prompted this, and MAX_REDUCTION_DB bounds the
// damage from any tracker error whatsoever. Two mechanisms for one hazard,
// where the second one is unconditional, did not justify a third that breaks
// a legitimate class of input.


/**
 * The stage's two shaping constants, and the two spec defects behind them.
 *
 * The curve in §4.4 is `y = T + (1-T)*tanh((|x|-T)/(1-T))`. It fails twice,
 * in ways that only show up on real files, and this codebase hit both.
 *
 * DEFECT 1 — IT CANNOT REACH ITS OWN OPERATING RANGE. That tanh argument is
 * (|x|-T)/(1-T), so at |x| = 1.0 — digital full scale, the loudest sample any
 * signal can contain — it is exactly 1.0 for EVERY threshold. The output there
 * is always T + tanh(1)*(1-T), bounding reduction at 2.37 dB as T approaches
 * zero and less for every real threshold. §7.1 of the same document calls
 * 3-6 dB the usable range and 6 dB a hard ceiling. Measured on a 35 s
 * narration clip normalised to -1 dBFS: peaks sat 17 dB over a correctly
 * placed threshold and the stage removed 1.82 dB.
 *
 * DEFECT 2 — IT IS NOT LEVEL-INVARIANT, WHICH IS THE ONE THING §3.3 SAYS THE
 * ADAPTIVE THRESHOLD BUYS. The `(1-T)` normalisation references digital full
 * scale, an absolute anchor. So the detector is carefully made level-invariant
 * and the curve then throws that away. Measured, with the detector held
 * perfect by construction (fixed mode, threshold moved in lockstep so the
 * overshoot is pinned at 17.6 dB): 14.36 dB of reduction at T = -6 dBFS,
 * 5.43 at -18, 0.53 at -30, 0.00 at -60. Identical relative dynamics, and the
 * stage quietly stops working as the file gets quieter. Combined with the old
 * T_MIN of -20 dBFS, 6 dB of input attenuation was enough to disable it.
 *
 * THE CURVE IS THEREFORE EXPRESSED IN dB, where both missing properties are
 * the natural ones:
 *
 *   e = 20*log10(|x| / T)                 excess over threshold, dB
 *   r = MAX_REDUCTION_DB * tanh^2(e / KNEE_DB)   reduction applied, dB
 *   y = |x| * 10^(-r/20)
 *
 * `e` is a RATIO, so scaling the input scales the output identically — level
 * invariance holds by construction rather than by calibration. `r` saturates,
 * so reduction is BOUNDED, which is what §1.1 asks for in prose ("does not
 * catch large outliers... transients beyond that pass through partially
 * attenuated and remain the downstream compressor's responsibility") and what
 * the original curve delivered only by accident, at a quarter of the stated
 * range.
 *
 * Every shape guarantee the spec claims still holds, and now for stated
 * reasons rather than incidental ones:
 *   - Unity below T — the early-out is untouched, still bit-transparent.
 *   - C1 at the knee: d(r)/d(e) = 0 at e = 0 because tanh^2 is flat there, so
 *     the dB-domain slope is 1 on both sides and the linear-domain slope with
 *     it. Verified numerically across four decades of threshold.
 *   - Monotonic: a louder input always produces a louder output, so the
 *     transfer curve never folds back on itself. Output in dB is e - r(e), so
 *     this needs d(r)/d(e) <= 1, and with r = rMax * tanh^n(e/knee) the slope
 *     peaks at (rMax/knee) * max_u [n * tanh^(n-1)(u) * sech^2(u)]. For n = 2
 *     that maximum is 0.7698, giving the familiar knee > 0.7698 * rMax; the
 *     per-shape bounds are SHAPE_MIN_KNEE_DB.
 *
 *     ⚠ A SINGLE FIGURE FOR "THE SHIPPED VALUE" NO LONGER EXISTS, and the one
 *     that used to sit here (0.404) went stale unnoticed when the shapes were
 *     given their own knees. Measured at the current knees, max d(r)/d(e) is
 *     0.544 / 0.643 / 0.717 for EARLY / MID / LATE — worst case 0.717 against
 *     a limit of 1, so the margin is real but smaller than the old number
 *     implied. Pinned in `test/dsp/softClipper.test.js` so it cannot drift
 *     again: a constant quoted in a comment with no test is how this one
 *     survived two knee changes.
 *   - Odd symmetric — sign applied outside. No DC term, no DC blocker.
 *   - Never boosts: r >= 0 always, so |y| <= |x| everywhere.
 *
 * BOUNDEDNESS IS A SAFETY PROPERTY HERE, NOT A PREFERENCE, and that was
 * measured too. Under the old full-scale anchor a badly wrong threshold was
 * self-limiting — the curve did nothing down there, so a bad T produced a
 * quiet no-op. Under any level-invariant curve, reduction depends only on
 * x/T, so a wrong T is punished in proportion. A first attempt at this fix
 * kept an unbounded invariant curve and was caught by the reported clip: at
 * t=0.46 s, while the 3 s speech tracker was still converging from its seed,
 * T sat at -46 dBFS and real speech arrived 29 dB above it, producing 29 dB of
 * reduction on a stage whose entire job is to remove 3-6. Invariance without
 * a bound converts every detector error into destruction.
 *
 * MAX_REDUCTION_DB = 6 is §7.1's own hard ceiling, now literally enforceable
 * rather than aspirational — the meter cannot read past it and the user cannot
 * dial past it.
 *
 * KNEE_DB = 7 is the only calibrated number, and it was RE-derived once the
 * tracker became peak-referenced. It was 11.4, set when a peak 17.6 dB over
 * threshold was the operating point — which it was only because the threshold
 * was RMS-referenced and therefore far too low. With T placed above typical
 * syllable peaks the samples that actually cross it sit 1-8 dB over (measured:
 * p50 1.2 dB, p90 3.0, max 6.1 at the default), so 11.4 delivered almost
 * nothing: 0.83 dB at the default where the meter's target zone starts at 3.
 *
 * THE TWO CONSTANTS DIVIDE THE WORK CLEANLY, which is the useful part.
 * Headroom (via the threshold) decides HOW MANY samples are touched;
 * KNEE_DB decides HOW MUCH those get reduced. Measured at the default, sweeping
 * KNEE_DB from 11.4 to 3 moved peak reduction 2.38 -> 5.92 dB with the touched
 * fraction pinned at exactly 6% of blocks throughout. So selectivity and depth
 * can be tuned independently, and depth must never be bought by lowering the
 * threshold — that is precisely the mistake that produced broadband distortion.
 *
 * 7 lands 3.17 dB of peak reduction at the default while touching 0.23% of
 * voiced samples. Below 4.62 the curve stops being monotonic (see above), so
 * the usable span is narrow and 6 was rejected for sitting too close to it.
 *
 * ⚠ One narrator, one clip; the first constant to re-derive against a wider
 * corpus.
 */
export const MAX_REDUCTION_DB = 6
export const KNEE_DB = 7

// ── Emphasis constants ──────────────────────────────────────────────────────

// ⚠ Spec flags the corner as "consider fixing in v1" (Open Question #1) —
// fixed here, which also means the pre/de-emphasis pair only ever needs one
// coefficient set per sample rate rather than one per (corner, gain) pair.
/**
 * WHAT THE EMPHASIS PAIR ACTUALLY COLOURS, measured after a user reported that
 * the stage's (pleasant) character is stronger on louder passages and stronger
 * at higher HF Emphasis settings. Both are real; the mechanism is not the
 * obvious one and is worth recording.
 *
 * The detector reads the UNFILTERED input, so T does not move when Emphasis
 * does — but the clipper sees the PRE-EMPHASISED signal. So raising Emphasis
 * lowers the effective threshold for HF-rich moments without moving it for
 * anything else. Measured on the reference clip at the default Headroom, the
 * fraction of voiced samples crossing the threshold goes 0.16% (emphasis 0) to
 * 0.26% (emphasis 12), and the share of blocks doing anything at all goes
 * 1% -> 2% -> 3% across 0 / 6 / 12.
 *
 * ⚠ THOSE TWO FIGURES ARE PRE-COMPENSATION and are no longer what the stage
 * does. The mechanism above is still exactly right — it is now the mechanism
 * the lift compensation exists to correct — but the threshold is no longer
 * held still while the signal is lifted into it: see LIFT_TAU_S, which gives
 * back the measured lift so that raising Emphasis re-AIMS the stage instead
 * of also deepening it. The counts above would need re-measuring on the same
 * clip, which is not available here.
 *
 * THE COLOURING IS BROADBAND, NOT HF-ONLY, which is the counter-intuitive part.
 * A crossing triggered by sibilance still applies a WIDEBAND gain reduction to
 * that instant, so the added modulation lands wherever the signal's energy is.
 * Residual against input, emphasis 0 -> 12 on loud frames: 100-300 Hz rises
 * 5.7 dB, 300-800 Hz 6.1 dB, 800 Hz-2 kHz 5.8 dB, but 3.5-6 kHz only 2.2 dB and
 * 6-16 kHz 2.0-2.5 dB. The high end rises LEAST precisely because de-emphasis
 * is pulling those harmonics back down — the pair is doing its §4.1 job; the
 * low-mid movement is the side effect §4.1 does not mention.
 *
 * NOTHING BELOW THE THRESHOLD IS TOUCHED, and that was checked separately
 * because the report described it as affecting material under the clip point:
 * frames whose peak sits below T measure -76 to -90 dBc of residual and are
 * bit-identical across emphasis 0, 6 and 12. Only frames that actually cross
 * carry the character (-40 / -37 / -31 dBc at emphasis 0 / 6 / 12).
 *
 * The reason it can read as "below the threshold" is the METER, not the audio:
 * of the blocks that do clip, the median reduction is 0.3-0.4 dB, which on a
 * 12 dB scale under VU ballistics is visually nothing. A passage can generate
 * audible harmonic character while the needle looks idle.
 */
const EMPHASIS_CORNER_HZ = 3500
const EMPHASIS_SLOPE_S = 0.7 // gentle shelf slope, avoids resonant overshoot at the corner
const EMPHASIS_EPSILON_DB = 0.001 // below this, treat as "0 dB" and skip the filters entirely
// Recompute shelf coefficients only when the ramped value has moved this far
// since the last computation — see deviation note (3) above.
const EMPHASIS_RECOMPUTE_EPS_DB = 0.05

/**
 * TIME CONSTANT FOR THE EMPHASIS LIFT COMPENSATION — the constant this whole
 * mechanism lives or dies on.
 *
 * WHY THE COMPENSATION EXISTS. The detector reads the UNFILTERED downmix but
 * the clip curve sees the pre-emphasised signal, so raising HF Emphasis lifts
 * every HF-rich peak toward a threshold that did not move. Measured on two
 * bursts of IDENTICAL peak amplitude differing only in spectrum, at Headroom
 * 6.5: the 110 Hz burst holds at 1.88 dB of reduction across the entire knob
 * — exactly, because de-emphasis is an algebraic inverse and a peak with no
 * energy above the corner comes back unchanged — while a fricative-shaped
 * burst goes 3.00 -> 5.85 dB. So the knob was a depth control as well as a
 * character one, the same defect SHAPE_ANCHOR_DB fixes for the knee, and for
 * the same reason: the thing that changes character also moves the effective
 * threshold.
 *
 * The fix is to measure how much the loud material is ACTUALLY being lifted
 * and give it back to the threshold. `liftDb` is the dB difference between a
 * peak follower on the pre-emphasised downmix and the existing one on the raw
 * downmix, so it is 0 on an all-LF passage, `emphasisDb` on an all-HF one, and
 * self-calibrating in between. Nothing is fitted.
 *
 * ⚠ THE BALLISTICS ARE THE DESIGN, NOT A TUNING. A fast tracker destroys the
 * feature by construction: a fricative arrives, raises the tracker, the
 * threshold rises with it, and the fricative gets no extra reduction — the
 * compensation would cancel precisely the selectivity it exists to preserve.
 * It must be far slower than the transients it is meant to leave alone, so it
 * runs on SPEECH_TAU_S, the same 3 s constant the speech tracker uses. The
 * reading is therefore per-passage ("this passage is sibilant-heavy, so the
 * ceiling sits higher") while individual fricatives still ride above it.
 * `test/dsp/softClipper.test.js` asserts a single fricative in a bed does not
 * move it — that test is the one a fast constant fails.
 *
 * BOUNDED BY CONSTRUCTION, not by a tuned guard. The pre-emphasis shelf is a
 * pure boost: swept at 3 dB, 6 and 12 its magnitude stays within [0, N] dB to
 * four decimals with no corner overshoot, so peak(emphasised) >= peak(raw)
 * always and liftDb lands in [0, emphasisDb]. It is clamped there anyway, so a
 * follower still filling from zero cannot produce a nonsense threshold during
 * the first milliseconds — the failure mode that produced 29 dB of reduction
 * at t = 0.46 s when the tracker was last given an unbounded quantity.
 */
const LIFT_TAU_S = SPEECH_TAU_S

/**
 * How far below the tracked speech level a moment may sit and still count
 * toward the lift measurement, in dB.
 *
 * WHY THE LIFT IS NOT MEASURED OVER ALL VOICED MATERIAL, which is what shipped
 * first and over-read it by roughly a factor of two on real narration. The
 * quantity being corrected is how much the PEAKS THAT REACH THE CURVE have
 * been lifted; averaging the follower ratio over every voiced sample instead
 * measures a different population, because fricative moments raise the
 * emphasised envelope during instants that never come near the threshold.
 *
 * Measured on 35 s of real narration at Headroom 6.5, against the lift that
 * would hold peak reduction flat across the knob (recovered from the stage's
 * own Headroom sensitivity, 0.62 dB of reduction per dB of threshold):
 *
 *   population                       HFE 6    HFE 12     target
 *   every voiced sample               0.68      1.74
 *   within 6 dB of the speech level   0.37      0.96
 *   within 3 dB of the speech level   0.34      0.85     0.31 / 0.85
 *
 * The loud-moment populations land on the target; the all-voiced one does not,
 * and the error is in the direction that made the compensation OVERSHOOT — it
 * raised the threshold for plosives, which carry no HF and were never lifted
 * at all, on evidence gathered from fricatives.
 *
 * 0 dB — "at or above the tracked speech level" — needs no calibration: the
 * tracker is already peak-referenced, so this is just "the moments Headroom is
 * measured from", which is exactly the population the threshold is placed for.
 *
 * WHAT THE GATE BUYS, on the same 35 s of real narration at Headroom 6.5.
 * Peak reduction across HF Emphasis 0 -> 12:
 *
 *   pre-compensation          3.02 -> 3.55 dB   (+0.53)
 *   compensated, ungated      3.02 -> 2.61      (-0.41)   sign flipped, not fixed
 *   compensated, gated        3.02 -> 2.92      (-0.10)
 *
 * and total added distortion over the same sweep -54.6 -> -52.1 dBFS
 * uncompensated against -54.6 -> -55.9 gated, while the count of samples the
 * curve touches still rises 1.8x — the aiming intact, the depth held.
 *
 * ⚠ IT DOES NOT HOLD PEAK REDUCTION FLAT ON EVERY FILE, and an earlier version
 * of this note claimed it did on the evidence of one narrator. Three real
 * files, Headroom 6.5, peak GR and total added distortion across HFE 0 -> 12:
 *
 *   file                    peak GR: pre-comp    compensated    residual dBFS
 *   A (normalised)           3.02 -> 3.55        3.02 -> 2.92    -54.6 -> -55.9  (was -52.1)
 *   B (raw)                  2.21 -> 5.63        2.21 -> 5.47    -58.5 -> -57.5  (was -53.9)
 *   C (hard-mastered)        2.77 -> 5.49        2.77 -> 5.17    -61.4 -> -53.7  (was -50.6)
 *
 * On A the depth holds. On B and C it does not, and the reason is structural
 * rather than a tuning error: the loud-moment average lift reads 0.65 and 1.63
 * dB there while the single deepest event is lifted by around 9 dB. Peak GR is
 * set by that one event. A statistic slow enough to leave an isolated fricative
 * its extra reduction — which is the whole feature — cannot also cancel the
 * extra reduction on a peak that IS an isolated fricative. THE TWO GOALS ARE
 * CONTRADICTORY, and this stage resolves them in favour of the aiming.
 *
 * WHAT IT DOES DELIVER, on all three: the BROAD inflation is removed. Growth
 * in total added distortion across the knob falls from +2.5 / +4.6 / +10.8 dB
 * to -1.3 / +1.0 / +7.7, and the growth in samples touched roughly halves
 * (C: 10x -> 6x). So "raising HFE quietly makes the whole stage work harder"
 * is fixed; "raising HFE never deepens anything" was never achievable and is
 * not claimed.
 *
 * ⚠ HARD-LIMITED MATERIAL IS THE WORST CASE, by a wide margin — file C is a
 * heavily mastered clip and shows 6x the crossings and +7.7 dB of distortion
 * at HFE 12 even compensated. Limiting flattens the peak envelope, so a small
 * threshold change moves an enormous number of samples across it. On that kind
 * of input HF Emphasis is a much stronger control than the panel implies.
 *
 * ⚠ THE SYNTHETIC CORPUS EXAGGERATED THE PROBLEM AND FLATTERED THE FIX. On its
 * sibilant bed the uncompensated drift was 4.4 dB and the compensated drift
 * -0.06; on real narration the numbers above. Real speech barely lifts its own
 * PEAK ENVELOPE even where it is rich in fricatives — 1.74 dB at emphasis 12
 * over all voiced samples, 0.85 over the loud ones — because a fricative does
 * not dominate a 1 ms / 150 ms follower the way first-differenced noise does.
 * Tenth time synthetic material has failed to answer the question asked of it,
 * and the first time it has erred by EXAGGERATING.
 */
const LIFT_GATE_DB = 0

// Fixed time constant for smoothing headroomDb / outputTrimDb toward their
// targets — see deviation note 3. Fast enough to feel immediate on a knob
// drag, slow enough that no step is audible as zipper noise.
const PARAM_SMOOTH_MS = 8

/**
 * Averaging window for the ENGAGED readout — the share of voiced blocks in
 * which the clip curve did anything at all.
 *
 * The peak-reduction meter answers "how much" and is structurally bad at
 * answering "whether": of the blocks that clip, the median reduction is
 * 0.3-0.4 dB, which on a 12 dB face under VU ballistics is visually nothing
 * (see the EMPHASIS_CORNER_HZ note). A share-of-blocks figure moves over a
 * legible range instead — measured 1% / 2% / 3% across emphasis 0 / 6 / 12 at
 * the default Headroom — and is the number that actually distinguishes "idle"
 * from "working quietly".
 *
 * Averaged over VOICED blocks only. Including pauses would make the reading a
 * function of how much silence the passage happens to contain rather than of
 * how hard the stage is working, and would drift toward zero on a slow reader
 * for reasons that have nothing to do with the setting.
 *
 * 2 s is long enough that a single plosive does not swing it and short enough
 * that moving Headroom shows up while the hand is still on the knob.
 */
const ENGAGED_TAU_S = 2.0

/**
 * Averaging window for the RESIDUAL readout — the level of what the stage is
 * removing, relative to the signal it was removed from.
 *
 * WHY A THIRD NUMBER. The lamp answers "how deep" and ENGAGED answers "how
 * often", and neither answers "how much damage". They come apart here more
 * than on any other stage in the app: measured across HF Emphasis on real
 * narration, peak reduction moves 0.1 dB while the residual moves 2.5, and on
 * one file the residual FALLS as the knob is raised while the number of
 * samples touched doubles. A setting that touches twice as much material for
 * less total distortion is strictly better, and neither of the existing
 * readouts can say so.
 *
 * REPORTED IN dBc, NOT dBFS — residual energy against dry energy over the same
 * blocks. Three reasons, in order of importance: it is invariant to how loud
 * the file happens to be, so two recordings can be compared; it is invariant
 * to Output Trim, which is a gain match for A/B and has no business moving a
 * diagnostic; and it is the unit this stage's own measurements are already
 * recorded in (see the emphasis note at EMPHASIS_CORNER_HZ, "-40 / -37 / -31
 * dBc at emphasis 0 / 6 / 12").
 *
 * ENERGY IS AVERAGED AND THEN CONVERTED, never the reverse. A mean of dB
 * values is a geometric mean of powers, which on a quantity that is zero for
 * most blocks and large for a few — exactly this one — reads far below the
 * actual ratio.
 *
 * AND THE TWO ENERGIES ARE SMOOTHED SEPARATELY, with the ratio taken at read
 * time. Smoothing the RATIO is the version that shipped first and it measures
 * something else: a per-block ratio is large wherever dry is small, so a
 * running mean of it is dominated by the quietest voiced blocks — the ones
 * carrying almost none of the actual distortion. Measured against a
 * whole-file energy ratio across HF Emphasis 0 -> 12, the smoothed-ratio
 * version reported a MINIMUM at 5-6 on a file whose true residual falls
 * monotonically to 12, and compressed a real 2.4 dB span to 0.4 dB on
 * another. Two smoothed energies and one division reproduce the whole-file
 * figure to a constant offset, which is what a readout used to compare
 * settings has to do.
 *
 * GATED ON VOICED BLOCKS, for the reason ENGAGED_TAU_S records: an ungated
 * average is a function of how much silence a passage happens to contain
 * rather than of what the stage is doing, and would drift toward zero on a
 * slow reader for reasons that have nothing to do with the setting.
 *
 * 2 s, matching ENGAGED, so the two figures beside each other describe the
 * same stretch of audio. A longer window would read steadier and would make
 * the two disagree about what "now" means.
 */
const RESIDUAL_TAU_S = 2.0

/**
 * Floor for the reported ratio, in dB.
 *
 * Before anything has been measured the ratio is 0/0, and the panel prints a
 * dash for this value rather than rendering an infinity.
 *
 * ⚠ IT IS NOT THE FLOOR THE READOUT ACTUALLY REACHES ON AUDIO, and the
 * difference is worth knowing before reading a low number as "clean". The
 * residual is taken between the RAW input and the finished output, so it
 * contains everything the stage does — including the oversampler's own
 * reconstruction error, which is present whether or not the curve fires.
 * Measured with the curve fully bypassed (Headroom 60, so nothing crosses):
 * -70.7 dBc on speech-like material, identical at every input level and at
 * every emphasis setting, which is what a linear error looks like.
 *
 * That is the readout's real noise floor. It sits 25-40 dB below the range
 * this stage produces in use (-30 to -45 dBc measured on three real
 * narrators), so it does not affect a comparison between settings — but a
 * reading near -70 means "the oversampler and nothing else", not "no
 * distortion at all".
 *
 * (A steady tone reports the floor instead, because the noise gate never opens
 * on continuous material and no block is ever counted. That is the trap this
 * file has recorded three times; it is not a property of the readout.)
 */
const RESIDUAL_FLOOR_DBC = -120

/**
 * ⚠ ASYMMETRY, ITS SKEW TRACKER AND ITS DC BLOCKER ARE GONE, and the reason is
 * worth keeping because it is the reason they could not be moved either.
 *
 * Asymmetry was a DC offset added before the clip curve and subtracted after
 * it — `softClip(x + off, T) - off` — and it was this stage's only source of
 * EVEN harmonics, which are the warmth people describe as tube or tape. It
 * worked, it was measured, and it is deleted anyway, because it was never a
 * separate process: add-then-subtract is the identity function, so the offset
 * did nothing whatsoever except reposition THIS curve. Every harmonic it
 * produced was this curve's own, generated off-centre.
 *
 * That is what made it unportable. HF Loss moved to Tube Saturation as a copy
 * because a shelf is a shelf anywhere; asymmetry could only have been
 * "moved" by writing a new offset against that plugin's tanh/arctan, with
 * different harmonic behaviour, its own bound argument, and none of the
 * recorded measurements carrying over. Tube Saturation is an asymmetric-capable
 * saturator already, so the capability is not lost — only this implementation
 * of it, inside a stage whose identity is transparency.
 *
 * ⚠ WHAT WENT WITH IT: the third-moment waveform-skew tracker that chose the
 * offset's sign (the offset had to lean AGAINST the material's own lean, worth
 * up to 7.9 dB of other distortion), and the 2 Hz DC blocker that existed only
 * to catch what the offset left behind. Neither had any other caller. If even
 * harmonics are ever wanted in this stage again, note that the sign question is
 * real and the deadband/evidence machinery that solved it is in this file's
 * history — a running skew estimate is off by three orders of magnitude at
 * half a second and latches the wrong sign if read early.
 */

/**
 * ⚠ HF LOSS LIVES IN TUBE SATURATION NOW (vocalSatProcessor.js).
 *
 * It was a first-order high shelf — `g*x + (1-g)*lowpass(x)` — with a constant
 * depth, and it had no dependence at all on the clip curve, the threshold or
 * the character reference. A linear filter with a knob on it, sitting inside a
 * stage whose identity is transparency. The move was a copy rather than a
 * re-derivation, which is exactly what "it never belonged here" looks like.
 *
 * Measured in its new home at full knob: -0.22 / -0.79 / -2.34 / -4.75 / -6.51
 * dB at 1k / 2k / 4k / 8k / 16k, and there it acts on the finished output
 * rather than a wet path, because it models the MEDIUM's bandwidth.
 */

/**
 * HYSTERESIS — a short-term memory of how hard the stage has been driven./**
 * HYSTERESIS — a short-term memory of how hard the stage has been driven.
 *
 * WHAT IT MODELS, AND WHAT IT DOES NOT CLAIM TO. Magnetic hysteresis is the
 * B-H loop: the medium's response depends on its history, not just on the
 * field applied now. This is the "lite" version the architecture asked for —
 * a one-pole lag, not a Jiles-Atherton model — and it should be described as a
 * memory effect rather than as a physical simulation of magnetisation.
 *
 * IT MODULATES THE THRESHOLD, AND THAT CHOICE IS THE WHOLE SAFETY ARGUMENT.
 * The obvious alternatives are to modulate the drive into the curve or the
 * knee, and both reshape the curve — which puts the monotonicity guarantee
 * (see MAX_REDUCTION_DB) back in play, on a curve already spending 0.717 of
 * its slope budget at LATE. Moving T instead TRANSLATES the curve without
 * changing its shape, and a translated monotonic curve is monotonic. The
 * guarantee survives by construction rather than by measurement.
 *
 * ⚠ WHAT DOES NOT SURVIVE, AND SHOULD NOT BE CLAIMED. "A louder input always
 * produces a louder output" is a statement about a MEMORYLESS curve. No
 * state-dependent gain can keep it — hold the input constant while the state
 * moves and the output changes on its own, which is what every compressor in
 * this app already does and what nobody calls a fold. The property that
 * actually prevents the destructive sound is NO INSTANTANEOUS FOLD: at any
 * frozen state the transfer curve is monotonic. That is what translating T
 * guarantees, and it is what the tests check.
 *
 * ⚠ IT IS PINNED AT 100 AND HAS NO KNOB — the SECOND time it was pinned, on
 * different evidence from the first, after listening.
 *
 * THE FIRST PIN WAS WRONG AND IS DESCRIBED BELOW; this one rests on a matched-
 * output-peak comparison and on hearing it. At matched output peak the memory
 * costs about 1 dB of total residual, but that total hides what it does: it
 * moves **2.6 dB of distortion OFF sustained speech and 1.3 dB ONTO onsets**
 * (onsets −28.54 → −27.24 dBc, sustained −50.50 → −53.08, onset advantage
 * 21.97 → 25.84 dB). Sustained speech is where distortion is most exposed, so
 * a worse total with a better distribution is a reasonable trade — and the
 * A/B confirmed it does no harm, if modestly.
 *
 * ⚠ PINNING IT MOVES THE DEFAULT HEADROOM 6.5 → 7.0, and this time the offset
 * is measured on OUTPUT PEAK rather than on peak gain reduction. The exact
 * match is 7.155; 7.0 is the step-grid value and lands the stock patch at
 * −3.095 dBFS against today's −2.986, a difference of 0.11 dB. ⚠ THE FIRST
 * PIN MOVED IT TO 7.5 ON THE PEAK-GR MATCH, which overstated the offset by a
 * full dB — the same error that invalidated the pin itself.
 *
 * Cost of leaving it on: the kernel runs at **54x realtime against 60x**
 * with it bypassed, measured over 60 s of audio in 128-sample blocks.
 *
 * ⚠ THE FIRST PIN WAS MADE ON A BROKEN MEASUREMENT and was reverted. The evidence was a "depth-matched" sweep that held PEAK
 * GAIN REDUCTION constant — the deepest reduction the curve applied at any one
 * instant. That is not what this stage does. Its job is peak CONTROL, and the
 * quantity that measures it is the OUTPUT PEAK. The two come apart precisely
 * because the memory dips the threshold on transients: a higher Headroom plus
 * a deeper dip produces the same reduction figure from a higher starting
 * point, so the peak lands higher while the meter reads the same.
 *
 * Re-matched on output peak, on the same 35 s of real narration, the result
 * inverts. Every row lands at -2.765 dBFS out:
 *
 *     setting                  Headroom   residual     touched
 *     hysteresis 0               6.98     -35.73 dBc    1.21%
 *     hysteresis 100             7.50     -34.66        1.01%
 *     slope 2.0 (cap 12)         7.72     -28.59        1.00%
 *     slope 4.0 (cap 24)         7.81     -24.38        1.01%
 *
 * Raising the slope is far WORSE at matched output peak — 6 dB more distortion
 * at slope 2, 10 dB at slope 4 — for the same peak control on the same share
 * of samples. And the memory itself costs about 1 dB: at matched output peak,
 * hysteresis 0 and 100 are identical on RMS and on every percentile of the
 * output level distribution (p99, p99.9, p99.99 all within 0.05 dB), so they
 * do the same job, and 0 does it with less distortion.
 *
 * WHAT IS LEFT IS A CHARACTER CONTROL, NOT A QUALITY ONE. The loop and the
 * onset bias below are real and measured; they are simply not free, and the
 * claim that they bought cleanliness was an artefact of the matching variable.
 * The default is 0, so the shipped patch is bit-identical to the build before
 * this existed, and the knob is on the panel for anyone who wants the effect.
 *
 * ⚠ THE LESSON IS THE MATCHING VARIABLE. "Depth-matched" is only meaningful
 * once the depth in question is the one the stage exists to deliver. Peak gain
 * reduction is an instrument reading; output peak is the deliverable. Matching
 * on the reading flattered every setting that reached the same reading by
 * doing more shaping from a higher threshold.
 *
 * WHERE THE LOOP COMES FROM — and it is NOT this stage's own ballistics.
 * The threshold moves DOWN with recent drive, so a level arrived at from below
 * maps to a different threshold than the same level arrived at from above, and
 * that difference is the loop. What supplies the asymmetry is the DETECTOR's
 * follower upstream (1 ms attack, 150 ms release), which is what `fastPeakDb`
 * has already been through by the time the memory sees it.
 *
 * ⚠ THIS SHIPPED WITH A SEPARATE 80 ms RELEASE AND THE RELEASE DID NOTHING.
 * A one-pole chasing a signal that already falls with a 150 ms release just
 * tracks it. Swept 5 / 80 / 150 / 300 / 600 / 1200 ms against a fixed 5 ms
 * attack, the measured loop width is **identical to three decimals at every
 * value** — 1.881 dB on a 100 ms ramp, 1.508 on a 500 ms one. A constant that
 * cannot move any measurement is not a tuning, so there is one time constant
 * here rather than two, and the comment that credited the loop to asymmetric
 * ballistics was wrong: symmetric 5/5 reproduces 5/80 exactly.
 */
const HYST_MAX_DB = 3

/**
 * dB the threshold drops per dB the signal runs over it. THIS IS THE ONE
 * PARAMETER — everything else about the memory's depth is bookkeeping.
 *
 * ⚠ IT WAS TWO CONSTANTS AND ONE OF THEM WAS REDUNDANT. The depression used to
 * be written as `HYST_MAX_DB * min(1, over / HYST_KNEE_DB)`, which reads as a
 * depth and a saturation point. Measured depth-matched on real narration, the
 * pairs (3, 3), (6, 6) and (12, 12) are IDENTICAL on every metric — residual,
 * samples touched, output crest, the Headroom needed — because the clamp never
 * binds on real material, so only the RATIO ever did anything. Two names, one
 * degree of freedom, and the quantity that actually mattered had no name at
 * all. Written this way the slope is the constant and the cap is a bound.
 *
 * 0.5 is exactly the old 3 / 6, so this reparameterisation is bit-identical on
 * real audio — verified sample for sample, not argued from the algebra.
 *
 * ⚠ RAISING IT IS WORSE, AND AN EARLIER NOTE HERE CLAIMED THE OPPOSITE.
 * That claim came from a sweep matched on peak gain reduction, which is an
 * instrument reading rather than the stage's deliverable — see HYST_MAX_DB for
 * the full retraction. Matched on OUTPUT PEAK, which is what a peak-control
 * stage is for, slope 0.5 / 2.0 / 4.0 give residual -34.66 / -28.59 / -24.38
 * dBc on 1.01 / 1.00 / 1.01% of samples: the same peak control, the same
 * coverage, and up to 10 dB more distortion. There is nothing to gain here.
 */
const HYST_SLOPE_DB_PER_DB = 0.5

/**
 * The memory's time constant, ms.
 *
 * Milliseconds, not microseconds: this has to be slow enough to read as the
 * stage responding to a passage rather than as waveshaping — a state that
 * moved at audio rate would be a nonlinearity wearing an envelope's clothing,
 * and would put the fold risk straight back.
 *
 * Loop width at hysteresis 100, by ramp speed (hyst 0 baseline 0.614 / 0.328 /
 * 0.119 dB):
 *
 *     tau      100 ms   200 ms   2 s
 *     0.5 ms    1.570    1.349   0.557
 *       5 ms    1.881    1.522   0.653
 *      30 ms    2.135    1.801   1.083
 *
 * It is a slope, not a knee, so 5 is a choice rather than a fit: far enough
 * above the detector's own 1 ms attack to add something, far enough below the
 * syllable rate that the effect stays tied to transients instead of becoming a
 * third level control.
 */
const HYST_TAU_MS = 5

/** Below this the memory is bypassed and the threshold is untouched. */
const HYST_EPSILON = 1e-4

/**
 * ⚠ SOFTEN AND ITS CHARACTER REFERENCE HAVE LEFT — dsp/tapeCharacter.js.
 *
 * Soften limited how fast the waveform could move, inside the oversampled path
 * just ahead of the curve. It worked and it was measured: 4-10 kHz program down
 * 3.31 dB at full knob while cutting the curve's own residual by 3.9 dB overall
 * and 10 dB above 8 kHz, with output peak unmoved at every setting. It is gone
 * from here anyway, and the reason is the same one that removed asymmetry and
 * HF Loss before it: this stage is peak control, and a colour that forfeits the
 * stage's first guarantee has no business inside it.
 *
 * ⚠ IT FORFEITED "UNITY BELOW T", WHICH IS THE POINT. At scale 1 the limit
 * provably cannot bind on material at or below T — and measured, that means it
 * does exactly nothing on real narration, because the fastest instant anywhere
 * in a real file is slope/T 0.157 at emphasis 0 and 0.273 at 6, against a bound
 * of 0.785. To do anything at all it had to bind below the threshold. The
 * stage's stated guarantee had to read "unity below T WHEN SOFTEN IS 0" for as
 * long as it lived here; it now reads without the qualifier.
 *
 * ⚠ IT ALSO COST A PREVIEW/APPLY MISMATCH, and that is worth carrying forward
 * to whatever uses it next. Its allowance scaled with a reference; while that
 * reference was the speech tracker, a live preview (tracker settled) and an
 * offline region render (tracker cold) disagreed by 1.5-2.3 dB, always with the
 * preview more softened. Referencing it to the motionless ceiling fixed that to
 * within 0.01 dB. Any reuse must reference it to something that is the same at
 * sample 0 as it is in steady state.
 *
 * The full account, the Bernstein bound, the constants and the three
 * placement measurements are in dsp/tapeCharacter.js.
 */

/**
 * HYBRID PEAK PATH — a lookahead limiter ahead of the curve./**
 * HYBRID PEAK PATH — a lookahead limiter ahead of the curve.
 *
 * The curve takes peaks down by reshaping samples, which generates genuine
 * in-band harmonics: −16 dBc at 13 dB of drive, and 8× oversampling changes it
 * by nothing, so the distortion is not fold-back and cannot be filtered away.
 * The limiter takes the same peaks down with a smooth gain envelope instead —
 * its error is intermodulation and slight pumping rather than a harmonic series
 * on the voice. Running it first means most of the peak reduction stops passing
 * through the distortion-generating path at all, and the curve is left catching
 * what slips past: intersample peaks and whatever the smoothing lets through.
 *
 * THE KNOB IS A BALANCE, NOT A DEPTH. The limiter aims at a ceiling ABOVE the
 * stage's threshold, and the knob closes that gap: at 0 the ceiling is
 * LIMITER_MAX_ABOVE_DB above T and the limiter is bypassed outright; at 100 it
 * aims at T itself and does as much of the work as it can. So the knob decides
 * how the peak control is SHARED, and Headroom still decides how much there is.
 *
 * ⚠ IT ADDS LATENCY, and that is not free. The limiter's is 2L — about 4 ms at
 * the default half-width, against the oversampler's ~1 ms — so the stage's
 * reported latency roughly quintuples while it is engaged. The offline apply
 * path reads `latencySamples` and is correct either way; toggling it under a
 * running preview shifts the timeline by that much, which is why it is a
 * research control rather than something to automate.
 *
 * ⚠ THE LIMITER'S GAIN REDUCTION IS DELIBERATELY NOT COUNTED AS RESIDUAL. The
 * dry side of the residual measurement is fed POST-limiter, so RESIDUAL keeps
 * meaning "what the curve added" rather than silently absorbing intended gain
 * change. Conflating the two is exactly what made a direct residual comparison
 * between the limiter and the curve meaningless.
 */
const LIMITER_MAX_ABOVE_DB = 12

/** Lookahead half-width in ms; total added latency is twice this. */
const LIMITER_LOOKAHEAD_MS = 2

const LN10_OVER_20 = Math.LN10 / 20

export const SOFT_CLIPPER_KERNEL_DEFAULTS = {
  // 4-16, primary control — lower means more clipping.
  //
  // 6.5 rather than 8 because the default knee moved to tanh^3, which takes
  // less at a given Headroom: on the reference clip 8 delivered 3.15 dB of
  // peak reduction under tanh^2 and 2.28 under tanh^3, dropping the stock
  // patch below the 3-6 dB the lamp's own guidance calls the usable range on
  // speech. 6.5 restores 3.21 dB with the shipped knee. The two defaults are
  // coupled through the shape table and must move together.
  //
  // RE-MEASURED ON A SECOND NARRATOR and left alone. That file lands on
  // exactly 3.21 dB at this Headroom on the pre-compensation build — the same
  // figure, a different voice — which is the strongest evidence this constant
  // has. The emphasis lift compensation then costs the stock patch 0.24 dB
  // (3.21 -> 2.97), and 6.35 would return it. Not taken: 0.24 dB is well
  // inside the spread between two narrators, and moving a shipped default to
  // chase it on a sample of one is how a constant stops meaning anything.
  // (The ungated lift cost 0.36 dB and did argue for a move; the gate removed
  // most of the shortfall along with the over-compensation that caused it.)
  //
  // ⚠ IT IS 7.0 NOW, and every figure above refers to the 6.5 scale.
  // Hysteresis is pinned at 100 (see HYST_MAX_DB) and is worth 0.66 dB of
  // effective headroom measured on OUTPUT PEAK — the exact match is 7.155, and
  // 7.0 is the step-grid value, landing the stock patch at −3.095 dBFS against
  // 6.5/hysteresis-0's −2.986. ⚠ An earlier revision moved this to 7.5 for the
  // same reason and was wrong by a full dB, because it matched on peak gain
  // reduction rather than on output peak. This default and the shape table are
  // still coupled.
  //
  // The knee default has since moved to tanh^4, which does NOT unsettle this
  // the way the tanh^2 -> tanh^3 move did: with the per-shape knees anchored
  // at SHAPE_ANCHOR_DB the three positions land within a few tenths of a dB
  // of each other on real crossings (2.77 / 2.97 / 3.11 dB at Headroom 6.5 on
  // the reference clip), which is the whole point of anchoring them. The
  // coupling is real but is now worth tenths rather than a dB.
  headroomDb: 7.0,
  // ⚠ ZERO, AND THE PANEL'S CONTRACT REQUIRES IT.
  //
  // The panel is one ceiling in dBFS whose caption is "peaks stop here". Any
  // non-zero emphasis breaks that promise, and not by a fixed offset that could
  // be compensated away: the curve compares the PRE-EMPHASISED signal against
  // the threshold, so where a sample crosses depends on ITS OWN HF content. The
  // lift compensation raises T by the average lift measured at loud moments,
  // which is the right thing for holding depth and the wrong thing here — a
  // file whose loudest peaks are low-frequency has them pushed FURTHER below a
  // threshold raised on account of its sibilants.
  //
  // Reported from use on a tutorial recording: "almost no lowering of the
  // loudest peaks even on HARD or SQUASH", and "dragging the threshold into the
  // body of the waveform doesn't match the reduction that actually occurs".
  // Both were one bug. Measured on that file, its 20 loudest 10 ms blocks carry
  // -22.6 dB of HF-to-LF energy against -6.3 dB at median loudness — the peaks
  // are nearly pure low frequency — so they took no lift while T rose 2.67 dB,
  // and SQUASH delivered 0.000 dB of peak reduction where the same patch at
  // emphasis 0 delivers 4.027.
  //
  // OUTPUT PEAK MINUS THE CEILING SET, four real files x two presets:
  // at emphasis 7, peaks escape by 1.43 / 1.47 / 3.13 / 3.13 / 1.77 / 2.58 /
  // 4.03 / 5.04 dB; at emphasis 0 it is 0.000 on every one of them.
  //
  // ⚠ THE AIMING IS GENUINELY LOST, and that is the trade. Non-zero emphasis
  // decides WHICH transients the curve works on, which is a real feature and
  // was never measured; what it cannot coexist with is a single dBFS number
  // that says where peaks stop. The panel chose the number. `emphasisDb` is
  // still a live kernel parameter and the admin tuning panel can still set it,
  // so the aiming is one flag away for anyone measuring it.
  //
  // It also happens to be the cleanest setting: peak-matched, 0 beats every
  // other value by 2.2-3.4 dB of residual (see the DRIVE notes in CLAUDE.md).
  emphasisDb: 0,
  outputTrimDb: 0, // ±6, post-stage gain match for A/B
  // 'adaptive' | 'fixed'.
  //
  // ⚠ THE PANEL ONLY OFFERS FIXED. Adaptive survives here as the kernel default
  // and for the tests that measure what a moving threshold costs — see the
  // adaptive-vs-fixed measurements in CLAUDE.md, which are why the panel stopped
  // offering it. A third 'static' mode (speech level + Headroom, measured once)
  // existed briefly and was removed: a ceiling the user can read and turn in
  // dBFS is the same motionless threshold expressed more directly, and two
  // parameterisations of one idea is the duplication this codebase keeps
  // learning not to ship.
  thresholdMode: 'adaptive',
  fixedThresholdDb: -10, // used only in 'fixed' mode
  // 'tanh2' | 'tanh3' | 'tanh4' — knee contact order, see SHAPE_EXPONENT.
  //
  // ⚠ THIS IS NOT THE CALIBRATED SHAPE, and the two used to be the same thing.
  // KNEE_DB is a measurement of tanh^3; the per-shape knees are anchored onto
  // it via SHAPE_KNEE_ANCHOR_SHAPE, which is stated separately precisely so
  // that moving this line changes which curve opens by default and nothing
  // else. While the anchor read this field, moving it here re-derived all
  // three curves — see the note above SHAPE_KNEE_DB.
  //
  // ⚠ OFF THE FACEPLATE: the KNEE switch lives on the hidden admin tuning
  // panel. Peak-matched the shapes are worth at most 0.7 dB of residual
  // against HF Emphasis's 3.4, which is the smaller lever by a factor of five.
  shape: 'tanh4',
  // 0-100, how much of the peak control the lookahead limiter takes from the
  // curve — see LIMITER_MAX_ABOVE_DB. 0 bypasses it entirely, including its
  // latency, so limiter 0 is bit-identical to the build before it existed.
  //
  // ⚠ THE DEFAULT IS 100 NOW, WHICH IS NOT A COSMETIC DEFAULT. The stage
  // delays by 242 samples rather than 50, and the limiter's gain envelope is
  // smoothed over its lookahead window, so it reaches BELOW the threshold —
  // measured at 24-36% of sub-threshold samples reduced by 2.2-5.4 dB. "Unity
  // below T" is a property of the CURVE, and at this default the curve is no
  // longer the only thing acting. What it buys is 2-9 dB less shaping residual
  // for the same peak control, growing with how hard the material is.
  //
  // ⚠ EVERY CURVE-ONLY MEASUREMENT MUST SET limiter: 0 EXPLICITLY. The test
  // suite does; anything measuring the curve against this default is measuring
  // the limiter and calling it the curve.
  limiter: 100,
  // 0-100, share of HYST_MAX_DB. PINNED AT 100 and not exposed — see
  // HYST_MAX_DB. Kept as a param only so the tests can run 0 against 100.
  hysteresis: 100,
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
 * KNEE SHAPES — the exponent on tanh, and what it actually buys.
 *
 * ⚠ READ SHAPE_ANCHOR_DB FIRST. Each shape now carries its OWN knee, set so
 * all three deliver identical reduction at a peak SHAPE_ANCHOR_DB over the
 * threshold. Every figure in this block that predates that change describes a
 * SHARED knee of 7 and is marked; under a shared knee the exponent was a
 * depth control as much as a shape one, which is the defect the anchor fixes.
 *
 * THE DEFAULT IS tanh^3, chosen by ear rather than by table, and it is the
 * shape the other two are normalised ONTO — so nothing below changes for
 * anyone who leaves the switch alone. At the shipped knees a peak 3 dB over
 * the threshold loses 0.69 / 0.40 / 0.24 dB across n = 2 / 3 / 4, a peak
 * SHAPE_ANCHOR_DB (8 dB) over loses 3.25 whichever is selected, and a peak
 * 12 dB over loses 4.73 / 4.94 / 5.07. The exponent is now what its label
 * claims: where in the overshoot range the reduction is spent, pivoting about
 * the anchor.
 *
 * tanh^2 was the original curve; listening at a fixed threshold found it the
 * most audibly distorted of the three, and tanh^4 the least distorted but the
 * most conspicuous about what remained (see the sparsity note below). tanh^3
 * is the position that was preferred. ⚠ That listening was done at the shared
 * knee, so most of "least distorted" was "did least" — see the matched-depth
 * measurement below for how much of the difference survives normalisation.
 *
 * The reduction law is r = rMax * tanh^n(e / knee). Near the threshold
 * tanh(u) ~ u, so r ~ (e/knee)^n and the exponent IS the order of contact: the
 * gain curve joins the unity region with n-1 vanishing derivatives. n = 2 is
 * C1, n = 3 is C2, n = 4 is C3.
 *
 * WHAT IT CHANGES IS SELECTIVITY, NOT DISTORTION, and that ordering was
 * measured rather than assumed. Matched BY HAND at 3 dB of reduction on a peak
 * 12 dB over threshold (so the shapes are compared doing the same amount of
 * work) — this table is what SHAPE_ANCHOR_DB later made structural, at an
 * anchor of 6 dB rather than 12 because that is where real peaks sit:
 *
 *   shape   reduction at +3 dB / +6 / +12 / +18 dB excess   %harmonic energy above H11
 *   tanh^2      0.28    1.03    3.00    4.51                     0.131
 *   tanh^3      0.11    0.72    3.00    4.75                     0.102
 *   tanh^4      0.05    0.53    3.00    4.90                     0.068
 *
 * The harmonic tail moves by a factor of two on a quantity that is already a
 * tenth of a percent — audibly nothing on its own. The left-hand columns are
 * the real difference: at +3 dB of excess tanh^4 does a SIXTH of what tanh^2
 * does, then catches up and passes it on the big transients.
 *
 * ⚠ PRE-NORMALISATION (shared knee 7). ON A REAL FILE, AT A FIXED HEADROOM,
 * THAT LANDED AS STRICTLY LESS WORK ON BOTH AXES — which is exactly the defect
 * SHAPE_ANCHOR_DB exists to remove, and it was captioned as a feature for one
 * release. 35 s of real narration, Headroom 8, emphasis 6:
 *
 *   shape   peak GR   voiced samples touched   mean GR on those samples
 *   tanh^2   3.15 dB          0.293%                   0.358 dB
 *   tanh^3   2.28 dB          0.195%                   0.216 dB
 *   tanh^4   1.66 dB          0.126%                   0.150 dB
 *
 * ⚠ PRE-NORMALISATION, AND STILL LIVE AS A WARNING: MATCHING THE DEPTH BACK
 * BY EAR REVERSES IT. Normalisation matches depth by moving the KNEE, which
 * leaves the threshold — and therefore the set of touched samples — untouched.
 * Matching it with the Headroom knob instead does not, and is worth knowing
 * before reaching for that knob to compensate. Depth is matched by LOWERING
 * Headroom, which lowers the threshold, which brings more samples over the
 * line — and that move dominates the shape's selectivity. Same clip, each
 * shape walked down to tanh^2's 3.15 dB of peak reduction:
 *
 *   shape   Headroom   peak GR   voiced samples touched   mean GR on those
 *   tanh^2     8.0      3.15            0.293%                 0.358
 *   tanh^3     6.5      3.21            0.403%                 0.331
 *   tanh^4     5.5      3.21            0.465%                 0.308
 *
 * So at matched depth the higher shapes are BROADER, not narrower: a smaller
 * amount spread over more samples. The selectivity is real in excess-dB terms
 * and is measured at a FIXED threshold; the user does not hold the threshold
 * fixed when chasing depth. Read this control as "how much it does at your
 * current Headroom", not as "the same result, more surgically".
 *
 * (The matched-GR synthetic figures above predicted the opposite, and one real
 * file settled it in one measurement. Eighth time synthetic material has been
 * too clean to answer the question asked of it.)
 *
 * WHAT THE HIGHER SHAPES SOUND LIKE (⚠ pre-normalisation, shared knee 7), and
 * why the two halves of that have different causes. Reported from listening at
 * a FIXED threshold: tanh^3 and
 * tanh^4 distort audibly less overall, but the peaks that do cross read as
 * "grindy" where tanh^2 reads as "buzzy". Both are real and neither is the
 * harmonic-tail number above.
 *
 * The first half is simply level. Residual (input minus output, the DELTA
 * path) on the reference clip at Headroom 8: -54.9 / -59.8 / -64.1 dB RMS.
 * tanh^4 adds 9.2 dB less distortion than tanh^2 at the same threshold.
 *
 * The second half is SPARSITY, not tone. The residual's SPECTRUM barely moves
 * between shapes — centroid 1485 / 1518 / 1556 Hz, energy above 4 kHz 5.1% /
 * 5.5% / 5.8% — so the difference cannot be brightness. Its TIME structure
 * moves a lot: crest factor 43.0 / 45.3 / 46.9 dB and audible bursts 3.9 /
 * 2.4 / 1.4 per second, at an unchanged ~0.1 ms each. tanh^4's distortion is
 * a third as many isolated ticks; tanh^2's is a more continuous stream that
 * the voice masks. Sparse distortion is more conspicuous per unit energy than
 * continuous distortion, which is why halving the energy can still leave the
 * remainder easier to notice.
 *
 * Consistent with the harmonic structure at a fixed threshold, where the
 * higher shapes are LOWER-order, not higher: on a peak 14 dB over, H3/H5/H7
 * run 76/53/32% of the distortion for tanh^2 against 86/47/19% for tanh^4,
 * energy-weighted harmonic centroid 4.25 vs 3.63. Low-order is rough, spread
 * high-order is fizzy — grind and buzz respectively.
 *
 * NOT ALIASING, checked because inharmonic products are the usual suspect for
 * "grindy" and would have argued for more than 4x oversampling. Through the
 * full kernel in fixed mode at 48 kHz, inharmonic energy is 0.22-0.29% of the
 * distortion at 220 Hz / 1.5 kHz / 4 kHz and is the same for all three shapes.
 * (The first attempt at this probe used adaptive mode on a steady tone, whose
 * gate never opens, so it measured a stage that was not running — the same
 * trap recorded further up this file.)
 *
 * ⚠ This is the argument against adding tanh^5 and beyond: each step buys less
 * total distortion and makes what survives more isolated, and past some point
 * the second effect wins.
 *
 * WHY NOT THE SMOOTHSTEP FAMILY, which scored better on the harmonic tail
 * (0.025-0.092%): monotonicity needs knee > rMax * max s'(u), and for
 * smoothstep / smootherstep / smoothest-step that is 9.00 / 11.25 / 13.13 dB
 * against our KNEE_DB of 7. They FOLD the waveform at the shipped calibration.
 * They are reachable only by re-deriving the knee, which moves every other
 * measurement in this file, so they were left out rather than half-adopted.
 *
 * The tanh family costs nothing here — its bound goes 4.62 / 4.50 / 4.46 dB as
 * n rises, so every shape offered is monotonic with room to spare, and raising
 * n makes the constraint slightly looser rather than tighter. Normalisation
 * spends part of that room (the knees are 9.08 / 7 / 6.01), and every one
 * still clears its bound. Pinned in `test/dsp/softClipper.test.js` against the
 * shipped per-shape knees.
 *
 * ── WHAT NORMALISATION COSTS AND BUYS, MEASURED ────────────────────────────
 *
 * Reported symptom: LATE sounds cleaner at the same threshold, and it is hard
 * to tell whether that is character or simply less processing. It was mostly
 * the latter, and the size of it is the point.
 *
 * The honest probe is a signal whose crossings reproduce the real narration
 * distribution recorded at KNEE_DB (p50 1.2 dB over, p90 3.0, max 6.1). The
 * corpus's own speechLike() does NOT — at the default its syllables never
 * reach the threshold at all, so the entire output is one outlier and the
 * shapes have nothing to redistribute between. A wider-dynamics variant at
 * Headroom 4 lands at p50 1.25 / p90 2.93 / max 4.16, and on that:
 *
 *   shared knee 7      peak GR 1.72 / 0.92 / 0.49 dB   residual -48.1 / -55.3 / -62.0 dBFS
 *   per-shape knees    peak GR 1.12 / 0.92 / 0.79 dB   residual -52.0 / -55.3 / -57.8 dBFS
 *
 * So the old switch changed the depth by 3.5x and the distortion by 13.9 dB
 * together — a shape control that was mostly a second, hidden depth control.
 * Normalised, depth holds to a 0.33 dB spread and 5.8 dB of distortion
 * difference survives. THAT REMAINDER IS THE CONTROL: the same depth spent on
 * fewer, deeper crossings.
 *
 * ⚠ Depth matches EXACTLY only at the anchor, by construction. On a probe
 * whose outlier sits 6.65 dB over, peak GR goes 3.29 / 2.43 / 1.80 dB before
 * and 2.34 / 2.43 / 2.50 after — a 1.49 dB spread down to 0.15. On one whose
 * outlier sits 10.35 dB over, well past the anchor, 0.92 down to 0.67: the
 * shapes are diverging again above the anchor, in the opposite direction, and
 * that is the design rather than a shortfall.
 */
export const SHAPE_EXPONENT = { tanh2: 2, tanh3: 3, tanh4: 4 }

/**
 * Smallest KNEE_DB that keeps each shape monotonic at MAX_REDUCTION_DB, i.e.
 * rMax * max_u d/du tanh^n(u). Recorded so the guard test compares against
 * stated numbers rather than re-deriving them from the same code it checks.
 */
export const SHAPE_MIN_KNEE_DB = { tanh2: 4.62, tanh3: 4.50, tanh4: 4.46 }

/**
 * EXCESS AT WHICH ALL THREE SHAPES DELIVER THE SAME REDUCTION.
 *
 * WHY THE SHAPES ARE KNEE-NORMALISED AT ALL, and the reported symptom that
 * forced it: switching to LATE at a fixed threshold "sounds cleaner", and it
 * does — because it is doing less. At one shared KNEE_DB, tanh^n < tanh^2
 * everywhere for n > 2 (t < 1, so each extra factor can only take away), so
 * raising the shape lowered the reduction at EVERY excess and only converged
 * back at the bound. The switch was therefore a depth control wearing a shape
 * control's label, and no A/B through it was ever comparing shapes: it was
 * comparing amounts. That the two were tangled is already recorded upstream —
 * the default Headroom had to move 8 -> 6.5 when the default shape moved
 * tanh^2 -> tanh^3, purely to put the depth back.
 *
 * Each shape now gets its OWN knee, chosen so that a peak this far over the
 * threshold receives identical reduction whichever shape is selected. What
 * changes is only how that reduction is DISTRIBUTED across overshoot depth:
 * below the anchor EARLY does more, above it LATE does more, and they cross
 * exactly here. That is what a knee control is, and it is also the behaviour
 * the panel's own captions have always described.
 *
 * ⚠ THIS DOES NOT MAKE THE SHAPES EQUAL IN TOTAL WORK ON A FILE, and it must
 * not be read that way. Only the anchor point is pinned. Real speech puts most
 * of its crossings well below the anchor, so EARLY still touches those harder
 * and still produces more total distortion — the difference is that the DEEP
 * transients the stage exists for now land in the same place, which is what
 * the lamp reads and what "how hard is this thing working" means to the ear.
 *
 * 8 dB IS A MIN-MAX FIT OVER THREE REAL NARRATORS, and the number it replaces
 * was derived from a broken proxy.
 *
 * ⚠ THE CROSSING FIGURES QUOTED AT KNEE_DB (p50 1.2 dB, p90 3.0, max 6.1) ARE
 * MEASURED ON THE RAW SIGNAL AT BASE RATE. The curve does not see that signal:
 * it sees the PRE-EMPHASISED, 4x OVERSAMPLED one, whose peaks are higher. The
 * anchor was originally set to 6 from those figures, which is the wrong
 * domain. Recovering the excess the curve actually saw — by inverting the
 * shipped curve through the reduction it actually applied, which needs no new
 * instrumentation — gives, at the default Headroom:
 *
 *   file                     raw-signal proxy max    true max excess
 *   narrator A (normalised)          7.19                  7.52
 *   narrator B (raw)                 5.58                  9.95
 *   narrator C (hard-mastered)       6.28                  9.24
 *
 * The proxy under-reads by 0.3 to 4.4 dB, and it under-reads MOST on the files
 * where the stage works hardest.
 *
 * Peak-GR spread across the three shapes is a pure function of the true excess
 * and the anchor, so it can be swept exactly over the excesses those files
 * produce across Headroom 4-8 — the range where the stage does real work (at
 * Headroom 10 it delivers 0.74 dB and matching there is worth little):
 *
 *   anchor      6     7     8    8.5     9    9.5    10
 *   mean      0.53  0.34  0.22  0.19   0.17  0.17   0.18
 *   worst     0.68  0.48  0.36  0.42   0.48  0.54   0.59
 *
 * 8 minimises the WORST case and sits within 0.05 dB of the best mean. Lower
 * anchors do better at high Headroom, where the excess is small; higher ones
 * at low Headroom. The optimum is broad, which is the useful part — the exact
 * value is not load-bearing, and anything from 7 to 9 beats the shipped 6.
 *
 * Pinning the anchor near where real peaks land is what makes peak reduction —
 * the reading the meter shows and the user hears as depth — hold still across
 * the switch, while the p50/p90 bulk stays free to differ, which is the
 * character.
 *
 * ⚠ MOVING THE ANCHOR CANNOT MOVE THE DEFAULT PATCH. The default shape's knee
 * is RETURNED as KNEE_DB rather than recomputed (see SHAPE_KNEE_DB), so only
 * the two non-default positions change. That is what made this re-derivation
 * safe to do at all.
 *
 * ⚠ ANCHOR IS THE ONE CONSTANT HERE THAT SYNTHETIC MATERIAL CANNOT CHECK. The
 * test corpus's speechLike() puts its crossings at p50 9.6 dB / max 11.5 —
 * ABOVE the anchor rather than below it — so on synthetics the ordering it
 * produces is the reverse of the one on speech.
 *
 * CONFIRMED ON A SECOND REAL NARRATOR, 35 s at the shipped default: crossings
 * sit at p50 1.32 dB / p90 3.45 / p99 5.82 / max 6.99, against the p50 1.2 /
 * p90 3.0 / max 6.1 recorded at KNEE_DB from a different clip. 6 dB sits
 * between that file's p99 and its max, which is where the anchor is meant to
 * be, so it is left as it stands.
 *
 * END TO END ON THE SAME FILE, peak reduction across EARLY / MID / LATE:
 *
 *   Headroom   shared knee 7        per-shape knees      spread
 *      5      4.57 3.99 3.49 (1.09)  3.46 3.80 4.03 (0.57)
 *      6.5    3.95 3.21 2.60 (1.35)  2.77 2.97 3.11 (0.34)
 *      8      3.15 2.28 1.66 (1.50)  2.02 2.02 2.03 (0.00)
 *
 * A 4x tightening at the default and exact at Headroom 8, where that file's
 * crossings top out at 5.49 dB — just under the anchor.
 */
export const SHAPE_ANCHOR_DB = 8

/**
 * Per-shape knee, derived from the anchor rather than tabulated.
 *
 * Anchored ON THE CALIBRATED SHAPE at the shipped KNEE_DB, so that curve is
 * bit-identical to the one that shipped before normalisation and every figure
 * measured against it still holds. Only the two other positions are derived,
 * and each is derived toward the calibrated one's depth.
 *
 * ⚠ THE ANCHOR SHAPE IS NOT THE DEFAULT SHAPE, and tying the two together was
 * a real defect for the time it existed. KNEE_DB = 7 is a measurement of
 * tanh^3 — the one calibrated number in this stage — so reading the anchor off
 * `SOFT_CLIPPER_KERNEL_DEFAULTS.shape` meant that changing which position the
 * panel opens on silently re-derived ALL THREE curves: moving the default to
 * tanh^4 took the knees from 8.490 / 7 / 6.221 to 9.982 / 7.997 / 7, i.e. the
 * whole family got shallower (2.57 dB at the anchor against 3.25) from an edit
 * that reads as a UI preference. Which curve is calibrated and which curve
 * opens by default are separate facts and are now written separately.
 *
 * Solving tanh^n(A/k_n) = tanh^d(A/KNEE_DB) for k_n gives
 *   k_n = A / atanh( tanh(A/KNEE_DB)^(d/n) )
 * with d the CALIBRATED shape's exponent. Monotonic in n, so the ordering of
 * the knees is guaranteed rather than checked: 8.490 / 7 / 6.221 dB at A = 8.
 * Every one of those clears its SHAPE_MIN_KNEE_DB bound with room to spare
 * (4.62 / 4.50 / 4.46), which is the property the guard test asserts —
 * normalisation is not allowed to buy matched depth with a folded curve.
 */
/**
 * The shape KNEE_DB was measured on, and the one the other two are normalised
 * onto. A property of the calibration, NOT of which position the panel opens
 * on — see the note above.
 */
export const SHAPE_KNEE_ANCHOR_SHAPE = 'tanh3'

export const SHAPE_KNEE_DB = Object.fromEntries(
  Object.entries(SHAPE_EXPONENT).map(([shape, n]) => {
    const d = SHAPE_EXPONENT[SHAPE_KNEE_ANCHOR_SHAPE]
    // The calibrated shape's own knee is RETURNED, not recomputed.
    // Algebraically the formula collapses to atanh(tanh(A/KNEE_DB)) there, but
    // that round-trip is not exact in floating point, and a constant that
    // moves by an ulp is still a constant that moved — the same rule the
    // exponent unrolling in softClip() follows, and pinned by its own test.
    if (n === d) return [shape, KNEE_DB]
    const anchored = Math.pow(Math.tanh(SHAPE_ANCHOR_DB / KNEE_DB), d / n)
    return [shape, SHAPE_ANCHOR_DB / Math.atanh(anchored)]
  }),
)

/**
 * What an unrecognised `shape` resolves to — exponent and knee together.
 *
 * ONE RESOLVER FOR BOTH, deliberately. Two independent lookups with two
 * independent `??` fallbacks can disagree: a shape present in one table and
 * absent from the other would silently pair one curve's exponent with
 * another's knee, which is a valid-looking curve at the wrong depth and
 * therefore invisible. Derived from the defaults object, never written twice.
 */
function resolveShape(shape) {
  const exponent = SHAPE_EXPONENT[shape]
  return exponent === undefined ? DEFAULT_SHAPE : { exponent, kneeDb: SHAPE_KNEE_DB[shape] }
}
const DEFAULT_SHAPE = {
  exponent: SHAPE_EXPONENT[SOFT_CLIPPER_KERNEL_DEFAULTS.shape],
  kneeDb: SHAPE_KNEE_DB[SOFT_CLIPPER_KERNEL_DEFAULTS.shape],
}

/**
 * Soft-clip curve — level-invariant and reduction-bounded. See
 * MAX_REDUCTION_DB / KNEE_DB above for the derivation and for the two spec
 * defects that made this shape necessary.
 *
 *   |x| <= T :  y = x                                    (bit-transparent)
 *   |x| >  T :  e = 20*log10(|x|/T)
 *               r = rMaxDb * tanh^n(e / kneeDb)   n AND kneeDb from `shape`
 *               y = sign(x) * |x| * 10^(-r/20)
 *
 * `exponent` and `kneeDb` are NOT independent in shipped use: they are paired
 * per shape by SHAPE_KNEE_DB so that every shape delivers the same reduction
 * at SHAPE_ANCHOR_DB. Callers inside the kernel take both from resolveShape().
 * The two stay separate arguments because the tests sweep the knee against a
 * fixed exponent to locate the fold bounds.
 *
 * The log/exp pair only runs for samples ABOVE the threshold, which on speech
 * is a small minority — the early-out below carries the overwhelming majority
 * of samples at the cost of one compare.
 *
 * Deliberately NOT a plain `tanh(k*x)`: that compresses across the entire
 * amplitude range and changes voice character below threshold. The whole
 * "transparent when idle" claim rests on the piecewise form.
 */
export function softClip(x, T, rMaxDb = MAX_REDUCTION_DB, kneeDb = KNEE_DB, exponent = 2) {
  const ax = x < 0 ? -x : x
  if (ax <= T) return x
  const excessDb = 20 * Math.log10(ax / T)
  const t = Math.tanh(excessDb / kneeDb)
  // Repeated multiply rather than Math.pow: this runs per oversampled sample
  // above the threshold, and the exponent is one of exactly three integers.
  //
  // The extra factors are applied to the SCALED reduction rather than to a
  // separately accumulated tanh^n, so the exponent-2 expression is character
  // for character the one that shipped before shapes existed. `rMax * (t*t)`
  // and `(rMax * t) * t` differ in the last ulp, and a default that moves by
  // an ulp is still a default that moved — pinned by its own test.
  let reductionDb = rMaxDb * t * t
  if (exponent >= 3) reductionDb *= t
  if (exponent >= 4) reductionDb *= t
  const y = ax * Math.exp(-reductionDb * LN10_OVER_20)
  return x < 0 ? -y : y
}

/**
 * Stateful block processor. Feed it consecutive blocks of any length and it
 * behaves identically to processing the concatenation in one pass — every
 * coefficient derives from sample rate and time constants, never from block
 * count (spec §6.3).
 */
/**
 * The stage's latency for a given patch, without building a kernel.
 *
 * ⚠ THE CALLERS NEEDED THIS AND WERE USING A CONSTANT THAT IS ONLY RIGHT WHEN
 * THE LIMITER IS OFF. `SOFT_CLIPPER_LATENCY_SAMPLES` is the OVERSAMPLER's 50
 * samples; with the limiter engaged the stage delays by 226 at 44.1 kHz. Both
 * the effect-chain's delay compensation and the offline apply path took the
 * constant, so once `limiter` defaulted to 100 the applied region came out
 * shifted by 176 samples and lost that much of its tail — a seam at both
 * boundaries, for a control nobody touched.
 *
 * A comment on the getter above claimed "the offline path reads it per render
 * and is correct either way". It did not; it read the constant. This is that
 * claim made true.
 *
 * Mirrors the getter deliberately rather than instantiating a kernel: the apply
 * path needs the number BEFORE it builds the OfflineAudioContext, because the
 * context's length depends on it. Pinned against a real kernel by its test, so
 * the two cannot drift.
 */
export function softClipperLatencySamples(params, sampleRate) {
  const osLatency = COMPRESSOR_OVERSAMPLE.latencySamples
  const limiterAmount = clamp(params?.limiter ?? SOFT_CLIPPER_KERNEL_DEFAULTS.limiter, 0, 100)
  if (limiterAmount <= 1e-4) return osLatency
  const halfWidth = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS / 1000) * sampleRate))
  return osLatency + 2 * halfWidth
}

export class SoftClipperKernel {
  /**
   * @param {number} sampleRate
   * @param {{oversample?: 4|8}} [options] EXPERIMENTAL. 8 selects the 8x
   *   profile — not a shipping path, and it changes the reported latency from
   *   50 to 52 samples, so anything differencing the two must align on each
   *   instance's own `latencySamples` rather than assuming they match. See
   *   COMPRESSOR_OVERSAMPLE_8X.
   */
  constructor(sampleRate, options = {}) {
    this.limiters = []
    this.limiterHalfWidth = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS / 1000) * sampleRate))
    this.limiterActive = false
    this.limiterScratch = new Float32Array(0)
    /**
     * Research option, NOT a parameter: crossover frequencies for a band-split
     * limiter in place of the broadband one. Deliberately in `options` rather
     * than in `params` — the apply path renders from params, and a limiter
     * topology that changes the stage's latency has no business being one
     * message away from the timeline. Null keeps the shipping broadband path.
     */
    this.limiterCrossovers = Array.isArray(options.limiterCrossovers) && options.limiterCrossovers.length
      ? options.limiterCrossovers.slice()
      : null
    this.limiterSafety = options.limiterSafety === true
    this.limiterCeilingFactor = options.limiterCeilingFactor ?? 1
    this.limiterLatency = 2 * this.limiterHalfWidth * (this.limiterCrossovers && this.limiterSafety ? 2 : 1)
    this.osProfile = options.oversample === 8 ? COMPRESSOR_OVERSAMPLE_8X : COMPRESSOR_OVERSAMPLE
    this.osFactor = this.osProfile.factor
    this.osLatency = this.osProfile.latencySamples
    this.sampleRate = sampleRate

    // ── Detector state (mono, shared across channels) ──
    this.fastRmsMeanSq = 0
    this.noiseEstDb = -80
    // The valley follower snaps DOWN instantly, and at t=0 fastRms is still
    // filling from zero — so without a warm-up it snaps to the filter's own
    // start-up transient (effectively -inf), the gate then treats the quietest
    // lead-in as speech, and the tracker seeds from it. Measured on the
    // reported clip: T dived to -52 dBFS and stayed low for seconds. Three
    // fast-RMS time constants is enough for fastRms to mean something.
    this.detectorWarmupCount = 0
    this.detectorWarmupTarget = Math.max(1, Math.round(sampleRate * 0.030))
    this.gateHoldSamples = 0
    this.gateOpen = false
    this.speechLevelDb = SPEECH_INIT_HOLD_DB
    this.speechWarmupCount = 0
    this.speechWarmupPeak = 0 // running MAX of the peak envelope during warm-up
    this.speechWarmupTarget = Math.max(1, Math.round(sampleRate * (SPEECH_INIT_WINDOW_MS / 1000)))

    this.fastPeak = 0
    // Peak follower on the PRE-EMPHASISED downmix, run with the same
    // ballistics as fastPeak so the two are comparable sample for sample.
    // Their ratio is the emphasis lift — see LIFT_TAU_S.
    this.fastPeakEmph = 0
    this.liftDb = 0
    // material with no clear lean behaves exactly as it did.
    // Running MAX of the lift target during the speech tracker's warm-up —
    // the same shape as speechWarmupPeak, for the same reason. See the
    // warm-up note in the lift update.
    this.liftWarmupMax = 0
    this.liftCoef = riseCoeff(LIFT_TAU_S * 1000, sampleRate)
    this.fastPeakAttack = riseCoeff(FAST_PEAK_ATTACK_MS, sampleRate)
    this.fastPeakRelease = riseCoeff(FAST_PEAK_RELEASE_MS, sampleRate)
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
    // A THIRD cascade, mono, for the detector's pre-emphasised copy. Not the
    // audio path's `preEmphasis` with an extra channel: that one is fed the
    // per-channel input and this one the downmix, and sharing an instance
    // would mean sharing filter state between two different signals.
    this.preEmphasisDetect = new BiquadCascade(1, 1)

    // DC blocker, per output channel. Runs only while asymmetry is engaged —
    // see DC_BLOCK_HZ — so the shipped patch never touches it.
    // One-pole lowpass state per channel, and its coefficient. See
    // HF_LOSS_CORNER_HZ — the shelf is a blend against this, not a filter
    // whose coefficients move.
    // Memory of recent drive, 0-1. See HYST_MAX_DB.
    this.hystState = 0
    this.hystCoef = riseCoeff(HYST_TAU_MS, sampleRate)

    this.emphasisActive = false
    this.emphasisStable = true

    // ── Oversamplers (grown on demand per channel) ──
    this.oversamplers = []

    // ── Metering ──
    this.reductionDb = 0
    this.maxReductionDb = 0
    // Smoothed residual and signal POWER, separately — the ratio is taken at
    // read time. See RESIDUAL_TAU_S for why not the other way round.
    this.residualPower = 0
    this.dryPower = 0
    // Share of voiced blocks in which the curve engaged, 0-1. See ENGAGED_TAU_S.
    this.engagedFraction = 0

    // ── Monitoring ──
    /**
     * DELTA: pass the residual — what the stage removed — instead of the
     * processed audio.
     *
     * NOT A MEMBER OF `params`, and deliberately so. `applySoftClipperRegion`
     * spreads a param object straight into the kernel to render into the
     * timeline, so a monitoring mode living in there would be one careless key
     * away from writing a difference signal into someone's file. It travels on
     * its own port message (see setMonitor), which the offline path never
     * sends and processSoftClipperBuffer never calls. Same arrangement as
     * ResonanceKernel.
     */
    this.monitorDelta = false
    /**
     * Dry delay lines, one per output channel, exactly the oversampler's group
     * delay long — the residual is only meaningful against a time-aligned dry
     * copy, and the processed path lags by that much.
     *
     * Written and read UNCONDITIONALLY rather than only while monitoring, so
     * switching DELTA on presents correct history immediately instead of 50
     * samples of whatever was last in the buffer. One read and one write per
     * sample is nothing beside the oversampled tanh.
     */
    this.dryDelay = []
    this.dryDelayPos = 0

    this.tScratch = new Float32Array(128)
    this.trimScratch = new Float32Array(128)

    // ── Scope ──
    // Per-process()-call summary for the scrolling display: the loudest input
    // sample of the call and the threshold AT THAT SAMPLE. Pairing them rather
    // than reporting a block-average threshold is what makes "did this peak
    // cross" answerable from the display exactly as the curve answered it —
    // T moves within a block, so any other pairing can draw a crossing that
    // did not happen, or hide one that did.
    this.scopePeak = 0
    this.scopeThreshold = 1

    // Mono downmix and its pre-emphasised copy, grown on demand. Two buffers
    // rather than one: the detector reads both per sample.
    this.monoScratch = new Float32Array(0)
    this.monoEmphScratch = new Float32Array(0)

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
    // coefficient, so there is nothing to click. `shape` is the same: it only
    // changes the exponent inside the reduction law, and every shape is
    // exactly unity below the threshold, so switching mid-playback cannot
    // step the level of anything that was not already being reduced.
  }

  /**
   * Algorithmic latency, in samples — the oversampler's group delay alone.
   * Pre/de-emphasis are ordinary IIR biquads at the base rate and add none.
   * Constant regardless of settings, including emphasisDb = 0: the
   * oversampled path always runs, so bypassing the emphasis filters cannot
   * shift the timeline under a running preview.
   */
  get latencySamples() {
    // ⚠ VARIABLE. The limiter's delay is only present while it is engaged, so
    // this changes with the parameter — see LIMITER_MAX_ABOVE_DB, and
    // softClipperLatencySamples() for the standalone form the callers need.
    return this.osLatency + (this.limiterActive ? this.limiterLatency : 0)
  }

  /**
   * Residual level in dBc, floored. A getter rather than a field because it is
   * a division of two smoothed powers — computing it per block would be work
   * done ~46x more often than it is read.
   */
  get residualDbc() {
    return this.residualPower > 0 && this.dryPower > 0
      ? Math.max(RESIDUAL_FLOOR_DBC, 10 * Math.log10(this.residualPower / this.dryPower))
      : RESIDUAL_FLOOR_DBC
  }

  getMetering() {
    return {
      reductionDb: this.reductionDb,
      maxReductionDb: this.maxReductionDb,
      engagedFraction: this.engagedFraction,
      // How much of HF Emphasis's boost the threshold is currently giving
      // back. Reported so the panel can say what the knob is doing rather
      // than leaving a silently-moving threshold — see LIFT_TAU_S.
      liftDb: this.liftDb,
      // Level of what the stage is removing, relative to the signal it came
      // from. Floored rather than allowed to reach -Infinity on material the
      // stage never engages — see RESIDUAL_FLOOR_DBC.
      residualDbc: this.residualDbc,
    }
  }

  /**
   * Audition the residual — only what the stage is removing.
   *
   * A separate call rather than a parameter: parameters are what the apply
   * path renders with, and this must never be one of them. See monitorDelta.
   */
  setMonitor(delta) {
    this.monitorDelta = !!delta
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
    // The detector's own copy gets the SAME section, so the lift is measured
    // through exactly the filter the curve is fed rather than through a
    // second design that could drift from it.
    this.preEmphasisDetect.setSections([pre])
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
    // Resolved once per call: `shape` is a string on the params object and the
    // clip curve runs L times per sample, so the lookup must not sit inside
    // the inner loop. Unknown values fall back to the DEFAULT shape rather
    // than throwing — a bad param must not take the audio thread down — and
    // the fallback is read from the defaults rather than written as a literal,
    // so moving the default cannot silently leave the two disagreeing.
    //
    // Exponent and knee travel together (see resolveShape): the knee is what
    // normalises the shapes to equal reduction at SHAPE_ANCHOR_DB, so a curve
    // run with one shape's exponent and another's knee is neither shape.
    const { exponent: shapeExponent, kneeDb: shapeKneeDb } = resolveShape(p.shape)

    // Asymmetry, as a fraction of the threshold — see ASYM_MAX_FRACTION. The
    // offset itself is per-sample because T is, so only the fraction is
    // resolved here.
    // The three character controls are derived from one knob — see
    // DRIVE_ASYM_RATIO. An explicit key still overrides, which is how the
    // tests reach each of them individually.
    const limiterAmount = clamp(p.limiter ?? 0, 0, 100) / 100
    this.limiterActive = limiterAmount > 1e-4
    // The limiter aims this far ABOVE T; the knob closes the gap.
    // ⚠ THE CEILING FACTOR IS APPLIED HERE FOR THE BROADBAND PATH ONLY —
    // BandSplitLimiter applies its own internally, per band. Both are research
    // options; at the shipped default (no crossovers, factor 1) this is exactly
    // the expression it replaced.
    const limiterCeilFactor = dbToLin(LIMITER_MAX_ABOVE_DB * (1 - limiterAmount))
      * (this.limiterCrossovers ? 1 : this.limiterCeilingFactor)
    const hystScale = clamp(p.hysteresis ?? 0, 0, 100) / 100
    const hystActive = hystScale > HYST_EPSILON

    // Emphasis coefficients recompute only when the raw target has moved
    // enough to matter (deviation note 3) — cheap on a knob drag, free
    // otherwise.
    //
    // AHEAD OF THE DETECTOR, not after it: the detector now runs its own
    // pre-emphasised copy of the downmix, and filtering this block's audio
    // with one set of coefficients while measuring it with the previous
    // block's would make the lift reading disagree with the signal the curve
    // actually sees. The audio path is unaffected by the move — it always ran
    // after this point.
    if (Math.abs(p.emphasisDb - this.emphasisDbCommitted) > EMPHASIS_RECOMPUTE_EPS_DB) {
      this._updateEmphasis(p.emphasisDb)
    }

    // ── Mono downmix, and its pre-emphasised copy ──────────────────────────
    // Materialised into scratch rather than computed inline in the detector
    // loop, because the pre-emphasis is a biquad and wants a run of samples.
    if (this.monoScratch.length < n) {
      this.monoScratch = new Float32Array(n)
      this.monoEmphScratch = new Float32Array(n)
    }
    const mono = this.monoScratch
    const monoEmph = this.monoEmphScratch
    for (let i = 0; i < n; i++) {
      let acc = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) acc += inputChannels[ch][i]
      mono[i] = acc * chScale
    }
    if (this.emphasisActive) {
      this.preEmphasisDetect.process(mono, monoEmph, n, 0)
    } else {
      // Emphasis off: there is no lift, and every piece of state that could
      // outlive the setting is cleared here rather than left to decay.
      //
      // LEAVING IT TO DECAY WAS A BUG, and a long one. `liftDb` only updates
      // while the gate is open AND the moment is loud, so its 3 s constant is
      // 3 s of GATED time — many times that in wall clock. Measured by
      // flipping Emphasis 12 -> 0 mid-file: the threshold was still 2.76 dB
      // high SIX SECONDS later, so the stage quietly under-processed
      // everything in between. The filters switch instantly, so the threshold
      // that compensates for them has to switch instantly too.
      // ⚠ THE COPY THAT USED TO LIVE HERE IS GONE. `monoEmph` had a second
      // reader — the asymmetry offset's skew tracker — which needed the
      // emphasised downmix whether or not the emphasis was engaged. That
      // tracker left with asymmetry, so the only remaining reader is the lift
      // follower, which is now gated off in exactly this case. Copying a block
      // per call to feed nothing is what made "the filters are bypassed" and
      // "the feature costs nothing" two different claims.
      this.liftWarmupMax = 0
      this.fastPeakEmph = this.fastPeak
      // The detector's filter has been fed nothing since it was switched off,
      // so its state is stale by however long that was. Clearing it here means
      // re-enabling starts from silence rather than from whatever was in
      // flight when the knob passed through zero.
      this.preEmphasisDetect.reset()
    }

    // ── Detector + threshold, computed once per sample from the unfiltered
    // mono downmix, shared by every channel's clip curve. headroomDb and
    // outputTrimDb are smoothed here too — one one-pole each, run exactly
    // once regardless of channel count (deviation note 3) ──
    let fastRmsMeanSq = this.fastRmsMeanSq
    let fastPeak = this.fastPeak
    let fastPeakEmph = this.fastPeakEmph
    let liftDb = this.liftDb
    let liftWarmupMax = this.liftWarmupMax
    let hystState = this.hystState
    // Upper bound on the lift, hoisted out of the per-sample loop. Zero when
    // the emphasis filters are bypassed, which is what makes emphasisDb = 0
    // bit-identical to the build before compensation existed.
    const liftMaxDb = this.emphasisActive ? this.emphasisDbCommitted : 0
    // ⚠ THE WHOLE LIFT PATH IS GATED ON THIS, and at the shipped pin of
    // emphasisDb 0 that is the difference between paying for the feature and
    // not. The FILTERS were already bypassed when inactive, but the detector
    // work around them was not: a full monoEmph copy per block, a peak
    // follower per sample, and a linToDb per voiced sample, all feeding a
    // value that is then clamped to zero. Measured on 17.7 s of real
    // narration: 40x realtime against 43-44x with this gate, i.e. about 7-8%
    // of the stage spent on a reading that cannot move anything.
    //
    // Bit-identical at every setting — verified by rendering both builds and
    // differencing them, worst |diff| = 0 — because when the flag is false the
    // gated work only ever produced liftDb = 0, which is what the ungated path
    // clamped it to anyway.
    const emphasisOn = this.emphasisActive
    // THE BOUND IS APPLIED TO THE STATE, NOT ONLY TO THE TARGET, and that is
    // what makes turning the knob DOWN take effect at once. liftDb is a slow
    // average of past evidence; lowering Emphasis invalidates that evidence
    // immediately, because the shelf that produced it is no longer in circuit
    // at that depth. Clamping here costs one compare per block and collapses
    // the whole class of "the threshold is still compensating for a setting
    // that is gone" — including Emphasis 0, where the bound is 0 and the lift
    // snaps to nothing.
    if (liftDb > liftMaxDb) liftDb = liftMaxDb
    let noiseEstDb = this.noiseEstDb
    let gateHoldSamples = this.gateHoldSamples
    let speechLevelDb = this.speechLevelDb
    let speechWarmupCount = this.speechWarmupCount
    let speechWarmupPeak = this.speechWarmupPeak
    let detectorWarmupCount = this.detectorWarmupCount
    let headroomDbSmoothed = this.headroomDbSmoothed
    // Reset per call: each scope point summarises one process() call.
    let scopePeak = 0
    let scopeThreshold = this.scopeThreshold
    let outputTrimDbSmoothed = this.outputTrimDbSmoothed
    // Did the gate open at any point in this block? Drives the ENGAGED
    // readout's denominator — see ENGAGED_TAU_S.
    let blockVoiced = false

    for (let i = 0; i < n; i++) {
      headroomDbSmoothed += this.paramSmoothCoef * (p.headroomDb - headroomDbSmoothed)
      outputTrimDbSmoothed += this.paramSmoothCoef * (p.outputTrimDb - outputTrimDbSmoothed)
      trimGain[i] = dbToLin(outputTrimDbSmoothed)

      const x = mono[i]

      // fast_rms: one-pole RMS, τ = 10 ms (spec §3.1).
      fastRmsMeanSq += this.fastRmsCoef * (x * x - fastRmsMeanSq) + DENORMAL_GUARD
      const fastRmsLin = Math.sqrt(Math.max(0, fastRmsMeanSq))
      const fastRmsDb = linToDb(fastRmsLin)

      // Short-term peak envelope — what the speech-level tracker follows, and
      // therefore what Headroom is measured from. See FAST_PEAK_ATTACK_MS.
      const rect = x < 0 ? -x : x
      fastPeak += (rect > fastPeak ? this.fastPeakAttack : this.fastPeakRelease)
        * (rect - fastPeak) + DENORMAL_GUARD
      const fastPeakDb = linToDb(fastPeak)

      // The same follower on the pre-emphasised copy. Their ratio is how much
      // the curve's view of the loud material has been lifted, which is what
      // the threshold gives back — see LIFT_TAU_S.
      //
      // A RATIO OF FOLLOWERS, never of samples: |emphasised[i] / raw[i]| is
      // unbounded wherever the raw sample passes through zero, and a lift
      // reading that spikes to infinity between cycles would drive the
      // threshold to T_MAX and silently disable the stage.
      //
      // Skipped entirely when the emphasis is off — see `emphasisOn`. The
      // else-branch above parks fastPeakEmph on fastPeak while it is skipped,
      // so re-enabling starts from a sane value rather than a stale one.
      //
      // ⚠ THAT PARKING IS HYGIENE, NOT A GUARANTEE, and an earlier draft of
      // this comment claimed otherwise. Mutation-tested: deleting it fails no
      // test, because on re-enable the follower's 1 ms attack / 150 ms release
      // catches up long before liftDb — clamped to [0, emphasisDb] and moving
      // on a 3 s GATED constant — can be shifted by it. It is kept because a
      // follower carrying a value from an arbitrary time ago is a trap for the
      // next person, not because anything measurable depends on it.
      if (emphasisOn) {
        const rectEmph = monoEmph[i] < 0 ? -monoEmph[i] : monoEmph[i]
        fastPeakEmph += (rectEmph > fastPeakEmph ? this.fastPeakAttack : this.fastPeakRelease)
          * (rectEmph - fastPeakEmph) + DENORMAL_GUARD
      }

      // noise_est: decaying valley follower standing in for a running minimum
      // over a trailing 2 s window — see deviation note (2) above.
      //
      // During the first 30 ms the floor is SEEDED from fastRms rather than
      // chased, because fastRms is still filling from zero and the follower
      // would otherwise lock onto its start-up transient. Seeding high is the
      // safe direction: the follower snaps down instantly at the first genuine
      // pause, so an over-estimate self-corrects within a phrase, whereas the
      // under-estimate this replaces took seconds to climb out of and left the
      // threshold far too low the whole time.
      if (detectorWarmupCount < this.detectorWarmupTarget) {
        detectorWarmupCount++
        noiseEstDb = fastRmsDb
      } else if (fastRmsDb < noiseEstDb) {
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
      if (this.gateOpen) blockVoiced = true

      // speech level tracker (spec §3.2): updates only while the signal is
      // ACTUALLY above the floor — no update, no decay — through pauses.
      // Without this the tracker would sag toward the noise floor across
      // every breath and the first word after every pause would clip hard.
      //
      // Gated on `aboveFloor`, not the hold-extended `gateOpen` — see
      // deviation note (5).
      if (aboveFloor) {
        if (speechWarmupCount < this.speechWarmupTarget) {
          // Still gathering evidence: hold T above full scale so nothing is
          // processed, and accumulate the loudest peak seen. See
          // SPEECH_INIT_HOLD_DB.
          speechWarmupCount++
          if (fastPeak > speechWarmupPeak) speechWarmupPeak = fastPeak
          speechLevelDb = speechWarmupCount < this.speechWarmupTarget
            ? SPEECH_INIT_HOLD_DB
            : linToDb(speechWarmupPeak)
        } else {
          speechLevelDb += this.speechCoef * (fastPeakDb - speechLevelDb)
        }

        // Emphasis lift, on the same 3 s constant and behind the same gate as
        // the speech tracker. Gated for the same reason: through a pause both
        // followers decay toward the noise floor, where their ratio is a
        // property of the room rather than of the voice, and an ungated lift
        // would let the threshold wander between words.
        //
        // ⚠ AND BEHIND `emphasisOn` AS WELL, which is a different gate for a
        // different reason: with no emphasis there is no lift to measure, and
        // every term below resolves to zero. Two gates, two reasons — do not
        // collapse them.
        //
        // Clamped to [0, emphasisDb] — the shelf is a pure boost, so anything
        // outside that window is a follower still filling rather than a
        // measurement. See LIFT_TAU_S.
        // Only the loud moments contribute — see LIFT_GATE_DB. During warm-up
        // the tracker is parked at SPEECH_INIT_HOLD_DB and means nothing yet,
        // so the comparison runs against the peak gathered so far instead;
        // without that the gate would never open during warm-up and the seed
        // below would never accumulate.
        if (emphasisOn) {
          const liftRefDb = speechWarmupCount < this.speechWarmupTarget
            ? linToDb(speechWarmupPeak)
            : speechLevelDb
          const atPeak = fastPeakDb >= liftRefDb + LIFT_GATE_DB
          const liftTargetDb = clamp(linToDb(fastPeakEmph) - fastPeakDb, 0, liftMaxDb)
          if (!atPeak) {
            // Not a loud moment: contribute nothing rather than dragging the
            // reading toward a population the threshold is not placed for.
          } else if (speechWarmupCount < this.speechWarmupTarget) {
            // SEEDED DURING WARM-UP, NOT RAMPED INTO, and this is not a
            // refinement — without it the feature is absent for its first three
            // seconds. The speech tracker adopts a real level the instant its
            // 500 ms window closes, so the stage starts processing immediately;
            // a lift still climbing from zero on a 3 s constant leaves the
            // threshold uncompensated exactly then, and the stage over-clips
            // the start of every file just as hard as it did before the
            // compensation existed. Measured on a sibilant passage at emphasis
            // 12, that transient alone accounted for most of the peak reduction
            // the compensation appeared to be failing to remove.
            //
            // The MAX rather than the mean over the window, because a lift that
            // is too high merely does less while one that is too low
            // over-processes — the asymmetry the tracker's own warm-up note
            // records, and the cure there was a warm-up seed rather than
            // ballistics for the same reason.
            if (liftTargetDb > liftWarmupMax) liftWarmupMax = liftTargetDb
            liftDb = liftWarmupMax
          } else {
            liftDb += this.liftCoef * (liftTargetDb - liftDb)
          }
        }
      }

      // threshold derivation (spec §3.3). T_MIN is now only a numerical
      // backstop — softClip takes log(|x|/T), so T must stay off zero.
      //
      // liftDb is added in BOTH modes, including fixed. A stated ceiling is
      // stated about the raw signal, and the curve works on the emphasised
      // one; without the lift the two disagree by however much HF Emphasis is
      // boosting, and the number in the box stops describing what happens.
      // The scope draws T, so the line visibly rises with the knob — which is
      // the trade being made and worth seeing.
      // The threshold BEFORE the memory. Everything the memory measures is
      // relative to this rather than to the modulated value — feeding a
      // modulated threshold back into the measurement that drives it would
      // close a loop with no reason to settle.
      const baseDb = (fixedMode ? p.fixedThresholdDb : speechLevelDb + headroomDbSmoothed)
        + liftDb

      if (hystActive) {
        // The state carries dB of depression directly. HYST_MAX_DB is a bound
        // on it, not the shape of it — measured, the bound is never reached on
        // real narration at the shipped slope, so it is a safety rail rather
        // than a tuning. See HYST_SLOPE_DB_PER_DB.
        const overDb = fastPeakDb - baseDb
        const target = overDb > 0 ? Math.min(HYST_MAX_DB, overDb * HYST_SLOPE_DB_PER_DB) : 0
        // One coefficient both ways. A second one for the release measured as
        // exactly inert — see HYST_MAX_DB — because the drive this follows has
        // already been through the detector's own asymmetric follower.
        hystState += this.hystCoef * (target - hystState)
      }

      // TRANSLATED, NEVER RESHAPED — see HYST_MAX_DB. The curve that runs is
      // the same curve at a different height, so it is monotonic at any frozen
      // state whatever the memory is doing.
      const targetDb = baseDb - hystScale * hystState
      // T_MAX IS SCALED BY THE LIFT, and leaving it unscaled truncated the
      // compensation exactly where it was needed most. The ceiling bounds T
      // against the signal the CURVE sees, not against the raw input, and
      // pre-emphasis has lifted that signal by liftDb — so a threshold above
      // digital full scale in raw terms is correct here rather than absurd:
      // it means nothing in the unemphasised signal should be touched and
      // only the boosted HF peaks can reach the curve.
      //
      // Measured before the scaling: on a sibilant passage at emphasis 12 the
      // lift reached 11.25 dB, T pinned at 0.95, and peak reduction climbed to
      // 4.98 dB — the clamp handing back the depth the compensation had just
      // removed, silently, and only on the material the feature exists for.
      T[i] = clamp(dbToLin(targetDb), T_MIN, T_MAX * dbToLin(liftDb))

      // Scope: loudest input sample of this call, and T at that instant.
      const ax = x < 0 ? -x : x
      if (ax > scopePeak) { scopePeak = ax; scopeThreshold = T[i] }
    }

    this.fastRmsMeanSq = fastRmsMeanSq
    this.fastPeak = fastPeak
    this.fastPeakEmph = fastPeakEmph
    this.liftDb = liftDb
    this.liftWarmupMax = liftWarmupMax
    this.hystState = hystState
    this.noiseEstDb = noiseEstDb
    this.gateHoldSamples = gateHoldSamples
    this.speechLevelDb = speechLevelDb
    this.speechWarmupCount = speechWarmupCount
    this.speechWarmupPeak = speechWarmupPeak
    this.detectorWarmupCount = detectorWarmupCount
    this.headroomDbSmoothed = headroomDbSmoothed
    this.scopePeak = scopePeak
    this.scopeThreshold = scopeThreshold
    this.outputTrimDbSmoothed = outputTrimDbSmoothed

    while (this.oversamplers.length < nOut) this.oversamplers.push(new Oversampler(this.osProfile))
    if (this.limiterActive) {
      while (this.limiters.length < nOut) {
        this.limiters.push(this.limiterCrossovers
          ? new BandSplitLimiter(this.limiterHalfWidth, this.limiterCrossovers, this.sampleRate, { safety: this.limiterSafety, ceilingFactor: this.limiterCeilingFactor })
          : new LookaheadLimiter(this.limiterHalfWidth))
      }
      if (this.limiterScratch.length < n) this.limiterScratch = new Float32Array(n)
    }
    // ⚠ THE OVERSAMPLER'S LATENCY ONLY, not the stage's. The dry side of this
    // delay is fed POST-limiter, so it already carries the limiter's 2L —
    // adding it again over-delays the dry signal and the "residual" becomes
    // the difference between two unrelated moments. Measured when it was
    // wrong: +4.9 dBc, i.e. larger than the signal.
    const D = this.osLatency
    while (this.dryDelay.length < nOut) this.dryDelay.push(new Float32Array(D))
    this.preEmphasis.ensureChannels(nOut)
    this.deEmphasis.ensureChannels(nOut)

    // Every channel walks the same delay positions, so the write cursor is
    // captured once and committed once rather than advanced per channel.
    const dryPosStart = this.dryDelayPos
    let dryPosEnd = dryPosStart

    const L = this.osFactor
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
    // Summed across channels, both terms, so the ratio is energy-weighted
    // rather than an average of per-channel ratios — a silent channel should
    // dilute the reading, not contribute a 0/0 to it.
    let residualSq = 0
    let drySq = 0

    for (let ch = 0; ch < nOut; ch++) {
      let input = inputChannels[ch < nIn ? ch : nIn - 1]
      const out = outputChannels[ch]
      const oversampler = this.oversamplers[ch]

      let stagedInput = input
      if (this.limiterActive) {
        // The limiter reads T for the sample ARRIVING, and its own smoothing
        // delays the resulting gain so it lands on that sample when it emerges
        // — which is why a moving threshold is safe here and is its own test.
        const lim = this.limiters[ch]
        const scratch = this.limiterScratch
        for (let i = 0; i < n; i++) scratch[i] = lim.processSample(input[i], T[i] * limiterCeilFactor)
        // ⚠ THE DRY SIDE OF THE RESIDUAL IS FED FROM HERE, post-limiter. The
        // limiter's gain reduction is intended, not distortion, and counting
        // it as residual would make the readout report the balance knob rather
        // than what the curve added. See LIMITER_MAX_ABOVE_DB.
        input = scratch
        stagedInput = scratch
      }
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
          const after = softClip(before, t, MAX_REDUCTION_DB, shapeKneeDb, shapeExponent)
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

      // Dry delay, DELTA and output trim in one pass.
      //
      // The residual is taken BEFORE the trim and then trimmed along with
      // everything else, so Output Trim moves the residual's level rather than
      // becoming part of what the residual reports — a trim of -6 dB should
      // make the removed material quieter, not add 6 dB of broadband dry signal
      // to it.
      const dl = this.dryDelay[ch]
      let p = dryPosStart
      for (let i = 0; i < n; i++) {
        const dry = dl[p]
        dl[p] = input[i]
        p = p + 1 === D ? 0 : p + 1
        // The residual, measured HERE and nowhere else. This is the only point
        // in the kernel where a delay-aligned dry signal and the finished wet
        // one exist together, which is what makes it the only point the
        // difference means anything: the oversampler's group delay would
        // otherwise be compared against itself. It is also, exactly, what
        // DELTA auditions — the readout and the monitoring mode report the
        // same signal, so they cannot disagree.
        //
        // BEFORE THE TRIM, like DELTA. Output Trim is a gain match for A/B;
        // letting it move a diagnostic would mean the number changed when
        // nothing about the processing had.
        const d = dry - out[i]
        residualSq += d * d
        drySq += dry * dry
        out[i] = (this.monitorDelta ? d : out[i]) * trimGain[i]
      }
      dryPosEnd = p
    }

    this.dryDelayPos = dryPosEnd

    this.reductionDb = blockMaxReductionDb
    if (this.reductionDb > this.maxReductionDb) this.maxReductionDb = this.reductionDb

    // ENGAGED: share of VOICED blocks in which the curve did anything. Silent
    // blocks neither raise nor lower it — see ENGAGED_TAU_S.
    if (blockVoiced) {
      const a = Math.min(1, n / (ENGAGED_TAU_S * this.sampleRate))
      this.engagedFraction += a * ((blockMaxReductionDb > 0 ? 1 : 0) - this.engagedFraction)
    }

    // RESIDUAL: same gate, same window, energy domain. drySq can only be zero
    // on a block of digital silence, which the voiced gate already excludes —
    // the guard is against a block that is silent on every channel slipping
    // through some future change to what "voiced" means, not against normal
    // material.
    if (blockVoiced && drySq > 0) {
      const a = Math.min(1, n / (RESIDUAL_TAU_S * this.sampleRate))
      this.residualPower += a * (residualSq / n - this.residualPower)
      this.dryPower += a * (drySq / n - this.dryPower)
    }
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh
 * kernel. Used by Node verification scripts; the app itself renders through
 * an OfflineAudioContext running the worklet so preview and apply share the
 * exact same code path.
 */
export function processSoftClipperBuffer(channelData, sampleRate, params = {}, options = {}) {
  const kernel = new SoftClipperKernel(sampleRate, options)
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

  /**
   * Scope points batched into one message.
   *
   * One point per process() call — 128 samples, ~2.9 ms at 44.1 kHz — which is
   * the resolution the display needs to draw a plosive as a spike rather than
   * a step. Posting each one individually would be ~344 messages a second per
   * instance; batching eight of them rides the meter's existing ~46 Hz
   * cadence instead, for the same information.
   *
   * Interleaved [peak, threshold] in one Float32Array so the whole batch is a
   * single structured clone.
   */
  const SCOPE_BATCH = 8

  class SoftClipperWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SoftClipperKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
      // Reused: postMessage clones synchronously, so the buffer is free to be
      // overwritten as soon as the call returns — same arrangement as the
      // resonance kernel's display scratch.
      this.scope = new Float32Array(SCOPE_BATCH * 2)
      this.scopeCount = 0
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'monitor') this.kernel.setMonitor(e.data.delta)
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

      // 1024 / 128 is exactly SCOPE_BATCH, so the array fills precisely at the
      // standard render quantum. If a host ever used a smaller one, the extra
      // points fold into the last slot by peak rather than being dropped — a
      // dropped point would silently stretch the scope's time axis, where a
      // folded one only coarsens it.
      if (this.scopeCount < SCOPE_BATCH) {
        this.scope[this.scopeCount * 2] = this.kernel.scopePeak
        this.scope[this.scopeCount * 2 + 1] = this.kernel.scopeThreshold
        this.scopeCount++
      } else if (this.kernel.scopePeak > this.scope[(SCOPE_BATCH - 1) * 2]) {
        this.scope[(SCOPE_BATCH - 1) * 2] = this.kernel.scopePeak
        this.scope[(SCOPE_BATCH - 1) * 2 + 1] = this.kernel.scopeThreshold
      }

      this.sinceMeter += n
      if (this.sinceMeter >= METER_INTERVAL_SAMPLES) {
        this.sinceMeter = 0
        this.port.postMessage({
          type: 'gr',
          reductionDb: this.kernel.reductionDb,
          engagedFraction: this.kernel.engagedFraction,
          liftDb: this.kernel.liftDb,
          residualDbc: this.kernel.residualDbc,
          // Only the filled prefix, so a short final batch cannot inject
          // stale zero-peak points into the scroll.
          scope: this.scope.subarray(0, this.scopeCount * 2),
        })
        this.scopeCount = 0
      }
      return true
    }
  }

  registerProcessor('soft-clipper-processor', SoftClipperWorkletProcessor)
}
