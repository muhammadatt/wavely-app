import TrimPanel from '../components/panels/TrimPanel.vue'
import SilencePanel from '../components/panels/SilencePanel.vue'
import FadePanel from '../components/panels/FadePanel.vue'
import VolumePanel from '../components/panels/VolumePanel.vue'
import SplitPanel from '../components/panels/SplitPanel.vue'
import PresetsPanel from '../components/panels/PresetsPanel.vue'

import LA2AModal from '../components/panels/LA2AModal.vue'
import FET1176Modal from '../components/panels/FET1176Modal.vue'
import SoftClipperModal from '../components/panels/SoftClipperModal.vue'
import SchepsModal from '../components/panels/SchepsModal.vue'
import AirBandModal from '../components/panels/AirBandModal.vue'
import ResonanceModal from '../components/panels/ResonanceModal.vue'
import HumRemoverModal from '../components/panels/HumRemoverModal.vue'
import DeEsserModal from '../components/panels/DeEsserModal.vue'
import AutoLevelModal from '../components/panels/AutoLevelModal.vue'
import EqModal from '../components/panels/EqModal.vue'
import VoiceRxModal from '../components/panels/VoiceRxModal.vue'
import NormalizeWindow from '../components/panels/windows/NormalizeWindow.vue'
import VocalSaturationWindow from '../components/panels/windows/VocalSaturationWindow.vue'
import InflatorWindow from '../components/panels/windows/InflatorWindow.vue'
import NoiseReductionWindow from '../components/panels/windows/NoiseReductionWindow.vue'
import RemoveSilenceWindow from '../components/panels/windows/RemoveSilenceWindow.vue'
import SpectrumAnalyzerWindow from '../components/panels/windows/SpectrumAnalyzerWindow.vue'

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
    icon: 'copy',
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
    id: 'master',
    label: 'Master',
    icon: 'master',
    desc: 'One-click mastering chains',
    panel: PresetsPanel,
  },
]

/**
 * Every individual operation.
 *
 *   category  which top-level list it appears in
 *   group     section heading within that list
 *   requires  'selection' | 'clipboard' | 'file' | null — gates the row, the
 *             palette entry and the context-menu item
 *   surface   'rail'      opens as a detail view inside the rail
 *             'window'    opens as a floating window
 *             'immediate' runs on click; no parameters, so nothing opens
 *   action    required for 'immediate'. Receives the editor state object rather
 *             than calling useEditorState() here — this module is imported by
 *             the state's own consumers, and reaching back into it would make
 *             the import order matter.
 *
 * Surface is fixed per category, not per operation: everything under Edit opens
 * in the rail (or runs immediately, for the parameterless verbs), everything
 * under Effects opens as a window. Two adjacent rows in one list never behave
 * differently — that inconsistency is what this replaces.
 */
