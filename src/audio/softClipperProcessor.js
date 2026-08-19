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
 *   - Monotonic, provided KNEE_DB > 0.7698 * MAX_REDUCTION_DB — the peak of
 *     2*tanh(u)*sech^2(u). At the shipped values max d(r)/d(e) = 0.404, so a
 *     louder input always produces a louder output.
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

const LN10_OVER_20 = Math.LN10 / 20

export const SOFT_CLIPPER_KERNEL_DEFAULTS = {
  headroomDb: 8, // 4-16, primary control — lower means more clipping
  emphasisDb: 6, // 0-12, HF pre/de-emphasis depth; 0 = bypass both filters
  outputTrimDb: 0, // ±6, post-stage gain match for A/B
  thresholdMode: 'adaptive', // 'adaptive' | 'fixed'
  fixedThresholdDb: -10, // used only in 'fixed' mode
  shape: 'tanh3', // 'tanh2' | 'tanh3' | 'tanh4' — knee contact order, see SHAPE_EXPONENT
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
 * THE DEFAULT IS tanh^3, chosen by ear rather than by table. At the shipped
 * knee a peak 3 dB over the threshold loses 0.98 / 0.40 / 0.16 dB across
 * n = 2 / 3 / 4 while a peak 12 dB over loses 5.27 / 4.94 / 4.63 — so the
 * exponent barely touches the deep transients this stage exists for and
 * almost entirely governs what happens to the shallow ones. tanh^2 was the
 * original curve; listening at a fixed threshold found it the most audibly
 * distorted of the three, and tanh^4 the least distorted but the most
 * conspicuous about what remained (see the sparsity note below). tanh^3 is
 * the position that was preferred.
 *
 * The reduction law is r = rMax * tanh^n(e / knee). Near the threshold
 * tanh(u) ~ u, so r ~ (e/knee)^n and the exponent IS the order of contact: the
 * gain curve joins the unity region with n-1 vanishing derivatives. n = 2 is
 * C1, n = 3 is C2, n = 4 is C3.
 *
 * WHAT IT CHANGES IS SELECTIVITY, NOT DISTORTION, and that ordering was
 * measured rather than assumed. Matched at 3 dB of reduction on a peak 12 dB
 * over threshold (so the shapes are compared doing the same amount of work):
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
 * ON A REAL FILE, AT A FIXED HEADROOM, THAT LANDS AS STRICTLY LESS WORK ON
 * BOTH AXES — which is the reading the panel is captioned for. 35 s of real
 * narration, Headroom 8, emphasis 6:
 *
 *   shape   peak GR   voiced samples touched   mean GR on those samples
 *   tanh^2   3.15 dB          0.293%                   0.358 dB
 *   tanh^3   2.28 dB          0.195%                   0.216 dB
 *   tanh^4   1.66 dB          0.126%                   0.150 dB
 *
 * ⚠ AND MATCHING THE DEPTH BACK REVERSES IT, which is worth knowing before
 * reaching for the Headroom knob to compensate. Depth is matched by LOWERING
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
 * WHAT THE HIGHER SHAPES SOUND LIKE, and why the two halves of that have
 * different causes. Reported from listening at a FIXED threshold: tanh^3 and
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
 * n makes the constraint slightly looser rather than tighter. Pinned in
 * `test/dsp/softClipper.test.js` against the shipped KNEE_DB.
 */
export const SHAPE_EXPONENT = { tanh2: 2, tanh3: 3, tanh4: 4 }

/**
 * Smallest KNEE_DB that keeps each shape monotonic at MAX_REDUCTION_DB, i.e.
 * rMax * max_u d/du tanh^n(u). Recorded so the guard test compares against
 * stated numbers rather than re-deriving them from the same code it checks.
 */
export const SHAPE_MIN_KNEE_DB = { tanh2: 4.62, tanh3: 4.50, tanh4: 4.46 }

/** What an unrecognised `shape` resolves to. Derived, never written twice. */
const DEFAULT_SHAPE_EXPONENT = SHAPE_EXPONENT[SOFT_CLIPPER_KERNEL_DEFAULTS.shape]

/**
 * Soft-clip curve — level-invariant and reduction-bounded. See
 * MAX_REDUCTION_DB / KNEE_DB above for the derivation and for the two spec
 * defects that made this shape necessary.
 *
 *   |x| <= T :  y = x                                    (bit-transparent)
 *   |x| >  T :  e = 20*log10(|x|/T)
 *               r = rMaxDb * tanh^n(e / kneeDb)   n from `shape`
 *               y = sign(x) * |x| * 10^(-r/20)
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
export class SoftClipperKernel {
  constructor(sampleRate) {
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
    this.emphasisActive = false
    this.emphasisStable = true

    // ── Oversamplers (grown on demand per channel) ──
    this.oversamplers = []

    // ── Metering ──
    this.reductionDb = 0
    this.maxReductionDb = 0
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
    return OVERSAMPLE_LATENCY_SAMPLES
  }

  getMetering() {
    return {
      reductionDb: this.reductionDb,
      maxReductionDb: this.maxReductionDb,
      engagedFraction: this.engagedFraction,
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
    const shapeExponent = SHAPE_EXPONENT[p.shape] ?? DEFAULT_SHAPE_EXPONENT

    // ── Detector + threshold, computed once per sample from the unfiltered
    // mono downmix, shared by every channel's clip curve. headroomDb and
    // outputTrimDb are smoothed here too — one one-pole each, run exactly
    // once regardless of channel count (deviation note 3) ──
    let fastRmsMeanSq = this.fastRmsMeanSq
    let fastPeak = this.fastPeak
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

      let x = inputChannels[0][i]
      for (let ch = 1; ch < nIn; ch++) x += inputChannels[ch][i]
      x *= chScale

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
      }

      // threshold derivation (spec §3.3). T_MIN is now only a numerical
      // backstop — softClip takes log(|x|/T), so T must stay off zero.
      const targetDb = fixedMode ? p.fixedThresholdDb : speechLevelDb + headroomDbSmoothed
      T[i] = clamp(dbToLin(targetDb), T_MIN, T_MAX)

      // Scope: loudest input sample of this call, and T at that instant.
      const ax = x < 0 ? -x : x
      if (ax > scopePeak) { scopePeak = ax; scopeThreshold = T[i] }
    }

    this.fastRmsMeanSq = fastRmsMeanSq
    this.fastPeak = fastPeak
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

    // Emphasis coefficients recompute only when the raw target has moved
    // enough to matter (deviation note 3) — cheap on a knob drag, free
    // otherwise.
    if (Math.abs(p.emphasisDb - this.emphasisDbCommitted) > EMPHASIS_RECOMPUTE_EPS_DB) {
      this._updateEmphasis(p.emphasisDb)
    }

    while (this.oversamplers.length < nOut) this.oversamplers.push(new Oversampler())
    const D = OVERSAMPLE_LATENCY_SAMPLES
    while (this.dryDelay.length < nOut) this.dryDelay.push(new Float32Array(D))
    this.preEmphasis.ensureChannels(nOut)
    this.deEmphasis.ensureChannels(nOut)

    // Every channel walks the same delay positions, so the write cursor is
    // captured once and committed once rather than advanced per channel.
    const dryPosStart = this.dryDelayPos
    let dryPosEnd = dryPosStart

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
          const after = softClip(before, t, MAX_REDUCTION_DB, KNEE_DB, shapeExponent)
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
        out[i] = (this.monitorDelta ? dry - out[i] : out[i]) * trimGain[i]
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
