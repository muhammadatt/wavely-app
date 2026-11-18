/**
 * The window's own controls — the header's ON / BYPASS, DELTA and preset
 * browser, the footer's Preview and Apply — as help entries.
 *
 * Every plugin window carries them (FloatingWindow), so they are written once
 * here rather than in each page. The help tour shows the WHOLE window, header
 * and footer included (owner, November 2026: DELTA is how you check the
 * De-Esser, Reso Tame and the Plosive Tamer, and several pages tell the reader
 * to use ON / BYPASS — the faceplate-only picture the marketing pages use hid
 * both). A page gets an entry only for the controls its screenshot shows
 * (`npm run help:shots` records a box for each `data-help` id it finds), and a
 * page's own entry for one of them — its DELTA explained for that effect —
 * wins over the generic text here.
 *
 * Header controls are listed FIRST on the page and footer controls LAST, each in
 * the window's own left-to-right order (the preset browser centred, then DELTA
 * beside ON / BYPASS on the right — develop's header, November 2026; Preview,
 * Apply), so the tour's numbers read across the header, down the faceplate and
 * across the footer.
 */

export const WINDOW_HEADER_GROUP = 'Window header'
export const WINDOW_FOOTER_GROUP = 'Window footer'
/**
 * The heading for a page's leading controls that have no group of their own:
 * right after "Window header" they would otherwise read as part of it.
 */
export const PANEL_GROUP = 'Panel'

export const WINDOW_HEADER = [
  {
    label: 'Presets',
    shot: 'presets',
    text: 'Loads factory presets and ones you have saved, and saves the current settings under a name.',
    details: [
      'The arrows step through the list. Values the effect measures from your file are never stored in a preset; they are measured again on the next file.',
    ],
  },
  {
    label: 'DELTA',
    shot: 'delta',
    text: 'Plays only what the effect is changing: the difference between the processed and the original sound.',
    details: [
      'It is for listening only. Apply always renders the processed audio.',
    ],
    range: 'On, Off',
    default: 'Off',
  },
  {
    label: 'ON / BYPASS',
    shot: 'bypass',
    text: 'Switches the effect in and out of what you hear, so you can compare it with the original.',
    details: [
      'The settings stay where they are while it is bypassed.',
    ],
    range: 'ON, BYPASS',
    default: 'ON',
  },
]

export const WINDOW_FOOTER = [
  {
    label: 'Preview',
    shot: 'preview',
    text: 'Plays the selection through the effect so you can hear it while you adjust the controls.',
    details: [
      'Nothing is written to the file until you Apply.',
    ],
  },
  {
    label: 'Apply',
    shot: 'apply',
    text: 'Renders the effect into the selection with the current settings.',
    details: [
      'It is one step in the undo history, so Undo takes it back.',
    ],
  },
]

const HEADER_SHOTS = new Set(WINDOW_HEADER.map(c => c.shot))
const FOOTER_SHOTS = new Set(WINDOW_FOOTER.map(c => c.shot))

/**
 * A page's controls with the window's around them: header controls first under
 * `WINDOW_HEADER_GROUP`, the page's own in their order, footer controls last
 * under `WINDOW_FOOTER_GROUP`. A window control appears only when the page's
 * screenshot manifest has a box for it; the page's own entry for that shot (its
 * DELTA, say) is used in place of the generic one, moved to its window group.
 */
export function withWindowControls(controls, shots) {
  const own = controls ?? []
  const pictured = shot => !!shots?.controls?.[shot]
  const ownFor = shot => own.find(c => c.shot === shot)
  const pick = (list, group) => list
    .filter(c => pictured(c.shot) || ownFor(c.shot))
    .map(c => ({ ...(ownFor(c.shot) ?? c), group }))
  const header = pick(WINDOW_HEADER, WINDOW_HEADER_GROUP)
  let leading = true
  const middle = own
    .filter(c => !HEADER_SHOTS.has(c.shot) && !FOOTER_SHOTS.has(c.shot))
    .map((c) => {
      if (c.group) leading = false
      return header.length && leading && !c.group ? { ...c, group: PANEL_GROUP } : c
    })
  return [...header, ...middle, ...pick(WINDOW_FOOTER, WINDOW_FOOTER_GROUP)]
}
