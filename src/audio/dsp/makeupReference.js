/**
 * THE MAKEUP REFERENCE AND THE CEILING THAT MAKES IT SAFE — shared, because the
 * two are one mechanism and more than one plugin needs it.
 *
 * ⚠ THEY ARE A PAIR AND NEITHER IS USABLE ALONE, which is the reason this is a
 * module rather than two loose helpers. Referencing a percentile instead of the
 * true peak stops one uncompressed transient pinning a whole file's makeup — and
 * it gives up the arithmetic guarantee that the output cannot exceed the source,
 * measured, by nearly 6 dB. `softCeiling` restores that guarantee by enforcement.
 * Ship one without the other and you have either a compressor that goes quieter
 * as you turn it up, or one that overshoots.
 *
 * ⚠ WHERE THE CEILING GOES IS PER-PLUGIN AND IS NOT OBVIOUS. It has to be the
 * LAST thing before the output, so it bounds what actually leaves. In OptoSmooth
 * that is inside the kernel, which is the final stage. In Scheps the same kernel
 * sits MID-CHAIN — a post EQ and the dry sum come after it — so a ceiling on the
 * embedded kernel would clamp the wet path and then be undone downstream. Scheps
 * applies it at its own output instead.
 *
 * History, measurements and the failure modes that produced both constants are
 * in `docs/claude-dev-log.md`; the short version is on each export below.
 */

/**
 * The percentile the makeup solve references when it is NOT referencing the
 * true peak. 0.001 = the 99.9th percentile of sample magnitudes.
 *
 * ⚠ THIS IS HALF A MECHANISM AND IS UNSAFE ALONE — see `peakOfChannels`, which
 * measured the failure and rejected the percentile on its own. It is viable
 * only paired with `ceilingDb`, which is why `computeAutoMakeupPlan` returns
 * both and why nothing in this file lets you have one without the other.
 *
 * 99.9 rather than 99: at 99 the reference starts to include real programme
 * peaks, so the solve reads the material rather than the outlier and gives
 * some of the correction back. Measured on narration at Peak Reduction 50,
 * delivered rms peak-normalised to -1 dBFS: 99.99th -16.80, 99.9th -16.81,
 * 99.7th -16.95, against -17.39 peak-referenced. Flat between 99.9 and 99.99,
 * which is the sign of a reference sitting clear of the programme on one side
 * and clear of the lone transient on the other.
 */
export const MAKEUP_PERCENTILE = 0.001

/**
 * The WIDEST the soft knee is allowed to be, dB. No longer the width itself —
 * see `ceilingKneeDbFor`, which sizes each render's knee to the overshoot that
 * render actually has.
 *
 * The knee is C1 at its start — the curve leaves the unity line with unity
 * slope — so nothing below `ceiling - knee` is touched at all and the
 * transition into the ceiling has no corner. 3 dB is wide enough that the bend
 * is inaudible on the handful of samples that reach it and narrow enough that
 * it never reaches the programme: measured on narration, the ceiling attenuates
 * the loudest 0.1 % of samples by 0.00 / 0.07 / 0.19 / 0.24 dB at Peak
 * Reduction 50 / 60 / 70 / 80, and the 1-10 % band by 0.00 dB at every one of
 * them.
 *
 * ⚠ THAT TABLE IS A MEAN OVER A BAND AND IT HID WHAT HAPPENS AT THE PEAK. The
 * band is dominated by samples well below the ceiling; the peak sample is the
 * one the guarantee is about, and it pays far more. See `ceilingKneeDbFor`.
 */
export const CEILING_KNEE_DB = 3

/**
 * Headroom added to the measured overshoot when sizing a knee, dB.
 *
 * NOT a measurement-error margin — there is almost nothing to cover there. The
 * solve measures at base rate and the render is oversampled, and that moves the
 * un-ceilinged peak by at most 0.001 dB across Peak Reduction 0-100 on
 * narration. This exists for the parameters that move AFTER the solve: Scheps'
 * Mix and Output trim, and OptoSmooth's Gain, all of which can push a little
 * more into a ceiling than the solve saw.
 */
export const CEILING_KNEE_MARGIN_DB = 0.5