export const OPERATIONS = [

  // ---- Edit: clipboard verbs (immediate) ----
  // These duplicate SelectionBar's buttons on purpose. The bar is a shortcut
  // strip; a user browsing "Edit" or searching "copy" still expects to find
  // them, and both surfaces now read from this one definition.
  {
    id: 'cut',
    label: 'Cut',
    desc: 'Remove the selection and put it on the clipboard',
    category: 'edit',
    group: 'Selection',
    icon: 'cut',
    keywords: ['clipboard', 'remove', 'delete', 'ctrl+x'],
    requires: 'selection',
    surface: 'immediate',
    action: editor => {
      editor.performCut()
      editor.showToast('Cut to clipboard')
    },
  },
  {
    id: 'copy',
    label: 'Copy',
    desc: 'Put the selection on the clipboard',
    category: 'edit',
    group: 'Selection',
    icon: 'copy',
    keywords: ['clipboard', 'duplicate', 'ctrl+c'],
    requires: 'selection',
    surface: 'immediate',
    action: editor => {
      editor.performCopy()
      editor.showToast('Copied to clipboard')
    },
  },
  {
    id: 'paste',
    label: 'Paste',
    desc: 'Insert the clipboard at the playhead',
    category: 'edit',
    group: 'Selection',
    icon: 'paste',
    keywords: ['clipboard', 'insert', 'ctrl+v'],
    requires: 'clipboard',
    surface: 'immediate',
    action: editor => {
      editor.performPaste(editor.state.playhead)
      editor.showToast('Pasted at playhead')
    },
  },
  {
    id: 'select-all',
    label: 'Select All',
    desc: 'Select the entire track',
    category: 'edit',
    group: 'Selection',
    icon: 'selectAll',
    keywords: ['everything', 'whole', 'ctrl+a'],
    requires: null,
    surface: 'immediate',
    action: editor => editor.selectAll(),
  },

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
    label: 'Opto Comp',
    desc: 'Subtle, transparent compressor',
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
    desc: 'Peak compressor/limiter',
    category: 'effects',
    group: 'Dynamics',
    icon: 'fet',
    keywords: ['1176', 'compressor', 'fet', 'punch', 'aggressive', 'fast'],
    requires: 'selection',
    surface: 'window',
    component: FET1176Modal,
  },
  {
    // Filed under Dynamics, ahead of the compressors in the panel: the whole
    // point is to run before them, taming plosive peaks so they don't slip
    // past a compressor's attack and get amplified by makeup gain.
    id: 'soft-clipper',
    label: 'Soft Clipper',
    desc: 'Tame transient peaks before compression',
    category: 'effects',
    group: 'Dynamics',
    icon: 'clipper',
    keywords: ['clip', 'clipper', 'transient', 'plosive', 'peak', 'soft clip', 'saturation'],
    requires: 'selection',
    surface: 'window',
    component: SoftClipperModal,
  },
  {
    // Filed under Dynamics rather than Tone: the two Pultec stages are there to
    // steer the compressor's sidechain, and what the user is reaching for is a
    // parallel compression sound. The EQ is the mechanism, not the offer.
    id: 'scheps-parallel',
    label: 'Scheps Parallel',
    desc: 'Blend in a squashed, EQ-steered copy',
    category: 'effects',
    group: 'Dynamics',
    icon: 'parallel',
    keywords: [
      'scheps', 'parallel', 'pultec', 'eqp-1a', 'la-2a', 'trick', 'blend',
      'mix', 'thick', 'presence', 'vocal', 'compressor', 'new york',
    ],
    requires: 'selection',
    surface: 'window',
    component: SchepsModal,
  },
  {
    id: 'vocal-saturation',
    label: 'Tube Saturation',
    desc: 'Warm tube-like saturation',
    category: 'effects',
    group: 'Tone',
    icon: 'saturation',
    keywords: ['tube', 'warmth', 'harmonic', 'drive', 'distortion', 'analog'],
    requires: 'selection',
    surface: 'window',
    component: VocalSaturationWindow,
  },
  {
    id: 'inflator',
    label: 'Inflator',
    desc: 'Raise quiet detail without raising the ceiling',
    category: 'effects',
    group: 'Dynamics',
    icon: 'saturation',
    keywords: [
      'inflator', 'inflate', 'sonnox', 'density', 'loudness', 'punch',
      'presence', 'thickness', 'curve', 'harmonic', 'clip', 'band split',
    ],
    requires: 'selection',
    surface: 'window',
    component: InflatorWindow,
  },
  {
    id: 'manual-eq',
    label: 'EQ',
    desc: 'Parametric equalizer',
    category: 'effects',
    group: 'Tone',
    icon: 'eq',
    keywords: ['equalizer', 'equaliser', 'eq', 'parametric', 'frequency', 'tone', 'bass', 'treble', 'filter'],
    requires: 'selection',
    surface: 'window',
    component: EqModal,
  },
  {
    // Its own window and its own band pool. It was once a second door into the
    // EQ — one pool, two views — which is why the two still look related; see
    // useEqInstance.js for why they were separated.
    id: 'voicerx',
    label: 'VoiceRx',
    desc: 'Find what’s wrong with a voice recording',
    category: 'effects',
    group: 'Tone',
    icon: 'voicerx',
    keywords: ['voice', 'diagnose', 'analyze', 'analyse', 'muddy', 'boxy', 'harsh', 'nasal', 'eq', 'doctor', 'fix'],
    requires: 'selection',
    surface: 'window',
    component: VoiceRxModal,
  },
  {
    id: 'air-band',
    label: 'Air Boost',
    desc: 'Add air and sparkle',
    category: 'effects',
    group: 'Tone',
    icon: 'air',
    keywords: ['air', 'maag', 'shelf', 'high', 'presence', 'sheen', 'treble', 'eq'],
    requires: 'selection',
    surface: 'window',
    component: AirBandModal,
  },
  {
    id: 'resonance-suppressor',
    label: 'Reso Smooth',
    desc: 'Soothe harsh resonances',
    category: 'effects',
    group: 'Tone',
    icon: 'resonance',
    keywords: ['resonance', 'soothe', 'harsh', 'ring', 'room mode', 'dynamic eq', 'peak'],
    requires: 'selection',
    surface: 'window',
    component: ResonanceModal,
  },
  {
    id: 'auto-leveler',
    label: 'Auto Leveler',
    desc: 'Even out level between phrases',
    category: 'effects',
    group: 'Level',
    icon: 'autolevel',
    keywords: [
      'level', 'leveller', 'leveler', 'auto level', 'ride', 'gain riding',
      'clip gain', 'consistency', 'even', 'volume', 'quiet passage', 'acx',
    ],
    requires: 'selection',
    surface: 'window',
    component: AutoLevelModal,
  },
  {
    id: 'clip-gain-deesser',
    label: 'De-Esser',
    desc: 'Tame harsh S and F sounds',
    category: 'effects',
    group: 'Clean',
    icon: 'deesser',
    keywords: ['de-ess', 'deesser', 'sibilance', 'sibilant', 'harsh', 'ess', 'fricative', 'clip gain'],
    requires: 'selection',
    surface: 'window',
    component: DeEsserModal,
  },
  {
    id: 'hum-remover',
    label: 'Hum Remover',
    desc: 'Remove electrical hum',
    category: 'effects',
    group: 'Clean',
    icon: 'hum',
    keywords: ['hum', 'buzz', 'mains', 'ground loop', '50hz', '60hz', 'notch', 'electrical'],
    requires: 'selection',
    surface: 'window',
    component: HumRemoverModal,
  },
  {
    id: 'noise-reduction',
    label: 'Noise Reduction',
    desc: 'Remove background noise',
    category: 'effects',
    group: 'Clean',
    icon: 'noise',
    keywords: ['denoise', 'hiss', 'background', 'deepfilternet', 'clean'],
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
    icon: 'removeSilence',
    keywords: ['gap', 'pause', 'dead air', 'tighten', 'trim silence'],
    requires: 'selection',
    surface: 'window',
    component: RemoveSilenceWindow,
  },

  // ---- Analysis ----
  // Its own group because it is the one entry here that measures rather than
  // changes: it needs a file and a transport, not a selection, and it has no
  // Apply. Filing it under Dynamics or Tone would put a row that alters nothing
  // in a list where every other row does.
  {
    id: 'spectrum-analyzer',
    label: 'Spectrum Analyzer',
    desc: 'See what is in the file, frequency by frequency',
    category: 'effects',
    group: 'Analysis',
    icon: 'spectrum',
    keywords: [
      'spectrum', 'analyser', 'analyzer', 'fft', 'frequency', 'rta',
      'spectral', 'meter', 'display', 'hum', 'noise', 'hiss',
    ],
    requires: 'file',
    surface: 'window',
    component: SpectrumAnalyzerWindow,
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
 * Subsequence matching rather than substring, so "tsat" finds Tube Saturation.
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
