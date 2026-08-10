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
 * Position of a gain-reduction reading on the scale, 0 at rest to 1 at full
 * scale.
 *
 * Deflection is linear in voltage, not in dB — the law a moving-coil meter
 * obeys because that is what the movement does, and the reason a hardware GR
 * scale gives most of its face to the first few dB. On a 24 dB scale it puts
 * 0 to -10 dB across roughly the first 70% of the travel, so the 3-8 dB range
 * that nearly all real gain reduction lives in is spread over a third of the
 * meter instead of an eighth.
 */
export function grFraction(db, fullScaleDb) {
  const amount = Math.min(Math.abs(db), fullScaleDb)
  const vMin = Math.pow(10, -fullScaleDb / 20)
  return (1 - Math.pow(10, -amount / 20)) / (1 - vMin)
}

/**
 * Engraving vocabulary. Only the round numbers get numerals; the rest are bare
 * ticks, because past 10 dB the voltage law crowds them together faster than
 * 8px type can be read. Full scale is always numbered, whatever it is.
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
