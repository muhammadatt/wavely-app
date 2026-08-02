import TrimPanel from '../components/panels/TrimPanel.vue'
import SilencePanel from '../components/panels/SilencePanel.vue'
import FadePanel from '../components/panels/FadePanel.vue'
import VolumePanel from '../components/panels/VolumePanel.vue'
import SplitPanel from '../components/panels/SplitPanel.vue'
import PresetsPanel from '../components/panels/PresetsPanel.vue'

import LA2AModal from '../components/panels/LA2AModal.vue'
import FET1176Modal from '../components/panels/FET1176Modal.vue'
import NormalizeWindow from '../components/panels/windows/NormalizeWindow.vue'
import VocalSaturationWindow from '../components/panels/windows/VocalSaturationWindow.vue'
import NoiseReductionWindow from '../components/panels/windows/NoiseReductionWindow.vue'
import RemoveSilenceWindow from '../components/panels/windows/RemoveSilenceWindow.vue'

/**
 * The operation registry — the single source of truth for what this app can do.
 *
 * The toolbar, the rail's category lists, the command palette and (later) the
 * waveform context menu all render from these two arrays. Adding an operation
 * is an entry here and a component; nothing else in the app needs to know.
 *
 * Previously this knowledge was split across FloatingToolbar's `tools` array,
 * ContextPanel's v-if chain, EditPanel's `subTools`, EffectsPanel's accordion
 * markup and a boolean per plugin on the global state — five places that had to
 * agree, and regularly didn't.
 */

/**
 * Top-level categories, in toolbar order.
 *
 * `panel` is a bespoke rail component for categories that aren't just a list of
 * operations. Where it's null the rail renders OperationList over this
 * category's OPERATIONS instead — which is what replaced the old EditPanel and
 * EffectsPanel, both of which were hand-maintained versions of that list.
 *
 * Bespoke panels must not import this module: it imports them, and a cycle
 * would leave these bindings undefined while the array below is built.
 */
export const CATEGORIES = [
  {
    id: 'split',
    label: 'Split',
    icon: 'split',
    desc: 'Cut the file into separate pieces',
    panel: SplitPanel,
  },
  {
    id: 'edit',
    label: 'Edit',
    icon: 'edit',
    desc: 'Shape and clean up the content',
    panel: null,
  },
  {
    id: 'effects',
    label: 'Effects',
    icon: 'effects',
    desc: 'Apply to selection or full track',
    panel: null,
  },
  {
    id: 'presets',
    label: 'Presets',
    icon: 'presets',
    desc: 'One-click mastering chains',
    panel: PresetsPanel,
  },
]

/**
 * Every individual operation.
 *
 *   category  which top-level list it appears in
 *   group     section heading within that list
 *   requires  'selection' | 'file' | null — gates the row and the palette entry
 *   surface   'rail'      opens as a detail view inside the rail
 *             'window'    opens as a floating window
 *             'immediate' runs on click, no parameters (reserved for verbs
 *                         like Cut/Copy that the palette should fire directly)
 *
 * Surface is fixed per category, not per operation: everything under Edit opens
 * in the rail, everything under Effects opens as a window. Two adjacent rows in
 * one list never behave differently — that inconsistency is what this replaces.
 */
