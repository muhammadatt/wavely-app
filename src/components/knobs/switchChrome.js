/**
 * Chrome shared by the switch family — the lamp, the rocker body, and the ink
 * that goes on a lit cap.
 *
 * These live here rather than in each component because the rocker (`I`/`O`,
 * on and off) and the choice rocker (two named modes) are deliberately the same
 * physical object with different engraving. If their housings drift apart they
 * stop reading as one control family, and that is a difference nobody notices
 * in review and everybody notices on a faceplate.
 *
 * Every function takes the panel's `accent` rather than reading a token: each
 * plugin passes its own hue (`--plugin-opto`, `--plugin-fet`, …) as a prop, and
 * that is the established contract across the knob components.
 */

/** Unlit lamp body. Matches `--meter-lamp-off` in the design system. */
const LAMP_OFF = '#262c37'

/**
 * A panel lamp.
 *
 * Lit, it is the accent with a glow; unlit it is a dark bead with a hairline,
 * NOT the accent at low opacity — an unlit lamp has to read as a different
 * object from a dim one, or a disabled control looks merely quiet.
 */
export function lampStyle(on, accent, size = 6) {
  return {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '999px',
    flex: '0 0 auto',
    background: on ? accent : LAMP_OFF,
    boxShadow: on ? `0 0 6px ${accent}` : 'inset 0 0 0 1px rgba(255,255,255,.06)',
    transition: 'background-color .15s ease, box-shadow .15s ease',
  }
}

/**
 * The rocker housing: a recessed slot the cap travels in.
 *
 * Width is the caller's — 46 px for the two-state rocker, 92 px for the choice
 * rocker — because the cap has to cover half the body in each and the labels
 * differ. Everything else is fixed so the two read as the same moulding.
 */
export const ROCKER_BODY = {
  position: 'relative',
  height: '24px',
  padding: '0',
  border: '1px solid rgba(255,255,255,.1)',
  borderRadius: '8px',
  background: 'linear-gradient(180deg,#0a0c0f,#12161b)',
  boxShadow: 'inset 0 2px 6px rgba(0,0,0,.7)',
}

/**
 * A lit cap: the accent, brightened at the top so it reads as a moulded object
 * catching light rather than a flat fill.
 */
export function litCap(accent, brighten = 82) {
  return {
    background: `linear-gradient(180deg, color-mix(in srgb, ${accent} ${brighten}%, #ffffff), ${accent})`,
    boxShadow: `0 0 8px color-mix(in srgb, ${accent} 45%, transparent), inset 0 1px 0 rgba(255,255,255,.4)`,
  }
}

/** An unlit cap — dark plastic, no glow. */
export const DARK_CAP = {
  background: 'linear-gradient(180deg,#2a3038,#171b21)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12), 0 2px 4px rgba(0,0,0,.5)',
}

/**
 * Text sitting ON a lit cap.
 *
 * The design draws this as `#1a1204`, which is amber-tinted near-black and
 * therefore only right for the one accent it was drawn against. Mixing the
 * panel's own accent into near-black generalises it — the same relationship the
 * design system encodes as `--color-accent-ink` for its cyan.
 */
export function capInk(accent) {
  return `color-mix(in srgb, ${accent} 18%, #05070a)`
}

/** Text for the selected position of an unlit control. */
export function litText(accent) {
  return `color-mix(in srgb, ${accent} 70%, #ffffff)`
}

/** Text for an unselected position. */
export const DIM_TEXT = 'rgba(255,255,255,.35)'
