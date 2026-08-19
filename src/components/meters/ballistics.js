/**
 * Shared meter ballistics and scale law for the gain-reduction meters.
 *
 * Both the analog VU movement and the horizontal bar read the same quantity,
 * so they read it the same way: identical damping, identical scale law,
 * identical engraving vocabulary. The only difference left between them is
 * the shape of the thing that moves.
 *
 * Why damping at all: the compressors report their envelope every frame, and
 * an envelope with a millisecond attack is a blur at 60 fps — the eye sees a
 * flickering band, not a number. A damped reading is legible because it is an
 * average, and the transient depth that the averaging throws away is put back
 * by the peak hold, which tracks instantly and then sits still long enough to
 * be read.
 */

import { onMounted, onUnmounted } from 'vue'

/**
 * Time constant of each pole, in ms.
 *
 * Two of these in series settle to 99% of a step in ~6.6 tau — 300 ms, the VU
 * standard. A real movement is a second-order system near critical damping and
 * overshoots by about 1%; a two-pole cascade is slightly overdamped and does
 * not. The difference is a fraction of a pixel of needle bounce.
 */
export const VU_TAU_MS = 45

/** Frames longer than this are treated as this long — tab wake-ups, mostly. */
const MAX_STEP_MS = 100

/**
 * VU-standard damping. Symmetric: rise and fall take the same time, which is
 * what makes the reading an average rather than an envelope follower.
 */
export function createVuBallistics({ tauMs = VU_TAU_MS, initial = 0 } = {}) {
  let s1 = initial
  let s2 = initial
  return {
    get value() {
      return s2
    },
    push(target, dtMs) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS)
      if (dt === 0) return s2
      const k = Math.exp(-dt / tauMs)
      s1 = target + (s1 - target) * k
      s2 = s1 + (s2 - s1) * k
      return s2
    },
    reset(v = initial) {
      s1 = v
      s2 = v
      return s2
    },
  }
}

/** Matches the level meter's hold, so every peak mark in a panel waits alike. */
export const PEAK_HOLD_MS = 1200

/**
 * Fall rate as a fraction of the scale per second — full travel in ~3 s.
 *
 * Deliberately expressed in scale fraction rather than dB. The level meter
 * falls at a fixed dB/s across a nearly linear face, so its hold line moves at
 * a nearly constant speed. Doing the same on the voltage-law GR scale would
 * not: a dB is worth 12% of the face at rest and 1% at 20 dB of reduction, so
 * a fixed dB/s marker crawls at the deep end and then accelerates to more than
 * twice the level meter's speed over the last few dB — which is what makes it
 * read as a flick rather than a fall. Falling at a fixed fraction instead
 * keeps one speed everywhere on the scale, and puts that speed inside the
 * range the level meter's hold line already moves at.
 */
export const PEAK_FALL_PER_SEC = 0.32

/**
 * Instant attack, flat hold, then a constant-rate fall.
 *
 * The fall is linear in the unit it is given rather than exponential, so the
 * marker leaves at a steady speed instead of hanging near the top — a peak
 * that decays exponentially reads as a second, slower average. Both callers
 * push scale fractions, hence the defaults; the mechanism is unit-agnostic.
 */
export function createPeakHold({
  holdMs = PEAK_HOLD_MS,
  fallPerSec = PEAK_FALL_PER_SEC,
  floor = 0,
} = {}) {
  let peak = floor
  let heldMs = 0
  return {
    get value() {
      return peak
    },
    push(target, dtMs) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS)
      if (target >= peak) {
        peak = target
        heldMs = 0
        return peak
      }
      heldMs += dt
      if (heldMs >= holdMs) peak = Math.max(target, peak - (fallPerSec * dt) / 1000)
      return peak
    },
    reset(v = floor) {
      peak = v
      heldMs = 0
      return peak
    },
  }
}

/** Averaging window for the held readout, in ms. Roughly a spoken phrase. */
export const AVERAGE_WINDOW_MS = 1000

/**
 * A number that states the average of the last window and then sits still.
 *
 * Slowing a live reading down is not the same as averaging it. A throttle
 * samples a value that is still jittering, so consecutive samples land
 * wherever the jitter happened to be and the number jumps by the full width of
 * the variation — just less often. Averaging removes the variation first, so
 * consecutive windows are genuinely close together and the number reads as
 * stationary. That is the difference between a readout you can glance at and
 * one you have to stare at.
 *
 * Gated, and this is the part that matters for speech. Gain reduction is zero
 * through every pause, and narration is a third to a half pause — averaged
 * across everything the number reports how hard the compressor works on the
 * file, which nobody wants to know. Gated to the frames where it is actually
 * working, it reports how hard it works on the voice, which is the question.
 */