/**
 * The knee width for a render whose un-ceilinged peak sits `overshootDb` above
 * the ceiling.
 *
 * ⚠ THE KNEE USED TO BE A FIXED 3 dB AND THAT IS A COST WHEN THERE IS NOTHING
 * TO CATCH. `softCeiling` is a `tanh` knee, so it approaches the ceiling
 * asymptotically and NEVER REACHES IT: at an input exactly at the ceiling,
 * `tanh(1) = 0.7616` puts the output 0.627 dB BELOW it, and the bend starts a
 * full 3 dB down. Measured on narration, peak with the ceiling armed against
 * the same render with it off:
 *
 *   OptoSmooth                     Scheps
 *    PR   w/     w/o    cost        mix   w/     w/o    cost
 *    10  -3.57  -3.09  -0.48          0  -3.43  -2.80  -0.63
 *    25  -3.62  -3.18  -0.44        0.2  -3.58  -3.11  -0.47
 *    40  -3.81  -3.50  -0.30       0.35  -3.55  -3.05  -0.50
 *    55  -2.83  +0.60  -3.43        0.5  -3.48  -2.92  -0.57
 *    70  -2.80  +2.58  -5.38       0.75  -3.35  -2.62  -0.73
 *    85  -2.80  +2.84  -5.64          1  -3.20  -2.22  -0.98
 *
 * Two regimes, and the fixed knee is only right in one. At Peak Reduction 55+
 * the ceiling is LOAD-BEARING — un-ceilinged those renders deliver +0.60,
 * +2.58, +2.84 dBFS — and it is catching 3.4-5.6 dB of percentile-makeup
 * overshoot, exactly the job it was built for. At PR 10-40 the render is
 * already under the ceiling (-3.09, -3.18, -3.50) and the knee still takes
 * 0.30-0.48 dB for nothing.
 *
 * ⚠ SCHEPS IS STRUCTURALLY EXPOSED WHERE OPTOSMOOTH IS NOT, and that is what
 * made this worth fixing rather than noting. Its ceiling is the source peak and
 * at low Mix its output IS approximately the source, so the peak sample sits
 * where the knee is deepest BY CONSTRUCTION. At Mix 0 — bit-exact against the
 * delayed input with the ceiling off, verified — the ceiling alone cost
 * 0.63 dB of peak. The one setting that should be a reference for an A/B was
 * not one. At Mix 1 the real overshoot is 0.58 dB and the fixed knee charged
 * 0.98: it cost more than it caught.
 *
 * ⚠ A KNEE CANNOT BE BOTH SOFT AND FREE, so this does not try. Any curve that
 * is C1 and bounded by the ceiling must leave the unity line below it, so a
 * soft knee ALWAYS lands the peak under the ceiling; only a hard corner at the
 * ceiling costs nothing, and that is a clipper. The lever is therefore the
 * WIDTH, which is now the overshoot the render actually has:
 *
 *   overshoot <= -margin   knee 0     ceiling armed, hard, and never reached
 *   overshoot 0.58 dB      knee 1.08  the Scheps Mix 1 case
 *   overshoot >= 2.5 dB    knee 3     capped: OptoSmooth at PR 55+, unchanged
 *
 * ⚠ A ZERO WIDTH IS SAFE AND IS NOT A CLIPPER IN DISGUISE. `softCeiling` at
 * `kneeStart === ceiling` telescopes to a hard clamp at the ceiling, which is
 * only reachable by material the solve measured as being below it; the
 * guarantee is unchanged either way, and it is the ARMING that matters, not the
 * shape of a curve nothing touches.
 *
 * ⚠ IT IS A WIDTH, SO IT TRAVELS WITH THE SOLVE AND NOT WITH THE CEILING — BUT
 * IT IS ONLY VALID OVER THE SPAN THE SOLVE SAW. `processing.js` deliberately
 * re-measures `ceilingDb` over the WHOLE region while the solve only ever sees
 * a capped window, and the first version of this claimed that mismatch was safe
 * because a whole-region peak can only be HIGHER than the window's, making the
 * true overshoot smaller and this knee merely too wide.
 *
 * ⚠ THAT ARGUMENT WAS WRONG AND A REVIEWER CAUGHT IT. It is an argument about
 * the CEILING and the knee is sized from TWO measurements, not one: the
 * window's output peak is windowed too, the compressor is stateful, and a
 * transient outside the window can overshoot by more than anything inside it.
 * The subtraction can then return a near-zero width and hard-clamp material
 * nobody measured. It never breaks the guarantee — `softCeiling` still bounds
 * the output — so the cost is a hard corner where a soft one was intended,
 * which is the exact thing this knee exists to avoid.
 *
 * `analysedWholeRegion` is the guard: the measured width is used only when the
 * window covered the whole region, and a long selection falls back to the
 * conservative fixed knee it has always had.
 */
