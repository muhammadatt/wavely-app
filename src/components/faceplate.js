/**
 * Ink tokens for the outboard-gear panels.
 *
 * The plugin chrome (frame, knobs, switches, meters) is shared, but the
 * faceplates are not: OptoSmooth is a black-and-amber unit, FET Punch a
 * machined gunmetal one. Everything printed on a faceplate — legends,
 * seams, switch banks, the accent itself — has to hold against the metal
 * under it, so each control asks for its ink here instead of hardcoding
 * one plate's values.
 *
 * `face` is what the control is sitting on, not what colour it should be:
 * 'dark' for a near-black faceplate (the default, unchanged from before),
 * 'metal' for brushed gunmetal. Legends stay light on both, but metal sits
 * several stops brighter than black, so the same white at 40% that reads as
 * a legend on one reads as fog on the other — every tier is stronger here.
 */

/**
 * @param {'dark'|'metal'} face  the faceplate the control sits on
 * @param {string} accent        the unit's accent colour
 */
export function faceInk(face, accent) {
  const metal = face === 'metal'
  return {
    metal,
    // Brand mark and anything else set at full strength
    strong: metal ? '#eef3f8' : '#f6ecdd',
    // Control labels under knobs
    label: metal ? 'rgba(238,243,248,.84)' : 'rgba(255,255,255,.55)',
    // Unselected switch legends, secondary readouts
    muted: metal ? 'rgba(238,243,248,.62)' : 'rgba(255,255,255,.4)',
    // Captions and units — the quietest tier that still has to be readable
    faint: metal ? 'rgba(238,243,248,.48)' : 'rgba(255,255,255,.32)',
    // Control outlines. Metal is cut, not drawn: the edge is a dark score.
    line: metal ? 'rgba(6,10,15,.6)' : 'rgba(255,255,255,.1)',
    // Recessed fills: close button, unlit chips
    well: metal ? 'rgba(6,10,15,.28)' : 'rgba(255,255,255,.06)',
    // The accent holds its own against gunmetal, so it barely needs lifting
    accentInk: metal
      ? `color-mix(in srgb, ${accent} 82%, #ffffff)`
      : `color-mix(in srgb, ${accent} 65%, #ffffff)`,
    accentWash: metal
      ? `color-mix(in srgb, ${accent} 22%, transparent)`
      : `color-mix(in srgb, ${accent} 16%, transparent)`,
    accentEdge: metal
      ? `color-mix(in srgb, ${accent} 55%, transparent)`
      : `color-mix(in srgb, ${accent} 40%, transparent)`,
    // Lit indicators — LEDs, knob arcs — are emissive against both plates.
    accentLit: accent,
    // Bloom is what a lamp behind black plastic does. The arc on a milled
    // panel is an inlay in the surface: a clean line, no flare.
    glow: metal ? 'none' : `drop-shadow(0 0 4px ${accent})`,
  }
}

/**
 * A panel seam. On metal it is a machined groove — a dark cut with the light
 * catching its lower lip — where on a black plate it was only ever a faint
 * hairline.
 *
 * @param {'dark'|'metal'} face
 * @param {'top'|'bottom'} side  which edge of the element carries the seam
 */
export function seam(face, side = 'top') {
  const metal = face === 'metal'
  const edge = side === 'top' ? 'borderTop' : 'borderBottom'
  if (!metal) return { [edge]: '1px solid rgba(255,255,255,.06)' }
  return {
    [edge]: '1px solid rgba(6,10,15,.6)',
    boxShadow: side === 'top' ? '0 1px 0 rgba(255,255,255,.06)' : '0 1px 0 rgba(255,255,255,.06)',
  }
}
