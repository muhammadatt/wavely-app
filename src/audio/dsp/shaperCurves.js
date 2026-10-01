/**
 * Waveshaper curves for the HF Softener's input stage, for auditioning.
 *
 * Every curve is normalised to f(0) = 0 and f'(0) = 1, and the kernel runs it
 * as f(g·x)/g, so a quiet signal passes at unity whatever the curve or drive:
 * the curves differ only in what they do to the loud part.
 *
 * ⚠ THEY ARE MATCHED ON DISTORTION, NOT ON DRIVE. The same pre-gain puts
 * very different amounts of distortion into different curves — at u = 0.5 the
 * quartic makes 0.2 % and tanh 2 % — so comparing them at one gain mostly
 * compares how hard each was pushed, and the gentler-sounding curve is simply
 * the one doing less. `unitDriveU` finds, per curve, the input amplitude at
 * which a sine comes out at `SHAPER_REF_THD` total harmonic distortion, and
 * the Drive knob's midpoint lands every curve there. Across the rest of the
 * knob they separate again, at each curve's own rate: odd curves' THD rises
 * ~2 dB per dB of drive, the quartic's H2 ~3.
 *
 * ⚠ A SINE IS THE CALIBRATION, NOT THE MATERIAL. Speech is many partials at
 * once, and every curve's low-level term (cubic for the odd curves) produces
 * intermodulation on it that a single tone does not show. Matching on a sine
 * matches the order of magnitude; the ear does the rest.
 *
 * Pure, no worklet registration, importable from any kernel.
 */

import { makeQuarticSatCurve } from './quarticSatCurve.js'

const quartic = makeQuarticSatCurve({ drive: 1 })

/** Bias of the asymmetric curve, in u: sets its even-to-odd balance. */
const ASYM_BIAS = 0.25
const ASYM_TANH_B = Math.tanh(ASYM_BIAS)
const ASYM_SLOPE_B = 1 - ASYM_TANH_B * ASYM_TANH_B

/**
 * The curves, in dial order. `label` is the dial readout; `title` says what
 * each one is for, in the terms the audition is about.
 */
export const SHAPER_CURVES = [
  {
    id: 'quartic',
    label: 'QUARTIC',
    title: 'OptoSmooth’s output-stage curve: second harmonic, almost no odd — warmth without edge',
    f: u => quartic.transferAt(u, 1),
  },
  {
    id: 'asym',
    label: 'ASYM',
    title: 'Biased tanh: even and odd together, the classic tube-ish lean',
    f: u => (Math.tanh(u + ASYM_BIAS) - ASYM_TANH_B) / ASYM_SLOPE_B,
  },
  {
    id: 'atan',
    label: 'ATAN',
    title: 'Arctangent: odd only, flattens slowly — the softest of the symmetric curves when pushed',
    f: u => Math.atan(u),
  },
  {
    id: 'algebraic',
    label: 'ALGEBRAIC',
    title: 'x/√(1+x²): odd only, bends early and gently',
    f: u => u / Math.sqrt(1 + u * u),
  },
  {
    id: 'tanh',
    label: 'TANH',
    title: 'Hyperbolic tangent: odd only, the tape/tube reference — the most bite when pushed',
    f: u => Math.tanh(u),
  },
  {
    id: 'cubic',
    label: 'CUBIC',
    title: 'x − x³/3, flat past ±1: pure third harmonic until it hits the flat, then everything',
    f: u => (u >= 1 ? 2 / 3 : u <= -1 ? -2 / 3 : u - (u * u * u) / 3),
  },
]

export const SHAPER_CURVE_IDS = SHAPER_CURVES.map(c => c.id)
export const DEFAULT_SHAPER_CURVE = 'quartic'

export function shaperCurve(id) {
  return SHAPER_CURVES.find(c => c.id === id) ?? SHAPER_CURVES[0]
}

/** Total harmonic distortion the Drive knob's midpoint gives every curve. */
export const SHAPER_REF_THD = 0.01

/**
 * THD of `f` on a sine of amplitude `u`: harmonics 2–40 against the
 * fundamental, by DFT over one exactly-sampled cycle.
 */
export function sineThd(f, u, samples = 512, maxHarmonic = 40) {
  const y = new Float64Array(samples)
  for (let i = 0; i < samples; i++) y[i] = f(u * Math.sin((2 * Math.PI * i) / samples))
  let fund = 0
  let rest = 0
  for (let k = 1; k <= maxHarmonic; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < samples; i++) {
      const a = (2 * Math.PI * k * i) / samples
      re += y[i] * Math.cos(a)
      im += y[i] * Math.sin(a)
    }
    const p = re * re + im * im
    if (k === 1) fund = p
    else rest += p
  }
  return Math.sqrt(rest / fund)
}

const unitCache = new Map()

/**
 * The sine amplitude, in u, at which `id` produces `SHAPER_REF_THD`. Found by
 * bisection in log-amplitude — every curve here has THD rising with level —
 * and memoised, so a worklet pays for it once.
 */
export function unitDriveU(id) {
  if (unitCache.has(id)) return unitCache.get(id)
  const { f } = shaperCurve(id)
  let lo = Math.log(1e-3)
  let hi = Math.log(20)
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (sineThd(f, Math.exp(mid), 256, 24) < SHAPER_REF_THD) lo = mid
    else hi = mid
  }
  const u = Math.exp((lo + hi) / 2)
  unitCache.set(id, u)
  return u
}