export function ceilingKneeDbFor(overshootDb) {
  /**
   * ⚠ -Infinity IS AN ANSWER AND NaN IS A MISSING ONE, so they must not share a
   * branch. A silent render peaks at -Infinity dB and genuinely has nothing to
   * catch, which is knee 0; only an absent or corrupt measurement should fall
   * back to the widest knee, because a fallback is a guess and the wide one is
   * the guess that cannot clip.
   */
  if (Number.isNaN(overshootDb) || overshootDb === undefined || overshootDb === null) {
    return CEILING_KNEE_DB
  }
  if (typeof overshootDb !== 'number') return CEILING_KNEE_DB
  const knee = overshootDb + CEILING_KNEE_MARGIN_DB
  return knee < 0 ? 0 : knee > CEILING_KNEE_DB ? CEILING_KNEE_DB : knee
}

/**
 * Memoryless soft ceiling. Asymptotic, so |output| never EXCEEDS `ceiling`, for
 * any input, with no lookahead and therefore no latency.
 *
 * ⚠ NEVER EXCEEDS, NOT ALWAYS STRICTLY BELOW, AND THE DIFFERENCE IS FLOAT64.
 * In exact arithmetic tanh is asymptotic and the ceiling is unreachable; in
 * float64 `Math.tanh` returns exactly 1 once its argument passes about 19, so
 * an input driven far enough above the knee lands ON the ceiling. That is still
 * the guarantee — the promise is "never louder than the source" — but a test
 * asserting strict inequality passes only for the drive levels it happens to
 * pick, which is how this got written down wrong the first time.
 *
 * ⚠ AND THE FINAL CLAMP IS NOT BELT-AND-BRACES, IT IS LOAD-BEARING. The
 * asymptote is `kneeStart + span`, and `span` is itself `ceiling - kneeStart`,
 * so the sum reassociates: in float64 `kneeStart + (ceiling - kneeStart)` can
 * land one ULP ABOVE `ceiling`. Measured — at a -8 dBFS ceiling the output
 * peaked fractionally over it and the guarantee test caught it, where the same
 * code at -6 and -12 passed. One ULP is inaudible and it is still the promise
 * broken, and a promise that holds at two ceilings out of three is not one.
 *
 * ⚠ MEMORYLESS AND NOT A LOOKAHEAD LIMITER, WHICH IS A DELIBERATE TRADE. A
 * lookahead limiter would hold the peak down more transparently, and it would
 * add latency to a kernel whose preview/apply equivalence and dry-path
 * alignment are all built on a fixed, known delay — `la2aLatencySamples` feeds
 * the region sizing, the makeup solve's own padding and the effect chain's
 * compensation. The measured workload does not justify paying that: the samples
 * this has to catch are a ten-thousandth of the file and it takes tenths of a
 * dB off them. A stage that engages this rarely does not need ballistics; it
 * needs to be exact and free.
 */
/**
 * The largest float32 that does not exceed `v`.
 *
 * ⚠ THE OUTPUT BUFFER IS A Float32Array, SO A float64 CEILING IS NOT A CEILING.
 * Clamping to 0.3981071705534972 and storing it writes 0.3981071710586548 —
 * float32's nearest neighbour, which is ABOVE. Measured on a -8 dBFS ceiling
 * the peak came back 5e-10 over, some 500,000x more than the one-ULP float64
 * slop the clamp above deals with, and no amount of care in float64 can fix it
 * because the excess is created by the store. Rounding the ceiling DOWN into
 * float32 first makes the clamped value exactly representable, so the store is
 * lossless and the guarantee survives it.
 *
 * Inaudible either way — 1e-8 dB — and the point is that "output peak never
 * exceeds input peak" is either a guarantee or it is not.
 */
export function float32AtOrBelow(v) {
  const f = Math.fround(v)
  if (f <= v) return f
  // One step down the float32 ladder, via the bit pattern rather than a
  // subtraction that would have to guess a magnitude-dependent epsilon.
  const bits = new Uint32Array(1)
  const view = new Float32Array(bits.buffer)
  view[0] = f
  bits[0] += f > 0 ? -1 : 1
  return view[0]
}

export function softCeiling(x, ceiling, kneeStart) {
  const a = x < 0 ? -x : x
  if (a <= kneeStart) return x
  const span = ceiling - kneeStart
  let y = kneeStart + span * Math.tanh((a - kneeStart) / span)
  if (y > ceiling) y = ceiling
  return x < 0 ? -y : y
}

