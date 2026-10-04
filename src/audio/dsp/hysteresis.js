/**
 * Tape HYSTERESIS — a Jiles-Atherton magnetisation model, the stateful curve
 * the Saturation Bench offers as `hysteresis`.
 *
 * The other curves are memoryless: y = f(x). This one is not — the output is
 * the magnetisation M, and how M responds to the field H depends on where it
 * has been (the B-H loop). Written from the published equations (Jiles &
 * Atherton 1986; the real-time form of Chowdhury, DAFx 2019), not from any
 * plugin's code.
 *
 * NORMALISED UNITS: h = H/a, m = M/Ms, so the anhysteretic curve is the
 * Langevin function L(h + A·m) and the model has three dimensionless shape
 * constants:
 *
 *   dm/dh = [ (1−c)·κ·(man − m) / ((1−c)·δ·K − A·(man − m)) + c·man' ] / (1 − c·A·man')
 *
 *   man = L(h + A·m)   man' = L'(h + A·m)   δ = sign(dh)   κ = [ (man − m)·δ ≥ 0 ]
 *
 * It is rate-independent (only the SIGN of dh enters), so it is integrated in
 * h rather than in time: one RK2 step per oversampled sample, over that
 * sample's dh. The time step only sets the accuracy.
 *
 * ⚠ THE TEXTBOOK TAPE CONSTANTS EXPAND, AND THAT IS WHY THESE ARE NOT THEM.
 * With Chowdhury's values (c 0.17, k/a 1.23) the fundamental's gain RISES with
 * level, +9.9 dB at four times the small-signal point before saturation bends
 * it back — the S-shaped initial curve of unbiased tape, the low-level
 * distortion that AC bias exists to remove. On voice that pushes the loud
 * syllables UP, the opposite of the softening this is for. The reversible
 * fraction c stands in for the bias: raising it linearises the low end, at the
 * cost of loop width. Swept c × K × A for the widest loop (largest phase lag
 * of the fundamental, the loop's audible signature) whose gain NEVER rises
 * more than 0.25 dB above its small-signal value at any level:
 *
 *   c 0.6, K 5     +0.03 dB at most, then compressive; loop lag up to 7.0°
 *   c 0.6, K 2.5   +0.17 dB, 7.6°
 *   c 0.7, K 5     +0.01 dB, 5.0°
 *   c 0.8 (K 1.23) flat to +0.1 dB, 3.3°
 *   c 0.17 (tape)  +9.9 dB — rejected
 *
 * A barely matters (it is `alpha·Ms/a`, 0.025 on the paper's values); K is the
 * pinning, the loop's half-width in units of a.
 *
 * ⚠⚠ THEN SPEECH BIASES ITSELF, AND THAT MOVED c FROM 0.6 TO 0.8. The sweep
 * above is on a single sine. Small fast reversals riding on a slow signal pull
 * J-A's magnetisation toward the ANHYSTERETIC curve — exactly what AC bias does
 * on real tape — whose slope (1/3) is steeper than the settled loop's, so the
 * slow component's gain RISES: a 120 Hz tone with a 3 kHz ripple at a fifth of
 * its level gains +0.54 dB at c 0.6. A voice is full of such reversals
 * (harmonics, formant ringing). Full band on real narration (Southern Sunrise,
 * drive +6) at c 0.6 the 20–250 Hz band went UP +1.50 dB and the whole file
 * +0.99 dB rms — an expander again, driven by the material's own top end. The
 * gap closes as c rises (the loop and the anhysteretic curve converge):
 *
 *   c      loop lag at 2×   20–250 Hz, full band +6 / +12   onset crest +12
 *   0.6    3.1°             +1.50 / +1.83                    −2.78
 *   0.8    1.2°             +0.34 / +0.12                    −2.56
 *   0.9    0.5°             −0.01 / −0.45                    −2.46
 *
 * 0.8 is the widest loop whose self-bias stays under ~0.3 dB at sensible drive.
 *
 * ⚠⚠ AND AT THAT VOICING IT MEASURES AS A tanh. The same file through a
 * memoryless tanh, full band +12: peak −6.87, onset crest −2.59, loud-vs-quiet
 * compression 0.89 dB; hysteresis c 0.8: −4.88 / −2.56 / 0.63 (onset crest is
 * the first 20 ms's peak against the 40–150 ms level, change vs dry, averaged
 * over 16 onsets). The transient
 * softening and compression are the SATURATION, not the memory — a loop wide
 * enough to change that also expands. What is left for the loop to contribute
 * is the 1.2° lag and how the curve bends through reversals; whether that is
 * audible is an ear question (`scripts/hysteresis-bands.mjs` renders it beside
 * tanh), at ~3× tanh's cost.
 *
 * ⚠⚠ ITS LOW-LEVEL DISTORTION DOES NOT GO AWAY, and that is the clearest
 * thing the loop adds. A polynomial curve's residual falls ~3 dB per dB of
 * level; J-A's irreversible term switches at every reversal whatever the
 * amplitude, so its residual falls ~1 dB per dB. Real narration, full band,
 * drive +12, residual after the best gain, re the signal:
 *
 *   level      tanh       hysteresis c 0.8    c 0.95
 *    0 dB      −21.7      −17.8               −21.7
 *   −20 dB     −57.2      −30.7               −44.3
 *   −40 dB     −86.7      −49.2               −63.2
 *
 * So soft syllables carry ~3 % of residual where a tanh carries 0.1 % — the
 * grain of unbiased tape, which real bias removes. On white or pink noise
 * (a reversal nearly every sample) it is level-INDEPENDENT, about −21 dB.
 *
 * ⚠ RESPONSE IS NORMALISED TO UNITY AT LOW LEVEL, not to f'(0) = 1. Starting
 * demagnetised the slope at the origin is only the reversible part (≈ c/3);
 * what a quiet signal sees in steady state includes the irreversible part
 * too. `hysteresisSmallGain()` is that steady-state gain at the fundamental,
 * measured on a sine at h = 0.01, and the output is divided by it — so a quiet
 * sine passes at unity magnitude (with a fraction of a degree of lag), as the
 * memoryless curves promise. Broadband material passes at unity GAIN to within
 * a few tenths of a dB, not as an unchanged waveform — see above.
 */

