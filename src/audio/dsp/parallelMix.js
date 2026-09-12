/**
 * PARALLEL BLEND LAW — the gains for mixing a compressed copy back against its
 * own source, without the blend itself changing how loud the result is.
 *
 * ⚠ SHARED BECAUSE TWO PLUGINS NOW BLEND THE SAME WAY AND THE LAW IS NOT
 * OBVIOUS. Scheps Parallel blends its Pultec/LA-2A wet path against the
 * untouched input; the vocal chain's dynamics section blends its opto block
 * against the POST-FET signal. Same arithmetic, different measured inputs — and
 * a second copy would be a second place for a subtle loudness bias to creep in.
 *
 * ⚠ THE MEASURED INPUTS DO NOT TRANSFER BETWEEN THE TWO, WHICH IS THE WHOLE
 * REASON THIS NOTE EXISTS. `correlation` and `densityDb` describe a specific
 * pair of paths. The chain's dry side is already compressed by the FET, so it
 * is MORE like its wet copy (correlation up) and the compression's remaining
 * yield is smaller (density down). Reusing Scheps' numbers here would make Mix
 * drift in loudness across its sweep — exactly the failure the compensation
 * exists to prevent.
 */

const LN10_OVER_20 = Math.LN10 / 20

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Clamp, but reject anything that is not a finite number.
 *
 * Params reach this kernel over a message port from UI state, so one undefined
 * or NaN is always one bug away — and since the makeup is now the compressor's
 * own Gain, a NaN no longer stays local. It enters the T4 cell's envelope and
 * memory, which are persistent, and the kernel then outputs NaN forever: the
 * effect goes silent and stays silent until the page is reloaded. Measured
 * exactly that way — one bad push, then twenty blocks of good params, still all
 * non-finite.
 *
 * `clamp` alone cannot catch it: `undefined < lo` and `undefined > hi` are both
 * false, so it returns undefined unchanged.
 */
export function finite(v, fallback, lo, hi) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback
}

/**
 * Dry and wet gains for a mix position, plus the compensation that keeps the
 * sum's level constant across the whole sweep.
 *
 * Equal power (cos/sin) is the right law here and a linear blend is not: at the
 * halfway point a linear blend is 6 dB down on each path and audibly dips. But
 * equal power assumes the two paths are uncorrelated, and these two are the same
 * voice — below a kilohertz they are nearly the same waveform. Summing them at
 * cos/sin therefore lands up to 3 dB HOT in the middle of the sweep, which is
 * the same loudness bias the auto trim exists to remove, arriving by a different
 * door.
 *
 * With the wet path level-matched to the dry one, the sum's power is
 * `1 + rho*sin(2*theta)` — exactly 1 when the two are uncorrelated, and up to
 * `1 + rho` when they track each other. Dividing by its square root makes the
 * blend loudness-flat end to end for a measured rho, and degenerates to plain
 * equal power when rho is 0.
 *
 * Exported for the tests and the panel readout.
 */
export function mixGains(mix, correlation = 0, densityDb = 0) {
  const theta = finite(mix, 0, 0, 1) * (Math.PI / 2)
  const dry = Math.cos(theta)
  const wet = Math.sin(theta)
  const rho = finite(correlation, 0, -0.98, 0.98)
  const r = Math.exp(finite(densityDb, 0, -12, 12) * LN10_OVER_20)

  // What the sum WOULD be if the two paths were independent. This is the target
  // rather than unity, and the difference is the point: the wet copy is louder
  // on average than the dry one by `densityDb`, because its loud parts were
  // pulled down and handed back. That gain is the compression's yield and has
  // to survive the blend — flattening it is what left the plugin unable to make
  // anything louder.
  const target = dry * dry + r * r * wet * wet
  // What it actually is, with the interference term the correlation creates.
  const actual = target + 2 * rho * r * dry * wet
  const compensation = Math.sqrt(target / Math.max(actual, 1e-6))
  // `r` shapes the compensation only. It is not applied as a gain: the wet path
  // is ALREADY that much louder on average, because the trim put its loud parts
  // level and compression raised everything underneath them. Multiplying by it
  // here would count the same density twice.
  return { dry, wet, compensation }
}