/**
 * The `q`-quantile of sample MAGNITUDE across every channel, counting from the
 * top: q = 0.001 is the 99.9th percentile.
 *
 * ⚠ SAMPLE MAGNITUDES, NOT SHORT-BLOCK PEAKS, and that is the difference
 * between this and the percentile the note above rejected. A percentile OF
 * BLOCK PEAKS is a statistic over a few thousand numbers, so one loud syllable
 * is a meaningful share of it and the reference tracks the programme. Over
 * every sample it is a statistic on millions, where an isolated transient is
 * numerically invisible and a sustained one is not — which is exactly the
 * discrimination the makeup solve needs.
 *
 * Copies before sorting: the caller's buffers are the audio, and the offline
 * solve calls this on the input several times over.
 */
export function percentileOfChannels(channels, q, skip = 0) {
  let total = 0
  for (const ch of channels) total += Math.max(0, ch.length - skip)
  if (total <= 0) return 0
  const all = new Float32Array(total)
  let w = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) all[w++] = ch[i] < 0 ? -ch[i] : ch[i]
  }
  // The q-from-the-top index, counting back from the end of an ascending order.
  const idx = Math.min(total - 1, Math.max(0, Math.round(total * (1 - q)) - 1))
  return selectNth(all, idx)
}

/**
 * The value that would sit at `k` if `a` were sorted ascending. Quickselect —
 * O(n) expected, and it PARTIALLY orders `a` in place, so the caller must own
 * the array (ours is the copy made above).
 *
 * ⚠ IT REPLACED A FULL SORT BECAUSE THE SORT WAS A REAL COST, NOT A THEORETICAL
 * ONE. Measured on the 30 s analysis cap: sorting took 160.7 ms against 230.3 ms
 * for a whole base-rate kernel render, so the quantile was roughly 40 % of a
 * converged makeup solve — inside the budget that cap exists to protect, since
 * `measureInWorker` caps at 30 s precisely so a knob drag does not stall.
 *
 * ⚠ AND IT IS EXACT, NOT AN APPROXIMATION. A fixed-bin histogram would also be
 * O(n) and would quantise the answer; the makeup is derived from this number, so
 * a quantised quantile is a quantised gain. `test/dsp/makeupReference.test.js`
 * checks it against a full sort on random data, including the degenerate shapes
 * (all-equal, two values, already sorted) that a careless pivot mishandles.
 *
 * Median-of-three pivot: an already-sorted or reversed input is the common case
 * here — audio percentiles are taken on magnitudes, which are far from random —
 * and a first-element pivot degrades to O(n^2) on exactly those.
 */
function selectNth(a, k) {
  let lo = 0
  let hi = a.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    // Order lo/mid/hi so the median lands at `mid`, then stage it at lo + 1.
    if (a[mid] < a[lo]) { const t = a[mid]; a[mid] = a[lo]; a[lo] = t }
    if (a[hi] < a[lo]) { const t = a[hi]; a[hi] = a[lo]; a[lo] = t }
    if (a[hi] < a[mid]) { const t = a[hi]; a[hi] = a[mid]; a[mid] = t }
    const pivot = a[mid]

    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]; a[i] = a[j]; a[j] = t
        i++
        j--
      }
    }
    // One side is guaranteed to shrink, so this terminates even when the array
    // is all-equal — there `i` and `j` cross immediately at the pivot.
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return a[k]
  }
  return a[lo]
}

