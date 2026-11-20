/**
 * The touch selection's magnifier: while a finger drags a selection or one of
 * its edges, a round loupe above the finger shows the audio around the edge at
 * a much finer zoom, so the edge can be put on a gap or a transient the finger
 * itself covers. The numbers and geometry live here, testable without a canvas.
 */

/** The loupe's diameter, CSS px. */
export const LOUPE_SIZE_PX = 112

/** How much finer than the waveform the loupe draws. */
export const LOUPE_ZOOM = 8

/**
 * The loupe's zoom never drops below this (px per second): zoomed out over a
 * long file, 8× the view is still minutes per loupe, which places nothing —
 * and rendering it per finger move would cost millions of samples. At 400 the
 * loupe spans ~0.28 s.
 */
export const LOUPE_MIN_PPS = 400

/** …nor rises past this: ~3 samples per pixel at 48 kHz. */
export const LOUPE_MAX_PPS = 16000

/** Gap between the finger and the loupe's bottom edge, px. */
export const LOUPE_GAP_PX = 36

/** The loupe's zoom for a waveform drawn at `pps` px per second. */
export function loupePps(pps) {
  return Math.min(LOUPE_MAX_PPS, Math.max(LOUPE_MIN_PPS, pps * LOUPE_ZOOM))
}

/** The span of timeline the loupe shows, centred on `time`. */
export function loupeWindow(time, pps, size = LOUPE_SIZE_PX) {
  const half = size / loupePps(pps) / 2
  return { start: time - half, end: time + half }
}

/**
 * Min / max of `samples` in each of `columns` equal slices, interleaved
 * `[min0, max0, min1, max1, …]`. An empty slice reads as silence.
 */
export function loupeColumns(samples, columns) {
  const out = new Float32Array(columns * 2)
  const n = samples.length
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * n) / columns)
    const to = Math.max(from + 1, Math.floor(((c + 1) * n) / columns))
    let lo = Infinity
    let hi = -Infinity
    for (let i = from; i < to && i < n; i++) {
      const v = samples[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    out[c * 2] = Number.isFinite(lo) ? lo : 0
    out[c * 2 + 1] = Number.isFinite(hi) ? hi : 0
  }
  return out
}

/**
 * Where the loupe goes in the waveform box, given the finger at (`x`, `y`):
 * centred above it; beside it when there is no room above (a short box, a
 * finger near the top), on whichever side has more room; always inside the box
 * as far as it fits.
 *
 * @returns {{ left: number, top: number }} the loupe's top-left corner, px in the box
 */
export function loupePosition({ x, y, boxW, boxH, size = LOUPE_SIZE_PX, gap = LOUPE_GAP_PX }) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const above = y - gap - size
  if (above >= 0) {
    return { left: clamp(x - size / 2, 0, Math.max(0, boxW - size)), top: above }
  }
  const right = x + gap
  const left = x - gap - size
  const roomRight = boxW - (x + gap)
  const roomLeft = x - gap
  const besideLeft = roomRight >= size || roomRight >= roomLeft
    ? clamp(right, 0, Math.max(0, boxW - size))
    : clamp(left, 0, Math.max(0, boxW - size))
  return { left: besideLeft, top: clamp(y - size / 2, 0, Math.max(0, boxH - size)) }
}

/**
 * Vertical gain for the loupe: the loudest point in view fills ~90 % of its
 * half-height, up to LOUPE_MAX_GAIN (~+22 dB). Edges are placed in the quiet
 * gaps between sounds, which drawn true-to-level read as a flat line.
 */
export const LOUPE_MAX_GAIN = 12

export function loupeGain(columns) {
  let peak = 0
  for (const v of columns) peak = Math.max(peak, Math.abs(v))
  if (!(peak > 0)) return 1
  return Math.max(1, Math.min(LOUPE_MAX_GAIN, 0.9 / peak))
}
