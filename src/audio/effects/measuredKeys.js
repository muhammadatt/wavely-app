/**
 * MEASURED PARAMS AND THE CLEAR THAT COULD NOT REACH THE KERNEL.
 *
 * ⚠ THIS EXISTS BECAUSE A `null` COULD NOT TURN A GUARANTEE OFF, AND THE BUG
 * WAS SILENT, PREVIEW-ONLY, AND OLDER THAN THE KNEE THAT SURFACED IT.
 *
 * Measured params (`ceilingDb`, `ceilingKneeDb`, `inputAlignDb`) are absent from
 * the panel defaults and are mapped into kernel params ONLY when finite — see
 * `toKernelParams` in la2aParams.js for why that conditional spread is right:
 * it keeps the params object key-for-key what it always was everywhere the
 * measurement is not in play, and a test pins that shape.
 *
 * The live node is a different story. `setParam` re-maps the WHOLE panel object
 * and posts it, and the kernel's `setParams` MERGES a partial
 * (`{ ...this.params, ...partial }`). So an omitted key does not mean "null", it
 * means "unchanged" — and `pushParam('ceilingDb', null)`, which is exactly what
 * `disableAutoMakeup` and `toggleAutoTrim` do, mapped to an object with no
 * `ceilingDb` in it and left the previous ceiling ARMED on the live node.
 *
 * MEASURED, before the fix: solve at ceiling -6 dBFS, then push null for both
 * keys. `ceilingLin` stayed 0.501187 and `ceilingKneeLin` 0.436516 — unchanged.
 *
 * WHAT THAT COST. The composables' own comments say this must not happen: "a
 * manual setting silently held down by the last measurement's ceiling, with
 * nothing on the panel saying so". It was preview-only — the apply path builds
 * fresh params for a fresh kernel, so the render was always right — which made
 * it worse, not better: it is a preview/apply divergence, on the one control
 * whose whole job is that the two agree.
 *
 * ⚠ THE FIX IS ON THE RUNTIME PATH ONLY, DELIBERATELY. `toKernelParams` keeps
 * omitting, so presets, patches, the apply path and the shape test are all
 * untouched; the explicit null is added only where a kernel is being UPDATED
 * rather than constructed, which is the only place the distinction exists.
 */

/**
 * Params that are measured from the audio rather than dialled, and can
 * therefore be legitimately cleared back to "no measurement".
 *
 * ⚠ ANYTHING ADDED TO A `toKernelParams` AS A CONDITIONAL SPREAD BELONGS HERE
 * TOO. The conditional spread is the half that hides a clear; this is the half
 * that delivers it.
 */
export const MEASURED_KEYS = Object.freeze(['ceilingDb', 'ceilingKneeDb', 'inputAlignDb'])

/**
 * Kernel params for a LIVE node: the mapping, plus an explicit `null` for every
 * measured key the mapping left out, so a merge can clear as well as set.
 *
 * Takes the already-mapped object so each plugin keeps its own mapping and this
 * stays the one definition of the clear.
 */
export function withMeasuredClears(kernelParams, keys = MEASURED_KEYS) {
  const out = { ...kernelParams }
  for (const key of keys) if (!(key in out)) out[key] = null
  return out
}
