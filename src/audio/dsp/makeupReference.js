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
 * How far below the ceiling the soft knee starts, dB.
 *
 * The knee is C1 at its start — the curve leaves the unity line with unity
 * slope — so nothing below `ceiling - CEILING_KNEE_DB` is touched at all and
 * the transition into the ceiling has no corner. 3 dB is wide enough that the
 * bend is inaudible on the handful of samples that reach it and narrow enough
 * that it never reaches the programme: measured on narration, the ceiling
 * attenuates the loudest 0.1 % of samples by 0.00 / 0.07 / 0.19 / 0.24 dB at
 * Peak Reduction 50 / 60 / 70 / 80, and the 1-10 % band by 0.00 dB at every
 * one of them.
 */
export const CEILING_KNEE_DB = 3

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
