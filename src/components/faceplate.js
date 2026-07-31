/**
 * Ink tokens for the outboard-gear panels.
 *
 * The plugin chrome (frame, knobs, switches, meters) is shared, but the
 * faceplates are not: OptoSmooth is a dark amber unit, FET Punch a brushed
 * silver one. Everything printed on a faceplate — legends, hairlines, switch
 * legends, the accent itself — has to flip with it, so each control asks for
 * its ink here instead of hardcoding white-on-dark.
 *
 * `face` is what the control is sitting on, not what colour it should be:
 * 'dark' for a dark faceplate (the default, unchanged from before), 'light'
 * for a bright one.
 */

/**
 * @param {'dark'|'light'} face  the faceplate the control sits on
 * @param {string} accent        the unit's accent colour
 */
export function faceInk(face, accent) {
  const light = face === 'light'
  return {
    light,
    // Brand mark and anything else set at full strength
    strong: light ? 'rgba(16,22,29,.9)' : '#f6ecdd',
    // Control labels under knobs
    label: light ? 'rgba(16,22,29,.68)' : 'rgba(255,255,255,.55)',
    // Unselected switch legends, secondary readouts
    muted: light ? 'rgba(16,22,29,.55)' : 'rgba(255,255,255,.4)',
    // Captions and units — the quietest tier that still has to be readable
    faint: light ? 'rgba(16,22,29,.44)' : 'rgba(255,255,255,.32)',
    // Control outlines
    line: light ? 'rgba(16,22,29,.22)' : 'rgba(255,255,255,.1)',
    // Panel divisions
    hairline: light ? 'rgba(16,22,29,.13)' : 'rgba(255,255,255,.06)',
    // Recessed fills: close button, unlit chips
    well: light ? 'rgba(16,22,29,.07)' : 'rgba(255,255,255,.06)',
    // A pale accent turns invisible as text on a bright faceplate, so on light
    // it is taken down to a steel blue that holds contrast instead of up
    // toward white.
    accentInk: light
      ? `color-mix(in srgb, ${accent} 45%, #071e30)`
      : `color-mix(in srgb, ${accent} 65%, #ffffff)`,
    // Fill sitting behind accentInk text
    accentWash: light
      ? `color-mix(in srgb, ${accent} 32%, #ffffff)`
      : `color-mix(in srgb, ${accent} 16%, transparent)`,
    accentEdge: light
      ? `color-mix(in srgb, ${accent} 62%, #2c4a63)`
      : `color-mix(in srgb, ${accent} 40%, transparent)`,
    // Lit indicators — LEDs, knob arcs. These read as emissive on a dark face
    // and have to be darkened to stay visible on a bright one.
    accentLit: light ? `color-mix(in srgb, ${accent} 58%, #123a5c)` : accent,
    // Glow only means anything against a dark faceplate
    glow: light ? 'none' : `drop-shadow(0 0 4px ${accent})`,
  }
}
