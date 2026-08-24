/**
 * The Soft Clipper's parameter contract: what the panel may set, and how those
 * values reach the kernel.
 *
 * Split out of softClipper.js so it can be imported under node. That file pulls
 * a Vite `?worker&url` specifier which only the bundler can resolve, so nothing
 * in it was reachable from the test suite — and the one thing that most needed
 * testing was in there: the list of keys `setParam` will accept.
 */
import { SOFT_CLIPPER_KERNEL_DEFAULTS } from '../softClipperProcessor.js'

/**
 * DERIVED from the kernel's own defaults rather than restated here.
 *
 * These were a second literal listing the same five values, which is one
 * careless edit away from the preview and the applied audio running different
 * settings — silently, since every value either object could hold is valid.
 * The kernel is the source of truth; the panel reads this.
 *
 *   headroomDb 4-16, primary control — lower means more clipping
 *   limiter 0-100, how much of the peak control the lookahead limiter takes
 *     from the curve — see LIMITER_MAX_ABOVE_DB. 0 bypasses it entirely,
 *     including its latency. ⚠ It CHANGES THE STAGE'S LATENCY while engaged
 *   soften 0-100, a limit on how fast the waveform may move, inside the
 *     oversampled path just ahead of the curve. See SOFTEN_REF. ⚠ It reached
 *     the kernel through a `drive` knob until that knob's other two members
 *     left — asymmetry deleted, HF Loss moved to Tube Saturation
 *   outputTrimDb ±6, post-stage gain match for A/B
 *   thresholdMode 'adaptive' | 'fixed' — the panel only ever sets 'fixed'
 *   fixedThresholdDb, the ceiling in dBFS. The panel's preset buttons measure
 *     the region and write this; see ceilingPresets.js
 *   shape 'tanh2' | 'tanh3' | 'tanh4', the knee — see SHAPE_EXPONENT and
 *     SHAPE_ANCHOR_DB (the positions are depth-matched, so this changes
 *     character rather than how much the stage does)
 *
 * `hysteresis` is absent on purpose: it is pinned in the kernel and has no
 * control at all — see HYST_MAX_DB. Forwarding the key would let an absent
 * value overwrite the pin with undefined, so it is deliberately omitted.
 *
 * `emphasisDb` is a special case: pinned for everyone, but reachable from the
 * hidden tuning panel (see softClipperTuning.js). It is null here so the
 * shipped path forwards nothing and the kernel's pin governs; a real number
 * set by the tuning panel is forwarded. See toKernelParams.
 */
export const SOFT_CLIPPER_DEFAULTS = {
  ...SOFT_CLIPPER_KERNEL_DEFAULTS,
  // ⚠ NULL, NOT THE KERNEL'S VALUE. The key has to exist or `setParam` drops
  // it silently, but its value must not be forwarded on the shipped path: the
  // pin lives in the kernel, and a panel that mirrors a pinned constant is one
  // careless edit away from overriding it with a stale copy of itself.
  emphasisDb: null,
}

/** Params are already kernel-shaped — no renaming needed unlike FET1176/LA2A. */
export function toKernelParams(params) {
  return {
    headroomDb: params.headroomDb,
    outputTrimDb: params.outputTrimDb,
    thresholdMode: params.thresholdMode,
    fixedThresholdDb: params.fixedThresholdDb,
    shape: params.shape,
    soften: params.soften,
    limiter: params.limiter,
    // Forwarded ONLY when the hidden tuning panel has set a real number.
    // The kernel merges partials over its own defaults, so an `emphasisDb:
    // undefined` in this object would not fall back to the pin — it would
    // overwrite it with undefined and NaN its way through the recompute
    // guard. Spread-or-nothing rather than a value, for that reason.
    ...(Number.isFinite(params.emphasisDb) ? { emphasisDb: params.emphasisDb } : {}),
  }
}

