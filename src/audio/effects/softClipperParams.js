/**
 * The Soft Clipper's parameter contract: what the panel may set, and how those
 * values reach the kernel.
 *
 * Split out of softClipper.js so it can be imported under node. That file pulls
 * a Vite `?worker&url` specifier which only the bundler can resolve, so nothing
 * in it was reachable from the test suite — and the one thing that most needed
 * testing was in there: the list of keys `setParam` will accept.
 */
import {
  SOFT_CLIPPER_KERNEL_DEFAULTS, softClipperLatencySamples,
} from '../softClipperProcessor.js'

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
    limiter: params.limiter,
    // Forwarded ONLY when the hidden tuning panel has set a real number.
    // The kernel merges partials over its own defaults, so an `emphasisDb:
    // undefined` in this object would not fall back to the pin — it would
    // overwrite it with undefined and NaN its way through the recompute
    // guard. Spread-or-nothing rather than a value, for that reason.
    ...(Number.isFinite(params.emphasisDb) ? { emphasisDb: params.emphasisDb } : {}),
  }
}


/**
 * THE TWO WAYS THIS STAGE CAN CONTROL A PEAK, as a switch rather than a knob.
 *
 * `limiter` is a continuous 0-100 balance between the lookahead limiter and the
 * clip curve, and it stays continuous for the admin panel. The faceplate offers
 * two positions, because measurement says the middle of that knob is the worst
 * place to be.
 *
 * ⚠ THE LATENCY IS BINARY, WHICH IS HALF THE ARGUMENT. The lookahead is either
 * in circuit or it is not: about 1.1 ms at limiter 0 and about 5.1 ms at every
 * setting above it. There is no intermediate cost to buy an intermediate
 * benefit with.
 *
 * ⚠ IN SAMPLES THAT IS 50 AND 226 AT 44.1 kHz, AND 50 AND 242 AT 48 — the
 * lookahead is a fixed LIMITER_LOOKAHEAD_MS, so the COUNT scales with the rate
 * while the TIME does not. A bare sample count in a note about latency has
 * already been misread once as milliseconds; quote the time.
 *
 * ⚠ AND THE BENEFIT IS WILDLY NON-LINEAR, WHICH IS THE OTHER HALF. Matched on
 * OUTPUT PEAK on the shipping configuration (fixed ceiling, emphasis 0,
 * tanh^4), the curve's own residual across limiter 0 / 25 / 50 / 75 / 100:
 *
 *   2.5 dB of peak reduction   -33.32  -33.98  -34.38  -50.90  -76.51 dBc
 *   5.0 dB of peak reduction   -19.83  -21.49  -25.86  -44.54  -76.23
 *
 * Limiter 50 buys 1.1 dB at the gentle setting and 6 dB at the deep one, while
 * paying the FULL latency; 75 buys 17-25 dB and 100 buys 43-56 dB for exactly
 * the same latency. Once the latency is paid, stopping halfway is the worst of
 * both. ⚠ And it can be actively worse: on one narrator limiter 25 leaves the
 * curve doing MORE than limiter 0 (3.95 dB against 3.90, residual -33.01
 * against -33.35), because a ceiling several dB above the threshold reshapes
 * the region around a peak without removing the crossing.
 *
 * ⚠ AT `limit` THE CURVE IS COMPLETELY IDLE — peak GR 0.00 dB, residual around
 * -76 dBc, which is the oversampler's own floor. So the stage is not clipping
 * at all in that mode: it is a lookahead limiter whose no-overshoot guarantee
 * is STRUCTURAL, with the curve sitting behind it as a safety net. That is
 * worth saying plainly rather than selling it as a gentler clipper.
 *
 * ⚠ EVERY EARLIER LIMITER FIGURE IN CLAUDE.md PREDATES THIS BUILD and was
 * measured in adaptive mode. The sub-threshold ducking that once justified a
 * middle setting is far smaller here — 1.8% at 2.5 dB of reduction and 11.3% at
 * 5 dB, against 24-36% on record — because a fixed ceiling placed near the
 * peaks leaves little underneath it to duck.
 */
/**
 * ⚠ THE LABELS NAME THE MECHANISM, NOT A DEGREE. CLIP and LIMIT are two
 * different processes, not two strengths of one — at LIMIT the curve's peak
 * reduction is 0.00 dB and the lookahead limiter is doing all of it. An earlier
 * pair, PRECISE/CLEAN, described the RESULT and read as one process turned up
 * or down, which is the thing that is not true here.
 *
 * The captions carry the trade-off, the titles carry the numbers. Latency is in
 * the title rather than on the faceplate because it is the reason to choose,
 * not the thing being chosen — but it must be disclosed SOMEWHERE, since
 * throwing the switch shifts the running preview by about 4 ms.
 */
export const LIMITER_MODES = [
  {
    id: 'clip',
    label: 'CLIP',
    caption: 'low latency',
    limiter: 0,
    title: 'The clip curve does the peak control by reshaping samples. About '
      + '1.1 ms of latency; the residual is genuine harmonic distortion on the '
      + 'peaks it shapes.',
  },
  {
    id: 'limit',
    label: 'LIMIT',
    caption: 'low distortion',
    limiter: 100,
    title: 'A lookahead limiter does the peak control with a gain envelope and '
      + 'the curve sits idle behind it. About 5.1 ms of latency, and far less '
      + 'distortion — its no-overshoot guarantee is structural.',
  },
]

/**
 * Which mode a `limiter` value corresponds to, or '' for none of them.
 *
 * ⚠ THE EMPTY STRING IS LOAD-BEARING. The admin panel can set any value in
 * between, and a switch that lit a position it was not actually at would be a
 * readout that stops being true the moment anything changes — the same failure
 * the ceiling presets' lamp is written to avoid. It is a string rather than
 * null because SegmentedSwitch compares with String() and requires a value.
 */
export function limiterModeFor(limiter) {
  const m = LIMITER_MODES.find(x => x.limiter === limiter)
  return m ? m.id : ''
}

export function limiterModeById(id) {
  return LIMITER_MODES.find(x => x.id === id) ?? null
}

/**
 * The stage's latency in ms for a mode, at a given rate — what the panel shows.
 *
 * Read from the kernel's own latency function rather than restated, because a
 * caption quoting a number the audio path does not agree with is how the apply
 * path came to trim 50 samples off a render delayed by 226 (at 44.1 kHz).
 */
export function limiterModeLatencyMs(limiter, sampleRate) {
  return (softClipperLatencySamples({ limiter }, sampleRate) / sampleRate) * 1000
}