/**
 * Peak magnitude across every sample of every channel, in dB.
 *
 * The default makeup reference. Peak rather than RMS, and the distinction is
 * the whole point of makeup gain: the compressor pulls the loud moments down,
 * makeup hands back what it took, the peaks land where they started and
 * everything underneath rises with them. That is a compressor made louder
 * without being merely turned up — which is the comparison a listener is
 * actually running when they A/B it.
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
 *
 * ── THE PERCENTILE IS BACK, AND ONLY BECAUSE THE MISSING HALF ARRIVED ───────
 *
 * ⚠ NOTHING ABOVE IS WITHDRAWN. The percentile alone still fails exactly as
 * described, and the failure reproduces on demand: referencing the 99.9th
 * percentile at Peak Reduction 40 / 50 / 60 / 70 / 80 puts the OUTPUT PEAK at
 * -3.15 / -0.92 / +1.54 / +2.59 / +3.01 dBFS against a source peaking at
 * -2.80 — 5.81 dB above it at the top, against the 5.5 the note above
 * measured. A percentile reference cannot keep the peak guarantee, full stop.
 *
 * WHAT CHANGED IS THAT THE GUARANTEE NO LONGER HAS TO COME FROM THE SOLVE.
 * `ceilingDb` enforces it downstream, so the pair keeps the same promise the
 * peak reference kept — output peak never exceeds input peak — while spending
 * the headroom a lone transient was sitting on. That promise is now pinned by
 * `test/dsp/la2aMakeupReference.test.js` rather than being a property of the
 * arithmetic, which is the real cost of the change and is stated here so
 * nobody has to rediscover it: it is enforced, not structural, and the two
 * halves must ship together. `computeAutoMakeupPlan` is the only way to get
 * either, and it returns both.
 *
 * WHY IT IS WORTH IT. The lone-transient failure the note above calls "the safe
 * direction" is not free — it is the whole of the Peak Reduction 60 loudness
 * collapse. On narration whose binding peak is one onset out of a 180 ms pause,
 * peak-normalised to -1 dBFS at Peak Reduction 50: rms -17.39 -> -16.80 dB and
 * peak-over-body 4.38 -> 3.78 dB, with delivered speech dynamic range unmoved
 * at 9.11 -> 9.13. It recovers loudness that was being discarded rather than
 * buying it by compressing harder — a hardware LA-2A capture of the same take
 * sits at -16.38 and 3.35.
 *
 * ⚠ AND THE PERCENTILE IS NOW WHAT THE APP USES. It shipped off by default and
 * behind a panel toggle, was auditioned, and the toggle came back out: there is
 * no material on which the peak reference is the better answer, so there was
 * nothing for a user to choose between. `useLA2A` fixes the reference and the
 * panel has no control for it.
 *
 * ⚠ WHICH MEANS EVERY PATCH, PRESET AND PREVIOUSLY RENDERED FILE NOW SOUNDS
 * DIFFERENT — several dB louder at the same settings, and louder the further up
 * the knob. That is the intended change and it is not reversible from the UI.
 * A file already rendered on disk is untouched; the same patch re-applied to it
 * is not the same render.
 *
 * The peak reference remains the DEFAULT of this function and is what
 * `npm run la2a:makeup` renders against for comparison. It is the reference
 * anything measuring "makeup that cannot exceed the source by construction"
 * should still use.
 */
export function peakOfChannels(channels, skip = 0) {
  let peak = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) {
      const v = ch[i] < 0 ? -ch[i] : ch[i]
      if (v > peak) peak = v
    }
  }
  return peak
}

/**
 * THE PEAK RESTORE — the trim, in dB, that puts a rendered region's peak back
 * ON the ceiling instead of somewhere under it.
 *
 * ⚠⚠ IT IS NOT THE PEAK REFERENCE COMING BACK, AND THAT OBJECTION WAS RAISED
 * AND MEASURED DOWN. The reasoning against it was that restoring the peak after
 * the solve is arithmetically the same as solving for the peak in the first
 * place, so it would bring back the knob that ran backwards. That holds ONLY
 * while the ceiling is idle. Once the ceiling is catching peaks it is a
 * limiter, and the two paths separate — measured on a narrator's own 35 s take
 * at Input 60, both ending at -1 dBFS: restored -16.94 dB rms against the peak
 * reference's -19.21. Across the whole knob the restore holds -16.2 to -17.6
 * where the peak reference slides -17.5 to -20.3. It is identical to the peak
 * reference exactly where the ceiling does nothing (Input 20-30) and strictly
 * better everywhere above.
 *
 * ⚠ SO THE MAKEUP REFERENCE IS UNCHANGED. The solve still matches the 99.9th
 * percentile; this is a separate scalar applied to the finished render. The
 * body-to-source relationship the percentile buys is what makes the restore
 * safe to add, not something it replaces.
 *
 * ⚠ THE TRIM IS APPLIED BY SCALING THE RENDER, and that is equivalent to adding
 * it to BOTH `outputGainDb` and `ceilingDb` — verified bit-identical to 1.2e-7
 * (float32 rounding) over a nine-point Input sweep, because the ceiling's knee
 * is defined in dB relative to its own threshold and is therefore homogeneous.
 * Scaling the render is preferred anyway: it needs no second render and cannot
 * be got wrong by a caller who updates one of the two numbers and not the other.
 *
 * ⚠⚠ AND IT MUST BE MEASURED OVER THE WHOLE RENDERED REGION, NOT THE SOLVE'S
 * WINDOW. The makeup is solved on a capped, start-anchored window; a region's
 * loudest moment routinely falls outside it, and `windowPeak <= wholePeak`
 * always, so a window-derived trim is too GENEROUS. Applied with the ceiling
 * raised to match, it would push the later passage past the source peak — the
 * one guarantee the ceiling exists to provide, and a clip on anything already
 * near 0 dBFS. Hence the apply path computes this on its own output, which is
 * whole-region by construction.
 *
 * ⚠ THE PRICE, ACCEPTED DELIBERATELY: the live preview cannot know the region's
 * rendered peak, so preview and apply can differ by this trim — up to ~1.9 dB at
 * light settings, and under 0.1 dB from Input 40 up, where the ceiling is
 * already holding the peak. Everywhere else in this codebase preview and apply
 * are sample-identical; this is the one stage where they are not, and it was a
 * deliberate call by the owner rather than an oversight.
 *
 * Returns 0 when there is no ceiling (the peak reference needs no restore — its
 * guarantee is arithmetic) or when the region is silent.
 *
 * @param {Float32Array[]} channels the RENDERED region
 * @param {number|null} ceilingDb the source region's peak, dBFS
 */