export const HYSTERESIS_C = 0.8
export const HYSTERESIS_K = 5
export const HYSTERESIS_A = 0.025

/**
 * The shape new states are built with. Module STATE, not a constant, so the
 * measurement scripts can sweep it; the app never changes it. Changing it
 * re-measures the small-signal gain and bumps `hysteresisShapeVersion`, which
 * the drive calibration keys its cache on.
 */
const shape = { c: HYSTERESIS_C, K: HYSTERESIS_K, A: HYSTERESIS_A }
let smallGain = null
let version = 0

export function setHysteresisShape(p = {}) {
  for (const k of ['c', 'K', 'A']) if (Number.isFinite(p[k])) shape[k] = p[k]
  smallGain = null
  version++
}

export function hysteresisShape() {
  return { ...shape }
}

export function hysteresisShapeVersion() {
  return version
}

function langevin(q) {
  if (Math.abs(q) < 1e-3) return q / 3 - (q * q * q) / 45
  return 1 / Math.tanh(q) - 1 / q
}

function langevinSlope(q) {
  if (Math.abs(q) < 1e-3) return 1 / 3 - (q * q) / 15
  const s = Math.sinh(q)
  return 1 / (q * q) - 1 / (s * s)
}

/** One magnetisation state: feed it h, get m. */
export class JilesAtherton {
  constructor({ c = shape.c, K = shape.K, A = shape.A, scale = 1 } = {}) {
    this.c = c
    this.K = K
    this.A = A
    this.scale = scale
    this.m = 0
    this.h = 0
  }

  reset() {
    this.m = 0
    this.h = 0
  }

  _dmdh(m, h, d) {
    const c = this.c
    const A = this.A
    const q = h + A * m
    const man = langevin(q)
    const dman = langevinSlope(q)
    const dm = man - m
    const irr = dm * d >= 0 ? ((1 - c) * dm) / ((1 - c) * d * this.K - A * dm) : 0
    return (irr + c * dman) / (1 - c * A * dman)
  }

  /** Advance to field `h`; returns the normalised output. */
  step(h) {
    const dh = h - this.h
    if (dh !== 0) {
      const d = dh > 0 ? 1 : -1
      const k1 = dh * this._dmdh(this.m, this.h, d)
      let m = this.m + dh * this._dmdh(this.m + k1 / 2, this.h + dh / 2, d)
      // Saturation bound; also keeps a pathological step from running away.
      if (!(m <= 1)) m = m > 1 ? 1 : 0
      else if (m < -1) m = -1
      this.m = m
      this.h = h
    }
    return this.m * this.scale
  }
}

/** Fundamental gain, THD (2–15) and lag (degrees) on a steady sine of amplitude `h`. */
export function hysteresisSineResponse(h, { samples = 512, cycles = 4, scale = 1 } = {}) {
  const ja = new JilesAtherton({ scale })
  const y = new Float64Array(samples)
  for (let cy = 0; cy < cycles; cy++) {
    for (let i = 0; i < samples; i++) {
      const v = ja.step(h * Math.sin((2 * Math.PI * i) / samples))
      if (cy === cycles - 1) y[i] = v
    }
  }
  let fund = 0
  let rest = 0
  let phase = 0
  for (let k = 1; k <= 15; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < samples; i++) {
      const a = (2 * Math.PI * k * i) / samples
      re += y[i] * Math.cos(a)
      im += y[i] * Math.sin(a)
    }
    const p = re * re + im * im
    if (k === 1) {
      fund = p
      phase = Math.atan2(re, im)
    } else rest += p
  }
  return {
    gain: (2 * Math.sqrt(fund)) / samples / h,
    thd: Math.sqrt(rest / fund),
    lagDeg: (-phase * 180) / Math.PI,
  }
}

/** Steady-state small-signal gain at the fundamental, for the current shape; the output is divided by it. */
export function hysteresisSmallGain() {
  if (smallGain === null) smallGain = hysteresisSineResponse(0.01).gain
  return smallGain
}
