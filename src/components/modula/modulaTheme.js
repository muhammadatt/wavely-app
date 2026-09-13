/**
 * The Modula faceplate's colour recipe, from `Compressor.dc.html` in the
 * Plugin UI Kit design project.
 *
 * Two hues per plugin. ACCENT goes on the controls that set how hard the unit
 * works (drive, ballistics, output); SECOND on the ones that set what it works
 * on (ratio, curve, mix). Everything else on the face is the fixed graphite
 * palette baked into the components' own styles.
 *
 * `glow` and `deep` are the two derived tones the design uses everywhere — the
 * box-shadow halo and the dark end of a fill gradient — kept as functions so a
 * plugin picking its own hues gets matching derivatives for free.
 */
export const MODULA_ACCENT = '#ff8b3d'
export const MODULA_SECOND = '#6fd6ff'

/** Halo colour for box-shadows and text-shadows. */
export const glow = (c) => `color-mix(in oklab, ${c} 65%, transparent)`

/** Dark end of a fill gradient, sunk toward the faceplate. */
export const deep = (c) => `color-mix(in oklab, ${c} 52%, #1b1d21)`

/** Unlit LED / segment. */
export const OFF_LED = '#3a3d43'
export const OFF_SEG = '#272b30'
export const OFF_LED_SHADOW = 'inset 0 1px 1px rgba(0,0,0,.7)'