export function peakRestoreTrimDb(channels, ceilingDb) {
  if (!Number.isFinite(ceilingDb)) return 0
  const peak = peakOfChannels(channels)
  if (!(peak > 0)) return 0
  return ceilingDb - 20 * Math.log10(peak)
}

/**
 * Scale a rendered region by `peakRestoreTrimDb`, in place, and return the trim.
 *
 * ⚠ A NEGATIVE TRIM IS APPLIED TOO, and that is the invariant rather than an
 * edge case: if a render ever comes back ABOVE the ceiling this pulls it down,
 * so "never louder than the source" holds by enforcement here as well as in the
 * kernel. Clamping at zero would leave the one case that actually matters.
 */
export function restorePeakToCeiling(channels, ceilingDb) {
  const trimDb = peakRestoreTrimDb(channels, ceilingDb)
  if (!trimDb) return 0
  const g = Math.pow(10, trimDb / 20)
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= g
  }
  return trimDb
}

// ── The blend: makeup solved over dry·(1−mix) + wet·mix·g ───────────────────
//
// Shared by FET Punch and OptoSmooth. Given one render of the WET path, these
// answer "what gain on the wet path makes the blended output hit its target"
// with O(n) passes instead of renders. For FET Punch that is exact, because its
// Output is the last multiply on the wet path. For OptoSmooth it is exact to
// first order around the gain the wet path was rendered at — its Gain sits
// before the output valve — so `solveMakeupPlan` re-renders and asks again.

const LN10_OVER_20 = Math.LN10 / 20

/**
 * The blended output at wet gain `g` (linear), written into `scratch`, which
 * the caller owns. `dry` and `wet` must be sample-aligned: any latency is the
 * caller's to remove before this pairs `dry[i]` with `wet[i]`.
 */
export function blendInto(scratch, dry, wet, mix, g) {
  const dryMix = 1 - mix
  for (let ch = 0; ch < wet.length; ch++) {
    const d = dry[ch]
    const w = wet[ch]
    const o = scratch[ch]
    for (let i = 0; i < o.length; i++) o[i] = d[i] * dryMix + w[i] * mix * g
  }
  return scratch
}

/**
 * The largest linear wet gain for which every blended sample stays within
 * ±`limit` — the peak reference, solved in closed form. Each sample is
 * `a + b·g`, so each bounds `g` from one side; the answer is the tightest bound.
 *
 * @returns the gain, or null when nothing on the wet path constrains it
 */
export function peakBlendGain(dry, wet, mix, limit) {
  const dryMix = 1 - mix
  let gMax = Infinity
  for (let ch = 0; ch < wet.length; ch++) {
    const d = dry[ch]
    const w = wet[ch]
    for (let i = 0; i < w.length; i++) {
      const b = w[i] * mix
      if (b === 0) continue
      const a = d[i] * dryMix
      // The binding end of this sample's interval is the one it moves toward.
      const bound = (b > 0 ? limit - a : -limit - a) / b
      if (bound < gMax) gMax = bound
    }
  }
  return Number.isFinite(gMax) ? gMax : null
}

/**
 * The linear wet gain that puts the blend's `MAKEUP_PERCENTILE` level on
 * `targetRef`, searched over [minDb, maxDb].
 *
 * At mix 1 it is closed form: every sample is `b·g`, so the quantile scales
 * with `g` exactly. Below mix 1 the dry sum breaks that, and it bisects —
 * the quantile is monotone non-decreasing in `g` once the wet share
 * dominates, and an answer pinned to an end of the bracket is the clamp doing
 * its job, not a failed solve. Sixteen halvings of a 48 dB bracket land inside
 * a thousandth of a dB.
 *
 * @param scratch  per-channel buffers the length of `wet`, reused across calls
 * @returns the gain, or null when the wet path is silent at the reference
 */
