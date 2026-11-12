/**
 * Saturation meter — how much a saturator is ADDING, as a needle.
 *
 * The reading is the energy of what the nonlinear stages add (output minus the
 * clean signal, lined up) against the energy of the clean signal, in dB: a
 * running THD+N-style ratio, not a level. The kernel only sums the two
 * energies (PHAT*SS: `PhatassKernel.takeMeter`); everything here is ballistics
 * and scale, so it is pure and tests run it under node.
 *
 * ⚠ THE TWO ENERGIES ARE SMOOTHED SEPARATELY AND THEN DIVIDED. A ratio per
 * block is undefined in silence and swings tens of dB on a consonant, so the
 * needle would chatter; a ratio of averages is the honest "how much, lately".
 * Below `SAT_METER_GATE_DB` of clean power the reading rests at the bottom.
 *
 * THE NEEDLE is a second-order spring (`NeedleSpring`), voiced like a VU
 * movement: ~2 Hz resonance at 0.8 damping reaches a step in ~300 ms with a
 * percent or two of overshoot. The energy smoothing in front of it sets how
 * much it reads lately (`SAT_METER_SMOOTH_MS`); the spring sets how it moves.
 * Both are reasoned from the VU standard, not auditioned.
 *
 * SCALE: 0–100, linear in dB from `SAT_METER_FLOOR_DB` (0) to
 * `SAT_METER_TOP_DB` (100), red from `SAT_METER_RED_DB`. Chosen on PHAT*SS on two
 * narration clips (whole-clip ratio, 23 ms posts p50): TAPE 1 / 3 / 6 alone
 * −33 / −25 / −19 dB (posts −42 / −34 / −28), Warmth 2 / 5 / 10 alone −18 to
 * −21 / −10 to −13 / −4 to −8 (posts reach +2 at Warmth 10). ⚠ WARMTH DOMINATES:
 * its low layers run at +50 dB of drive and reshape the whole low band, so with
 * Warmth up TAPE barely moves the needle (Warmth 5 + TAPE 3 reads as Warmth 5).
 * That is what the plugin is doing; the scale is set so both still show.
 */

export const SAT_METER_FLOOR_DB = -40
export const SAT_METER_TOP_DB = 0
/** Red zone from here: ~0.5 of the signal's energy added. */
export const SAT_METER_RED_DB = -6
/** Below this clean power (dBFS, mean square) the needle rests. */
export const SAT_METER_GATE_DB = -60
/** Time constant of the two energy followers, ms. */
export const SAT_METER_SMOOTH_MS = 150
/** The needle's resonance (Hz) and damping ratio. */
export const NEEDLE_HZ = 2.1
export const NEEDLE_DAMPING = 0.8

/** A dB reading on the 0–100 scale (clamped); −Infinity rests at 0. */
export function satMeterValue(db) {
  if (!Number.isFinite(db)) return 0
  const v = (100 * (db - SAT_METER_FLOOR_DB)) / (SAT_METER_TOP_DB - SAT_METER_FLOOR_DB)
  return v < 0 ? 0 : v > 100 ? 100 : v
}

/** Where the red zone starts on the 0–100 scale. */
export const SAT_METER_RED_VALUE = satMeterValue(SAT_METER_RED_DB)

/**
 * The two energy followers. `push` takes one post's sums (`added`, `clean`,
 * `count` = samples summed) and the frames it spans; `readingDb` is the
 * smoothed ratio, or −Infinity while gated.
 */
export class SaturationMeterFollower {
  constructor(sampleRate, smoothMs = SAT_METER_SMOOTH_MS) {
    this.sampleRate = sampleRate
    this.tau = (smoothMs / 1000) * sampleRate
    this.added = 0
    this.clean = 0
  }

  push({ added, clean, count }, frames) {
    if (!(count > 0) || !(frames > 0)) return
    const k = 1 - Math.exp(-frames / this.tau)
    this.added += k * (added / count - this.added)
    this.clean += k * (clean / count - this.clean)
  }

  reset() {
    this.added = 0
    this.clean = 0
  }

  get readingDb() {
    if (!(this.clean > Math.pow(10, SAT_METER_GATE_DB / 10))) return -Infinity
    return this.added > 0 ? 10 * Math.log10(this.added / this.clean) : -Infinity
  }
}

/**
 * The needle: x'' = ω²(target − x) − 2ζω·x', stepped with semi-implicit Euler
 * in sub-steps of ≤ 4 ms so a dropped animation frame cannot make it unstable.
 */
export class NeedleSpring {
  constructor(hz = NEEDLE_HZ, damping = NEEDLE_DAMPING) {
    this.w = 2 * Math.PI * hz
    this.z = damping
    this.x = 0
    this.v = 0
  }

  /** Advance by `dt` seconds toward `target`; returns the position. */
  step(target, dt) {
    const steps = Math.max(1, Math.ceil(Math.min(dt, 0.25) / 0.004))
    const h = Math.min(dt, 0.25) / steps
    for (let i = 0; i < steps; i++) {
      this.v += h * (this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v)
      this.x += h * this.v
    }
    return this.x
  }
}
