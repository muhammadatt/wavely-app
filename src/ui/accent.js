/**
 * The two colour derivations every accented faceplate makes from its accent.
 *
 * A plugin gets ONE accent prop, and everything it draws is that hue at some
 * exposure: fills at the accent itself, lit strokes and numerals a step
 * brighter, backgrounds and rings a wash of it. Both derivations were written
 * out longhand in several components, which is how ResoTame's plot and its
 * header came to be two copies of the same two functions — and why moving the
 * header out of the plot would otherwise have made a third.
 *
 * Deliberately not a Vue composable: these are pure functions of a hex string,
 * they are called from inside canvas drawing loops as well as from templates,
 * and a component boundary is exactly what they must survive.
 */

/**
 * The lit step above an accent — outlines, numerals, anything meant to read as
 * emitting rather than as filled.
 *
 * `color-mix` rather than an arithmetic blend so it stays a CSS string: the
 * value is handed to both `style` bindings and canvas `fillStyle`, and the
 * browser resolves it the same way in both.
 */
export function bright(hex) {
  return `color-mix(in srgb, ${hex} 55%, #ffffff)`
}

/**
 * The accent at an alpha — fills, rings, glows.
 *
 * Parsed to rgba() rather than `color-mix(… transparent)` because the two are
 * not the same thing: mixing toward transparent is premultiplied, so it also
 * darkens over a light ground. Accepts `#abc` and `#aabbcc`.
 */
export function tint(hex, alpha) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}
