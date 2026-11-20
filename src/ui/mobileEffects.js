/**
 * Which effects the phone's effect-list sheet leads with (the mobile design,
 * decision Q5, November 2026): the edits, the level tools and a few plugins
 * chosen for v1. Everything else a category holds still opens — as its desktop
 * window, scaled to fit as a sheet — but sits behind a "More effects" fold, so
 * the list a phone user meets is the short one the v1 plugins were checked for.
 *
 * Plain data and a pure split, testable without the registry (which imports
 * every panel's .vue file).
 */

/** Registry ids shown first on a phone. Anything else in a category is "more". */
export const MOBILE_V1_OPERATION_IDS = Object.freeze([
  // Edit
  'cut', 'copy', 'paste', 'select-all', 'trim', 'split', 'silence',
  // Level
  'normalize', 'loudness', 'fade', 'volume',
  // Dynamics
  'auto-leveler', 'opto-smooth', 'vox-pressor',
  // Tone
  'manual-eq',
  // Fix
  'noise-reduction', 'de-esser',
])

const V1 = new Set(MOBILE_V1_OPERATION_IDS)

export function isMobileV1(op) {
  return !!op && V1.has(op.id)
}

/**
 * Split a category's grouped operations (registry `groupedOperations`) into
 * the v1 rows — groups kept, in registry order, empty groups dropped — and the
 * rest as one flat list.
 *
 * @param {{ group: string, operations: object[] }[]} groups
 * @returns {{ primary: { group: string, operations: object[] }[], more: object[] }}
 */
export function splitForMobile(groups) {
  const primary = []
  const more = []
  for (const g of groups) {
    const ops = g.operations.filter(isMobileV1)
    if (ops.length) primary.push({ group: g.group, operations: ops })
    more.push(...g.operations.filter(op => !isMobileV1(op)))
  }
  return { primary, more }
}

/**
 * The sheet's target line: what an effect opened from it would act on. A
 * plugin's Apply runs on the selection, so with none the line says so (and
 * the sheet offers Select all beside it).
 *
 * @param {{ start: number, end: number } | null} selection
 * @param {boolean} hasFile
 */
export function targetLine(selection, hasFile) {
  if (!hasFile) return 'No file open'
  if (selection && selection.end > selection.start) {
    return `Selection · ${formatLength(selection.end - selection.start)}`
  }
  return 'Nothing selected'
}

function formatLength(seconds) {
  const s = Math.max(0, seconds || 0)
  if (s < 60) return `${s.toFixed(2)} s`
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
