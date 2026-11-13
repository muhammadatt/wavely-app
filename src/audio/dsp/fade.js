/**
 * Fades — the DSP behind the Fade panel (Level → Fade).
 *
 * Three operations, each anchored at the selection's edges:
 *
 *   FADE IN   — the first `duration` of the selection rises from silence.
 *   FADE OUT  — the last `duration` of the selection falls to silence.
 *   CROSSFADE — the selection is REMOVED and the audio either side of it is
 *               blended over `duration`: the material that ran on past the
 *               selection's start fades out while the material leading into
 *               its end fades in. The blended join replaces the selection, so
 *               the timeline gets shorter by (selection − duration). Both seams
 *               are continuous by construction — the outgoing side starts AT
 *               the selection's start and the incoming side ends AT its end.
 *
 * Curves, written as the RISING gain g(x) for x in [0, 1] (a fall is g(1 − x)):
 *
 *   linear   g = x
 *   expo     g = (1000^x − 1) / 999 — linear in dB over the last 60 dB, the
 *            natural-sounding decay, then pulled to exactly 0 at the end
 *   s-curve  g = ½ − ½·cos(πx) — a raised cosine, no corner at either end
 *
 * In a crossfade, linear and s-curve are CONSTANT-GAIN pairs (out + in = 1),
 * which is right for the same voice either side of a cut — the two sides are
 * strongly correlated. Two expo curves would sum to a −24 dB hole mid-join, so
 * expo there is the EQUAL-POWER pair (cos / sin, out² + in² = 1): the
 * fast-rising shape the panel's Expo icon draws, and the right law when the
 * two sides are unrelated material (room tone into music, say).
 *
 * Pure functions on Float32Array channels — no Web Audio, so they test in Node.
 */

export const FADE_TYPES = ['in', 'out', 'cross']
export const FADE_CURVES = ['linear', 'expo', 's-curve']

/** The panel's duration slider: 1–100 → 0.05–5 s. */
export const FADE_SLIDER_SECONDS_PER_STEP = 0.05

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

/** [outgoing, incoming] crossfade gains for `curve` at x in [0, 1]. */
export function crossfadeGains(curve, x) {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x
  if (curve === 'expo') {
    return [Math.cos(0.5 * Math.PI * t), Math.sin(0.5 * Math.PI * t)]
  }
  return [fadeGain(curve, 1 - t), fadeGain(curve, t)]
}

/**
 * The fade length actually used for a selection. A fade in / out cannot run
 * past the selection; a crossfade must leave something to remove, so it takes
 * at most half the selection (each side contributes `duration` of audio, and
 * at half the two sides just meet).
 */
export function effectiveFadeSeconds(type, requestedS, selectionS) {
  const cap = type === 'cross' ? selectionS / 2 : selectionS
  return Math.max(0, Math.min(requestedS, cap))
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

/**
 * Blend `outgoing` (fading out) into `incoming` (fading in), channel by
 * channel, over their common length. Returns new arrays; the inputs are left
 * alone. Positions are sample centres, (i + ½) / n, so the curve is symmetric
 * and neither end sample is a pure copy of one side — each seam then steps by
 * at most one sample's worth of the curve.
 */
export function crossfadeChannels(outgoing, incoming, curve) {
  if (outgoing.length !== incoming.length) throw new Error('Crossfade sides must have the same channel count')
  const n = Math.min(outgoing[0]?.length ?? 0, incoming[0]?.length ?? 0)
  const gOut = new Float32Array(n)
  const gIn = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [a, b] = crossfadeGains(curve, (i + 0.5) / n)
    gOut[i] = a
    gIn[i] = b
  }
  return outgoing.map((a, ch) => {
    const b = incoming[ch]
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = a[i] * gOut[i] + b[i] * gIn[i]
    return out
  })
}
