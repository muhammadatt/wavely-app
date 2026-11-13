/**
 * Fades — the DSP behind the Fade panel (Level → Fade).
 *
 * A fade spans the whole selection: FADE IN rises from silence at the
 * selection's start to full level at its end, FADE OUT falls from full level
 * at its start to silence at its end. The selection IS the fade length.
 *
 * Curves, written as the RISING gain g(x) for x in [0, 1] (a fall is g(1 − x)):
 *
 *   linear   g = x
 *   expo     g = (1000^x − 1) / 999 — linear in dB over the last 60 dB, the
 *            natural-sounding decay, then pulled to exactly 0 at the end
 *   s-curve  g = ½ − ½·cos(πx) — a raised cosine, no corner at either end
 *
 * Pure functions on Float32Array channels — no Web Audio, so they test in Node.
 */

export const FADE_TYPES = ['in', 'out']
export const FADE_CURVES = ['linear', 'expo', 's-curve']

const EXPO_RANGE = 1000 // 60 dB

/** Rising fade gain for `curve` at position x in [0, 1]. */
export function fadeGain(curve, x) {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x
  switch (curve) {
    case 'linear':
      return t
    case 'expo':
      return (Math.pow(EXPO_RANGE, t) - 1) / (EXPO_RANGE - 1)
    case 's-curve':
      return 0.5 - 0.5 * Math.cos(Math.PI * t)
    default:
      throw new Error(`Unknown fade curve: ${curve}`)
  }
}

/**
 * Fade every channel in place over its whole length. 'in': the first sample is
 * silent and the gain approaches 1 at the end, where untouched audio follows.
 * 'out': the gain starts just under 1, continuing untouched audio before it,
 * and the last sample is silent.
 */
export function applyFade(channels, direction, curve) {
  if (direction !== 'in' && direction !== 'out') throw new Error(`Unknown fade direction: ${direction}`)
  const n = channels.length ? channels[0].length : 0
  if (n === 0) return channels
  const gains = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // in:  i / n          → 0 … (n−1)/n
    // out: (n−1−i) / n    → (n−1)/n … 0
    gains[i] = fadeGain(curve, direction === 'in' ? i / n : (n - 1 - i) / n)
  }
  for (const ch of channels) {
    for (let i = 0; i < n; i++) ch[i] *= gains[i]
  }
  return channels
}