export function percentileBlendGain(dry, wet, mix, targetRef, minDb, maxDb, scratch) {
  if (mix >= 1) {
    const wetRef = percentileOfChannels(wet, MAKEUP_PERCENTILE)
    if (!(wetRef > 0)) return null
    return targetRef / (wetRef * mix)
  }
  let loDb = minDb
  let hiDb = maxDb
  for (let i = 0; i < 16; i++) {
    const midDb = 0.5 * (loDb + hiDb)
    const ref = percentileOfChannels(blendInto(scratch, dry, wet, mix, Math.exp(midDb * LN10_OVER_20)), MAKEUP_PERCENTILE)
    if (ref < targetRef) loDb = midDb
    else hiDb = midDb
  }
  return Math.exp(0.5 * (loDb + hiDb) * LN10_OVER_20)
}

/**
 * The makeup solve, and the ceiling that has to ship with it.
 *
 * ⚠ EXTRACTED FROM `la2aProcessor.js` SO FET PUNCH CAN USE IT, and the two
 * halves still cannot be separated. A percentile reference does NOT guarantee
 * "never louder than the source" — that is the point of it, since a peak
 * reference lets one uncompressed onset pin the whole file — so the guarantee
 * comes back as enforcement instead: a memoryless ceiling at the region's own
 * peak, with a knee sized by how far the solve actually overshot it. Ask for
 * `reference: 'percentile'` and you get a ceiling; ask for `'peak'` and there is
 * nothing to catch and none is returned.
 *
 * The caller supplies its own renderer and its own latency, which is all that
 * was ever LA-2A-specific about this.
 *
 * ⚠ BELOW MIX 1 THE LOOP CHANGES, AND IT HAS TO. The plain loop adds the
 * whole dB error to the makeup each pass, which assumes a dB of makeup moves
 * the output a dB. Summed with a dry path it moves it by the wet share only,
 * so every pass under-corrects and four passes stall: measured on narration at
 * Peak Reduction 70, the makeup landed 1.4 / 4.6 / 9.8 dB short at mix
 * 0.5 / 0.3 / 0.1 (the level only 0.7 / 1.2 / 0.6 dB short — the dry path
 * dominates — which is why a level check alone would not catch it). So below
 * mix 1 each pass renders the WET path alone at the current makeup and solves
 * the blend over that render (`percentileBlendGain` / `peakBlendGain`, FET
 * Punch's solve), then re-renders to absorb whatever the renderer does after
 * its gain stage. Measured: on target to 0.01 dB in two renders at every
 * setting tried, PR 30-70 by mix 0.1-1, where the plain loop used four.
 *
 * At mix 1 the plain loop runs, unchanged: there the blend solve IS the plain
 * correction, and leaving the code alone keeps every existing answer
 * bit-identical.
 *
 * @param render   (channelData, extraParams) => channelData, at unity makeup
 *                 plus whatever `extraParams` says
 * @param latency  samples the renderer delays its output by, or 0
 * @param mix      the renderer's wet/dry blend, 0-1; its dry path must be the
 *                 input itself, aligned by `latency`
 * @param mixKey   the renderer's param for it, set to 1 for the wet-only renders
 */