export function createHeldAverage({
  windowMs = AVERAGE_WINDOW_MS,
  // Below this the stage is idling, not compressing.
  gate = 0.25,
  // A window this empty has nothing to report; keep showing the last one.
  minCoverage = 0.15,
  // Consecutive empty windows before the reading is abandoned as stale. Stops
  // a stopped transport leaving a number under a bar that reads zero.
  clearAfterWindows = 3,
} = {}) {
  let sum = 0
  let gatedMs = 0
  let spanMs = 0
  let emptyWindows = 0
  let held = 0
  let hasHeld = false

  return {
    get value() {
      return held
    },
    /** True once a window has produced a reading worth printing. */
    get active() {
      return hasHeld
    },
    push(value, dtMs) {
      const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS)
      spanMs += dt
      // Weighted by elapsed time rather than by frame, so a dropped frame does
      // not quietly change what the average means.
      if (value > gate) {
        sum += value * dt
        gatedMs += dt
      }

      if (spanMs >= windowMs) {
        if (gatedMs >= windowMs * minCoverage) {
          held = sum / gatedMs
          hasHeld = true
          emptyWindows = 0
        } else if (++emptyWindows >= clearAfterWindows) {
          held = 0
          hasHeld = false
        }
        sum = 0
        gatedMs = 0
        spanMs = 0
      }
      return held
    },
    reset() {
      sum = 0
      gatedMs = 0
      spanMs = 0
      emptyWindows = 0
      held = 0
      hasHeld = false
      return held
    },
  }
}

/**
 * How often a numeric readout is allowed to change, in ms.
 *
 * A number is read digit by digit, and a digit that changes 60 times a second
 * cannot be read at all — at a tenth of a dB the last place is pure churn even
 * when the value behind it is a 300 ms average. Damping the meter harder would
 * fix the digits by making the graphic sluggish, which is the wrong trade: the
 * bar wants to be immediate and the number wants to be still. So they run at
 * different rates. ~10 Hz is about the fastest a numeral stays legible.
 */
export const READOUT_INTERVAL_MS = 100

/**
 * Gate for a numeric readout: true on the frames the number may change.
 *
 * Carries the remainder rather than resetting to zero, so the interval does
 * not slowly stretch to a multiple of the frame time.
 */
export function createReadoutThrottle({ intervalMs = READOUT_INTERVAL_MS } = {}) {
  let elapsed = intervalMs // first frame publishes, rather than showing a stale zero
  return {
    due(dtMs) {
      elapsed += Math.max(dtMs, 0)
      if (elapsed < intervalMs) return false
      elapsed %= intervalMs
      return true
    },
  }
}

/** Per-frame driver with a real elapsed time, torn down with the component. */
export function useMeterFrame(step) {
  let id = null
  let last = 0

  function tick(now) {
    const dt = now - last
    last = now
    step(dt)
    id = requestAnimationFrame(tick)
  }

  onMounted(() => {
    last = performance.now()
    id = requestAnimationFrame(tick)
  })

  onUnmounted(() => {
    if (id !== null) cancelAnimationFrame(id)
    id = null
  })
}

/**
 * Curvature of the gain-reduction scale: how far it leans from even dB spacing
 * toward the crowding of a moving-coil face.
 *
 * The scale is linear in voltage raised to this power. At 1 it is the law a
 * real movement obeys — deflection linear in voltage — which fixes the problem
 * a linear dB scale has (nearly all gain reduction squeezed into the first
 * eighth of the bar) by overcorrecting: 0 to -10 dB takes 73% of a 24 dB face
 * and everything past -10 is crushed into the last quarter. As it approaches 0
 * the curve straightens back out to even dB spacing. Half way is the useful
 * place to stand — on a 24 dB face:
 *
 *              -3 dB   -8 dB   -10 dB  -20 dB   3-8 dB band
 *   linear       13%     33%      42%     83%     21% of bar
 *   this (0.5)   21%     49%      58%     91%     28% of bar
 *   voltage (1)  31%     64%      73%     96%     33% of bar
 *
 * It keeps most of the resolution where reduction actually lives while leaving
 * the deep end 42% of the bar instead of 27% — enough that a limiting peak
 * still travels visibly rather than pinning against the end.
 */
export const GR_CURVE = 0.5

/**
 * Position of a gain-reduction reading on the scale, 0 at rest to 1 at full
 * scale.
 */
export function grFraction(db, fullScaleDb) {
  const amount = Math.min(Math.abs(db), fullScaleDb)
  const vMin = Math.pow(10, (-GR_CURVE * fullScaleDb) / 20)
  return (1 - Math.pow(10, (-GR_CURVE * amount) / 20)) / (1 - vMin)
}