export const OPERATIONS = [
  // ---- Edit (rail) ----
  {
    id: 'trim',
    label: 'Trim',
    desc: 'Remove audio outside or inside your selection',
    category: 'edit',
    group: 'Selection',
    icon: 'trim',
    keywords: ['crop', 'cut', 'keep', 'remove', 'outside', 'inside'],
    requires: 'selection',
    surface: 'rail',
    component: TrimPanel,
  },
  {
    id: 'silence',
    label: 'Silence',
    desc: 'Replace the selected region with silence',
    category: 'edit',
    group: 'Selection',
    icon: 'silence',
    keywords: ['mute', 'blank', 'quiet', 'erase'],
    requires: 'selection',
    surface: 'rail',
    component: SilencePanel,
  },
  {
    id: 'fade',
    label: 'Fade',
    desc: 'Shape the volume curve at the selection edges',
    category: 'edit',
    group: 'Level',
    icon: 'fade',
    keywords: ['fade in', 'fade out', 'ramp', 'curve', 'taper'],
    requires: 'selection',
    surface: 'rail',
    component: FadePanel,
  },
  {
    id: 'volume',
    label: 'Volume',
    desc: 'Adjust the volume of the selected region',
    category: 'edit',
    group: 'Level',
    icon: 'volume',
    keywords: ['gain', 'louder', 'quieter', 'amplify', 'db'],
    requires: 'selection',
    surface: 'rail',
    component: VolumePanel,
  },

  // ---- Effects (windows) ----
  {
    id: 'normalize',
    label: 'Normalize',
    desc: 'Peak normalize',
    category: 'effects',
    group: 'Dynamics',
    icon: 'normalize',
    keywords: ['peak', 'level', 'loudness', 'maximize', 'gain'],
    requires: 'selection',
    surface: 'window',
    component: NormalizeWindow,
  },
  {
    id: 'opto-smooth',
    label: 'Opto Smooth',
    desc: 'Subtle, transparent leveler',
    category: 'effects',
    group: 'Dynamics',
    icon: 'opto',
    keywords: ['la-2a', 'la2a', 'compressor', 'opto', 'tube', 'leveler', 'smooth'],
    requires: 'selection',
    surface: 'window',
    component: LA2AModal,
  },
  {
    id: 'fet-punch',
    label: 'FET Punch',
    desc: 'Compressor/limiter',
    category: 'effects',
    group: 'Dynamics',
    icon: 'fet',
    keywords: ['1176', 'compressor', 'fet', 'punch', 'aggressive', 'fast'],
    requires: 'selection',
    surface: 'window',
    component: FET1176Modal,
  },
  {
    id: 'vocal-saturation',
    label: 'Vocal Saturation',
    desc: 'Parallel tube-style warmth',
    category: 'effects',
    group: 'Tone',
    icon: 'saturation',
    keywords: ['tube', 'warmth', 'harmonic', 'drive', 'distortion', 'analog'],
    requires: 'selection',
    surface: 'window',
    component: VocalSaturationWindow,
  },
  {
    id: 'noise-reduction',
    label: 'Noise Reduction',
    desc: 'Remove background noise',
    category: 'effects',
    group: 'Clean',
    icon: 'noise',
    keywords: ['denoise', 'hiss', 'hum', 'background', 'deepfilternet', 'clean'],
    requires: 'selection',
    surface: 'window',
    component: NoiseReductionWindow,
  },
  {
    id: 'remove-silence',
    label: 'Remove Silence',
    desc: 'Remove quiet sections',
    category: 'effects',
    group: 'Clean',
    icon: 'scissors',
    keywords: ['gap', 'pause', 'dead air', 'tighten', 'trim silence'],
    requires: 'selection',
    surface: 'window',
    component: RemoveSilenceWindow,
  },
]

const OPERATIONS_BY_ID = new Map(OPERATIONS.map(op => [op.id, op]))
const CATEGORIES_BY_ID = new Map(CATEGORIES.map(c => [c.id, c]))

export function getOperation(id) {
  return OPERATIONS_BY_ID.get(id) ?? null
}

export function getCategory(id) {
  return CATEGORIES_BY_ID.get(id) ?? null
}

/** Every operation in a category, in declaration order. */
export function operationsIn(categoryId) {
  return OPERATIONS.filter(op => op.category === categoryId)
}

/**
 * A category's operations bucketed by `group`, preserving declaration order for
 * both the groups and the operations inside them. Returns
 * `[{ group, operations }]` — the shape OperationList renders.
 */
export function groupedOperations(categoryId) {
  const groups = []
  const byName = new Map()

  for (const op of operationsIn(categoryId)) {
    const name = op.group ?? ''
    let bucket = byName.get(name)
    if (!bucket) {
      bucket = { group: name, operations: [] }
      byName.set(name, bucket)
      groups.push(bucket)
    }
    bucket.operations.push(op)
  }

  return groups
}

/** Registry entries that open as floating windows, keyed by id. */
export const WINDOW_COMPONENTS = Object.fromEntries(
  OPERATIONS.filter(op => op.surface === 'window').map(op => [op.id, op.component])
)

/**
 * Rank operations against a query for the command palette.
 *
 * Subsequence matching rather than substring, so "vsat" finds Vocal Saturation.
 * Scoring only has to separate an exact label hit from a keyword hit from a
 * loose fuzzy hit — the list is short enough that finer ranking is noise.
 */
export function searchOperations(query, { categoryId = null } = {}) {
  const pool = categoryId ? operationsIn(categoryId) : OPERATIONS
  const q = query.trim().toLowerCase()
  if (!q) return pool

  const scored = []
  for (const op of pool) {
    const label = op.label.toLowerCase()
    let score = -1

    if (label === q) score = 0
    else if (label.startsWith(q)) score = 1
    else if (label.includes(q)) score = 2
    else if (op.keywords?.some(k => k.includes(q))) score = 3
    else if ((op.group ?? '').toLowerCase().includes(q)) score = 4
    else if (isSubsequence(q, label)) score = 5

    if (score >= 0) scored.push({ op, score })
  }

  return scored
    .sort((a, b) => a.score - b.score || a.op.label.localeCompare(b.op.label))
    .map(s => s.op)
}

function isSubsequence(needle, haystack) {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return i === needle.length
}