export function solveMakeupPlan({
  channelData, render, latencySamples = 0, gainKey = 'gainDb',
  reference = 'peak', maxIterations = 4, toleranceDb = 0.05,
  minDb = -24, maxDb = 24, mix = 1, mixKey = 'mix',
}) {
  if (reference !== 'peak' && reference !== 'percentile') {
    throw new Error(`unknown makeup reference: ${reference}`)
  }
  const measureRef = reference === 'percentile'
    ? (chs) => percentileOfChannels(chs, MAKEUP_PERCENTILE)
    : peakOfChannels

  const inputPeak = peakOfChannels(channelData)
  const inputRef = measureRef(channelData)
  if (!(inputPeak > 0) || !(inputRef > 0)) {
    return { makeupDb: 0, ceilingDb: null, ceilingKneeDb: null }
  }

  /**
   * ⚠ THE MEASURED SPAN MUST BE THE SPAN APPLY WRITES BACK. With lookahead the
   * output lags its input, so the last `latency` samples never emerge and the
   * first `latency` are the delay line filling with silence — measuring the
   * render as-is compares a region's input peak against an output missing that
   * region's tail, and on a short selection the tail is often where the peak is.
   */
  const len = channelData[0].length
  const padded = latencySamples > 0
    ? channelData.map((ch) => {
      const q = new Float32Array(ch.length + latencySamples)
      q.set(ch, 0)
      return q
    })
    : channelData

  const wetMix = Math.max(0, Math.min(1, Number.isFinite(mix) ? mix : 1))
  if (wetMix <= 0) {
    // All dry: the makeup reaches nothing, so there is nothing to solve.
    return { makeupDb: 0, ceilingDb: null, ceilingKneeDb: null }
  }
  if (wetMix < 1) {
    return solveBlendedMakeupPlan({
      channelData, padded, len, render, latencySamples, gainKey, mixKey,
      reference, maxIterations, toleranceDb, minDb, maxDb,
      mix: wetMix, inputPeak, inputRef,
    })
  }

  let makeupDb = 0
  let lastOutPeak = 0
  let lastMakeupDb = 0
  for (let i = 0; i < maxIterations; i++) {
    const rendered = render(padded, { [gainKey]: makeupDb })
    const out = latencySamples > 0
      ? rendered.map((ch) => ch.subarray(latencySamples, latencySamples + len))
      : rendered
    lastOutPeak = peakOfChannels(out)
    lastMakeupDb = makeupDb
    const outRef = measureRef(out)
    if (outRef <= 0) break
    const correctionDb = 20 * Math.log10(inputRef / outRef)
    makeupDb = Math.max(minDb, Math.min(maxDb, makeupDb + correctionDb))
    if (Math.abs(correctionDb) < toleranceDb) break
  }

  if (reference !== 'percentile') {
    // The peak reference needs no ceiling, so it needs no knee either.
    return { makeupDb, ceilingDb: null, ceilingKneeDb: null }
  }
  const ceilingDb = 20 * Math.log10(inputPeak)
  /**
   * The loop renders at `makeupDb` and only THEN corrects it, so the last
   * render is one step stale. Carried forward rather than re-rendered: the gain
   * is ahead of the peak by that step, and the step is under `toleranceDb` on a
   * converged solve.
   */
  const outPeakDb = lastOutPeak > 0
    ? 20 * Math.log10(lastOutPeak) + (makeupDb - lastMakeupDb) : -Infinity
  return { makeupDb, ceilingDb, ceilingKneeDb: ceilingKneeDbFor(outPeakDb - ceilingDb) }
}

/**
 * `solveMakeupPlan` below mix 1: one wet-only render per pass, the blend solved
 * over it, repeated until the wet path's own curvature has been absorbed. See
 * the note on `solveMakeupPlan`.
 */
function solveBlendedMakeupPlan({
  channelData, padded, len, render, latencySamples, gainKey, mixKey,
  reference, maxIterations, toleranceDb, minDb, maxDb, mix, inputPeak, inputRef,
}) {
  const scratch = channelData.map(() => new Float32Array(len))
  let makeupDb = 0
  let wet = null
  let wetAtDb = 0
  for (let i = 0; i < maxIterations; i++) {
    const rendered = render(padded, { [gainKey]: makeupDb, [mixKey]: 1 })
    wet = latencySamples > 0
      ? rendered.map((ch) => ch.subarray(latencySamples, latencySamples + len))
      : rendered
    wetAtDb = makeupDb
    // The extra wet gain, relative to the render, bounded so the answer stays
    // inside [minDb, maxDb].
    const g = reference === 'percentile'
      ? percentileBlendGain(channelData, wet, mix, inputRef, minDb - makeupDb, maxDb - makeupDb, scratch)
      : peakBlendGain(channelData, wet, mix, inputPeak)
    if (g === null || !(g > 0)) break
    const correctionDb = 20 * Math.log10(g)
    makeupDb = Math.max(minDb, Math.min(maxDb, makeupDb + correctionDb))
    if (Math.abs(correctionDb) < toleranceDb) break
  }

  if (reference !== 'percentile') {
    return { makeupDb, ceilingDb: null, ceilingKneeDb: null }
  }
  const ceilingDb = 20 * Math.log10(inputPeak)
  /**
   * The overshoot the ceiling has to catch, read off the blend at the makeup
   * that ships — the last wet render scaled by the final step, which is
   * exactly what the solve itself assumed.
   */
  const outPeak = wet
    ? peakOfChannels(blendInto(scratch, channelData, wet, mix, Math.exp((makeupDb - wetAtDb) * LN10_OVER_20)))
    : 0
  const outPeakDb = outPeak > 0 ? 20 * Math.log10(outPeak) : -Infinity
  return { makeupDb, ceilingDb, ceilingKneeDb: ceilingKneeDbFor(outPeakDb - ceilingDb) }
}