/**
 * The inverse, so a numeral can state what the fill shows.
 *
 * Lives next to grFraction deliberately: these two have to be exact opposites,
 * and a curve change that updated only one of them would leave the number and
 * the bar quietly disagreeing.
 */
export function grFractionToDb(fraction, fullScaleDb) {
  const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  const vMin = Math.pow(10, (-GR_CURVE * fullScaleDb) / 20)
  const v = 1 - f * (1 - vMin)
  if (v <= 0) return fullScaleDb
  return Math.min((-20 * Math.log10(v)) / GR_CURVE, fullScaleDb)
}

/**
 * Brightness law for an event LAMP, as opposed to a gain-reduction SCALE.
 *
 * WHY THE LAMP DOES NOT USE grFraction, which is what it shipped with. The
 * argument for reusing it was consistency: "half lit here and half way along
 * the bar there mean the same reduction". That argument is wrong about what a
 * lamp is. A bar is read against its own engraved face, so its law has to be
 * the one the engraving assumes; a lamp has no face, is never seen beside a
 * compressor's meter, and answers one question — did it just do something.
 * Consistency with an instrument the user cannot see costs nothing to break.
 *
 * WHAT IT COST TO KEEP was reported from use: the lamp is barely visible
 * unless the stage is driven hard, and shows almost nothing when it is doing
 * the job it exists for. grFraction is a voltage law, near-linear in amplitude
 * at small reductions, and on a 6 dB full scale that puts the readings this
 * stage actually produces at the very bottom of its range: 0.3 dB — the median
 * of the blocks that clip on real narration — lands at 3.9% lit, and 1 dB at
 * 19%. Against the faceplate those are an unlit fixture.
 *
 * The log law expands exactly that region. On the same 6 dB scale:
 *
 *            0.2   0.3   0.5    1     2     3     4    6 dB
 *   voltage  3.9   5.9   9.7   19    37    54    70   100 %
 *   this     18    24    34    50    68    80    88   100 %
 *
 * so an isolated peak taking half a dB is a third lit rather than a tenth, and
 * the 1-to-6 dB span the stage is actually steered over still occupies half
 * the range rather than being crushed into the top.
 *
 * K sets how hard the bottom is expanded. 4 keeps a visible step between 1, 3
 * and 6 dB (50 / 80 / 100%); much above it the top three quarters of the
 * useful range start to flatten into each other.
 */
export const LAMP_CURVE_K = 4

/** Lamp brightness, 0 at rest to 1 at full scale. */
export function lampFraction(db, fullScaleDb) {
  const amount = Math.min(Math.abs(db), fullScaleDb)
  return Math.log(1 + LAMP_CURVE_K * amount) / Math.log(1 + LAMP_CURVE_K * fullScaleDb)
}

/*
 * There is deliberately NO lampFractionToDb.
 *
 * One existed, and the numeral beside the lamp was derived through it from the
 * held brightness. That inverse clamps at full scale — it has to, the forward
 * law does — so the moment full scale dropped below the kernel's own 6 dB
 * bound, the number would have printed the full-scale value for every reading
 * above it while the light was correct. The lamp now holds dB directly and
 * derives brightness from that, which needs no inverse and cannot clamp the
 * number. Reintroducing one would put the hazard back within reach.
 */

/**
 * Engraving vocabulary. Only the round numbers get numerals; the rest are bare
 * ticks, because past 10 dB the curve crowds them together faster than 8px
 * type can be read. Full scale is always numbered, whatever it is.
 */
const TICKS_DB = [0, 1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40]
const LABELLED_DB = new Set([0, 1, 3, 5, 10, 20, 40])

/**
 * Smallest gap between two numerals, as a fraction of the scale. Below this
 * they touch at 8px monospace on a panel-width bar.
 */
const MIN_LABEL_GAP = 0.07

/** Ticks for a scale of the given depth, each with its true position. */
export function grScaleMarks(fullScaleDb) {
  const values = TICKS_DB.filter(db => db < fullScaleDb)
  values.push(fullScaleDb)
  return values.map((db) => {
    const fraction = grFraction(db, fullScaleDb)
    // Full scale is always numbered; a round number that would sit on top of
    // it gives way and stays a bare tick. On a 24 dB face that is -20, which
    // the voltage law puts 4% short of the end.
    const labelled =
      db === fullScaleDb ||
      (LABELLED_DB.has(db) && 1 - fraction >= MIN_LABEL_GAP)
    return {
      db,
      fraction,
      label: labelled ? String(db) : '',
      major: labelled,
    }
  })
}
