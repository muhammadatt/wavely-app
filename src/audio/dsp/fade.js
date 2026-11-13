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
 * and the last sample is silent. The gain is computed per sample inside the
 * loop: a gain table would cost another n floats on an hour-long selection.
 */
export function applyFade(channels, direction, curve) {
  if (!FADE_TYPES.includes(direction)) throw new Error(`Unknown fade direction: ${direction}`)
  const n = channels.length ? channels[0].length : 0
  for (let i = 0; i < n; i++) {
    // in:  i / n          → 0 … (n−1)/n
    // out: (n−1−i) / n    → (n−1)/n … 0
    const g = fadeGain(curve, direction === 'in' ? i / n : (n - 1 - i) / n)
    for (const ch of channels) ch[i] *= g
  }
  return channels
}

/**
 * The samples of a region render that a timeline render will play back.
 * renderRegionToBuffer sizes a region at ceil(seconds · rate) but copies a
 * segment's floor(seconds · rate), so on a selection that does not land on a
 * whole sample the last rendered sample is never played.
 */
export function playedSampleCount(seconds, sampleRate) {
  return Math.floor(seconds * sampleRate + 1e-9)
}

/**
 * Fade a rendered region in place so the fade lands on the samples that play:
 * the fade runs over the first `played` samples, and for a fade out anything
 * rendered past them is silenced, so the fade out ends at 0 however the region
 * is sized. Throws when there is nothing to fade.
 */
export function fadeRegionChannels(channels, direction, curve, played) {
  const length = channels.length ? channels[0].length : 0
  const m = Math.min(played, length)
  if (m < 1) throw new Error('The selection is too short to fade')
  applyFade(channels.map((c) => c.subarray(0, m)), direction, curve)
  if (direction === 'out') for (const c of channels) c.fill(0, m)
  return channels
}

/**
 * An SVG path of the fade's gain curve for the panel's icons, drawn from
 * fadeGain itself so the picture is the curve the audio gets. The box runs
 * x0 → x1 left to right and yBottom (silence) → yTop (full level); 'out' is
 * the 'in' curve mirrored, as applyFade renders it.
 */
export function fadeCurvePath(curve, direction, { x0 = 2, x1 = 46, yTop = 2, yBottom = 22, points = 32 } = {}) {
  const parts = []
  for (let i = 0; i <= points; i++) {
    const t = i / points
    const g = fadeGain(curve, direction === 'out' ? 1 - t : t)
    const x = x0 + (x1 - x0) * t
    const y = yBottom - (yBottom - yTop) * g
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  return parts.join(' ')
}
