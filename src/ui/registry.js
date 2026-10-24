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
import SaturationBenchModal from '../components/panels/SaturationBenchModal.vue'
import ResonanceModal from '../components/panels/ResonanceModal.vue'
import HumRemoverModal from '../components/panels/HumRemoverModal.vue'
import SibilanceEditorModal from '../components/panels/SibilanceEditorModal.vue'
import DeEsserModal from '../components/panels/DeEsserModal.vue'
import HFLimiterModal from '../components/panels/HFLimiterModal.vue'
import PlosiveModal from '../components/panels/PlosiveModal.vue'
import PhatassModal from '../components/panels/PhatassModal.vue'
import AutoLevelModal from '../components/panels/AutoLevelModal.vue'
import EqModal from '../components/panels/EqModal.vue'
import VoiceRxModal from '../components/panels/VoiceRxModal.vue'
import NormalizeWindow from '../components/panels/windows/NormalizeWindow.vue'
import LoudnessWindow from '../components/panels/windows/LoudnessWindow.vue'
import VocalSaturationWindow from '../components/panels/windows/VocalSaturationWindow.vue'
import InflatorWindow from '../components/panels/windows/InflatorWindow.vue'
import SpectrumAnalyzerWindow from '../components/panels/windows/SpectrumAnalyzerWindow.vue'
import PluginChainWindow from '../components/panels/windows/PluginChainWindow.vue'
import ModulaGalleryWindow from '../components/modula/ModulaGalleryWindow.vue'
import { DEV_TUNING_PANELS } from '../devFlags.js'

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
const ALL_CATEGORIES = [
  {
    id: 'edit',
    label: 'Edit',
    icon: 'copy',
    desc: 'Cut, arrange and shape the content',
    panel: null,
  },
  // Effects are split by the job the user came to do rather than kept as one
  // long list: hit a level, control dynamics, shape tone, clean up problems.
  {
    id: 'level',
    label: 'Level',
    icon: 'loudness',
    desc: 'Hit a peak or loudness target, set volume and fades',
    panel: null,
  },
  {
    id: 'dynamics',
    label: 'Dynamics',
    icon: 'dynamics',
    desc: 'Even out phrases, compress, limit and add density',
    panel: null,
  },
  {
    id: 'tone',
    label: 'Tone',
    icon: 'eq',
    desc: 'EQ, air and saturation',
    panel: null,
  },
  {
    id: 'clean',
    label: 'Fix',
    icon: 'clean',
    desc: 'Tame sibilance, harshness, resonances and hum',
    panel: null,
  },
  {
    id: 'master',
    label: 'Master',
    icon: 'master',
    desc: 'One-click mastering chains',
    panel: PresetsPanel,
    // Dev-only for now: gated by the same switch as the operations'
    // `release: 'dev'` below, so a production toolbar has no Master button.
    release: 'dev',
  },
]

/**
 * Every individual operation.
 *
 *   category  which top-level list it appears in; null keeps it out of the
 *             toolbar's lists (it is still in the command palette)
 *   group     section heading within that list; omitted, no heading
 *   requires  'selection' | 'clipboard' | 'file' | null — gates the row, the
 *             palette entry and the context-menu item
 *   surface   'rail'      opens as a detail view inside the rail
 *             'window'    opens as a floating window
 *             'immediate' runs on click; no parameters, so nothing opens
 *   feature   optional plan feature (src/auth/plans.js) the operation's Apply
 *             needs. The row stays open to everyone — preview is free — and
 *             shows a PRO tag while the user's plan lacks it
 *   action    required for 'immediate'. Receives the editor state object rather
 *             than calling useEditorState() here — this module is imported by
 *             the state's own consumers, and reaching back into it would make
 *             the import order matter.
 *
 * Surface is fixed per category, with one exception: everything under Edit opens
 * in the rail (or runs immediately, for the parameterless verbs), everything
 * under Level, Dynamics, Tone and Fix opens as a window — except Fade and
 * Volume, which sit in Level but open in the rail.
 */
/**
 * RELEASE GATING — which operations a production build shows.
 *
 * An entry marked `release: 'dev'` is work in progress: it is in every dev
 * server and in a build made with VITE_DEV_PANELS=1 (the same switch as the
 * tuning panels, see devFlags.js), and absent from a production build — not in
 * the toolbar, the rail, the command palette or the window layer, because all
 * four read OPERATIONS below. Shipping one is deleting its `release` line.
 *
 * ⚠ HIDDEN, NOT STRIPPED. The component is still imported here, so its code is
 * in the production bundle; there is just no way to reach it. Only the Modula
 * Kit gallery is also stubbed out of the bundle (vite.config.js).
 */
const ALL_OPERATIONS = [
  // ---- Edit (rail, or immediate for the clipboard verbs) ----
  // These duplicate SelectionBar's buttons on purpose. The bar is a shortcut
  // strip; a user browsing "Edit" or searching "copy" still expects to find
  // them, and both surfaces now read from this one definition.
  {
    id: 'cut',
    label: 'Cut',
    desc: 'Remove the selection and put it on the clipboard',
    category: 'edit',
    group: 'Clipboard',
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
    group: 'Clipboard',
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
    group: 'Clipboard',
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
    group: 'Clipboard',
    icon: 'selectAll',
    keywords: ['everything', 'whole', 'ctrl+a'],
    requires: null,
    surface: 'immediate',
    action: editor => editor.selectAll(),
  },
  {
    id: 'trim',
    label: 'Trim',
    desc: 'Remove audio outside or inside your selection',
    category: 'edit',
    group: 'Arrange',
    icon: 'trim',
    keywords: ['crop', 'cut', 'keep', 'remove', 'outside', 'inside'],
    requires: 'selection',
    surface: 'rail',
    component: TrimPanel,
  },
  {
    // Was a top-level toolbar category of its own; it is one edit among the
    // others, so it lives in the Edit list now.
    id: 'split',
    label: 'Split',
    desc: 'Cut the clip in two at the playhead or the selection edges',
    category: 'edit',
    group: 'Arrange',
    icon: 'split',
    keywords: ['divide', 'cut', 'separate', 'clips', 'pieces', 'playhead', 'razor'],
    requires: 'file',
    surface: 'rail',
    component: SplitPanel,
  },
  {
    id: 'silence',
    label: 'Silence',
    desc: 'Replace the selected region with silence',
    category: 'edit',
    group: 'Arrange',
    icon: 'silence',
    keywords: ['mute', 'blank', 'quiet', 'erase'],
    requires: 'selection',
    surface: 'rail',
    component: SilencePanel,
  },

  // ---- Level (windows, plus the Fade and Volume rail views) ----
  {
    id: 'normalize',
    // "Normalize" on its own stopped being a name the moment there were two of
    // them, and the pair are not interchangeable: one puts the loudest SAMPLE
    // somewhere, the other puts the perceived LOUDNESS somewhere. Both say
    // which in the label, so the rail never offers a choice between a word and
    // the same word.
    label: 'Peak Normalize',
    desc: 'Put the loudest peak at a chosen level',
    category: 'level',
    icon: 'normalize',
    keywords: ['peak', 'level', 'maximize', 'gain', 'amplify'],
    requires: 'selection',
    surface: 'window',
    component: NormalizeWindow,
  },
  {
    id: 'loudness',
    label: 'Loudness Normalize',
    desc: 'Hit a delivery target like ACX, Spotify or -16 LUFS',
    category: 'level',
    icon: 'loudness',
    keywords: [
      'lufs', 'loudness', 'level', 'acx', 'spotify', 'apple', 'youtube',
      'amazon', 'tidal', 'podcast', 'broadcast', 'r128', 'ebu', 'rms',
      'true peak', 'dbtp', 'target', 'compliance',
    ],
    requires: 'selection',
    surface: 'window',
    component: LoudnessWindow,
  },
  // Fade and Volume are parameter-light, so they open in the rail like the Edit
  // verbs rather than as windows; the rail's detail view works in any category.
  {
    id: 'fade',
    label: 'Fade',
    desc: 'Shape the volume curve at the selection edges',
    category: 'level',
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
    category: 'level',
    icon: 'volume',
    keywords: ['gain', 'louder', 'quieter', 'amplify', 'db'],
    requires: 'selection',
    surface: 'rail',
    component: VolumePanel,
  },

  // ---- Dynamics (windows) ----
  {
    // First in Dynamics: it evens out phrases ahead of the compressors, which
    // would otherwise work harder on the loud ones.
    id: 'auto-leveler',
    label: 'Auto Leveler',
    desc: 'Even out level between phrases',
    category: 'dynamics',
    icon: 'autolevel',
    keywords: [
      'level', 'leveller', 'leveler', 'auto level', 'ride', 'gain riding',
      'clip gain', 'consistency', 'even', 'volume', 'quiet passage', 'acx',
    ],
    requires: 'selection',
    feature: 'autoLevel',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: AutoLevelModal,
  },
  {
    // Filed under Dynamics, ahead of the compressors in the panel: the whole
    // point is to run before them, taming plosive peaks so they don't slip
    // past a compressor's attack and get amplified by makeup gain.
    id: 'soft-clipper',
    label: 'Soft Clipper',
    desc: 'Tame transient peaks before compression',
    category: 'dynamics',
    icon: 'clipper',
    keywords: ['clip', 'clipper', 'transient', 'plosive', 'peak', 'soft clip', 'saturation'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: SoftClipperModal,
  },
  {
    id: 'opto-smooth',
    label: 'LA Vintage 2A',
    desc: 'Subtle, transparent compressor',
    category: 'dynamics',
    icon: 'opto',
    keywords: ['la-2a', 'la2a', 'compressor', 'opto', 'opto comp', 'optosmooth', 'tube', 'leveler', 'smooth'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: LA2AModal,
  },
  {
    id: 'fet-punch',
    label: 'LA Classic 76',
    desc: 'Peak compressor/limiter',
    category: 'dynamics',
    icon: 'fet',
    keywords: ['1176', 'compressor', 'fet', 'fet punch', 'punch', 'aggressive', 'fast'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: FET1176Modal,
  },
  {
    // Filed under Dynamics rather than Tone: the two Pultec stages are there to
    // steer the compressor's sidechain, and what the user is reaching for is a
    // parallel compression sound. The EQ is the mechanism, not the offer.
    id: 'scheps-parallel',
    release: 'dev',
    label: 'Scheps Parallel',
    desc: 'Blend in a squashed, EQ-steered copy',
    category: 'dynamics',
    icon: 'parallel',
    keywords: [
      'scheps', 'parallel', 'pultec', 'eqp-1a', 'la-2a', 'trick', 'blend',
      'mix', 'thick', 'presence', 'vocal', 'compressor', 'new york',
    ],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: SchepsModal,
  },
  {
    id: 'inflator',
    label: 'Cambridge Inflator',
    desc: 'Raise quiet detail without raising the ceiling',
    category: 'dynamics',
    icon: 'saturation',
    keywords: [
      'inflator', 'inflate', 'sonnox', 'density', 'loudness', 'punch',
      'presence', 'thickness', 'curve', 'harmonic', 'clip', 'band split',
    ],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: InflatorWindow,
  },

  // ---- Tone (windows) ----
  {
    id: 'manual-eq',
    label: 'EQ',
    desc: 'Parametric equalizer',
    category: 'tone',
    icon: 'eq',
    keywords: ['equalizer', 'equaliser', 'eq', 'parametric', 'frequency', 'tone', 'bass', 'treble', 'filter'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: EqModal,
  },
  {
    // Its own window and its own band pool. It was once a second door into the
    // EQ — one pool, two views — which is why the two still look related; see
    // useEqInstance.js for why they were separated.
    id: 'voicerx',
    release: 'dev',
    label: 'VoiceRx',
    desc: 'Find what’s wrong with a voice recording',
    category: 'tone',
    icon: 'voicerx',
    keywords: ['voice', 'diagnose', 'analyze', 'analyse', 'muddy', 'boxy', 'harsh', 'nasal', 'eq', 'doctor', 'fix'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: VoiceRxModal,
  },
  {
    id: 'air-band',
    label: 'Air Boost',
    desc: 'Add air and sparkle',
    category: 'tone',
    icon: 'air',
    keywords: ['air', 'maag', 'shelf', 'high', 'presence', 'sheen', 'treble', 'eq'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: AirBandModal,
  },
  {
    // Psycho Harmonic Analog Tape * Saturation Simulator: the HF Limiter's
    // Warmth circuit, moved out, plus its shelf with shape and timing pinned.
    id: 'phatass',
    label: 'PHAT*SS',
    desc: 'Tape-style warmth and a rounded top end',
    category: 'tone',
    icon: 'tape',
    keywords: ['tape', 'phatass', 'phat', 'warmth', 'warm', 'fat', 'body', 'analog', 'saturation', 'harmonic', 'odd', 'even'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: PhatassModal,
  },
  {
    id: 'vocal-saturation',
    release: 'dev',
    label: 'Tube Saturation',
    desc: 'Warm tube-like saturation',
    category: 'tone',
    icon: 'saturation',
    keywords: ['tube', 'warmth', 'harmonic', 'drive', 'distortion', 'analog'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: VocalSaturationWindow,
  },
  {
    id: 'saturation-bench',
    label: 'Saturation Workbench',
    desc: 'Stack layers of saturation, each on its own band',
    category: 'tone',
    icon: 'saturation',
    keywords: [
      'saturation', 'saturate', 'exciter', 'excite', 'harmonic', 'warmth', 'drive',
      'distortion', 'waveshaper', 'tanh', 'quartic', 'layers', 'bench', 'workbench',
    ],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: SaturationBenchModal,
  },

  // ---- Fix (windows) ----
  {
    // The real-time de-esser: dips the top end only while a consonant spikes.
    // The Sibilance Editor above is the event-based version: it analyses the
    // selection and rides clip gain on each event.
    id: 'hf-softener',
    label: 'De-Esser',
    desc: 'Soften harsh S sounds, keep the air',
    category: 'clean',
    group: 'Harshness',
    icon: 'softener',
    keywords: ['sibilance', 'sibilant', 'harsh', 'hard', 'ess', 'de-ess', 'deesser', 'hf softener', 'soft', 'soften', 'dynamic shelf', 'high shelf', 'warmth', 'fatso', 'air'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: DeEsserModal,
  },
  {
    id: 'clip-gain-deesser',
    release: 'dev',
    label: 'Sibilance Editor',
    desc: 'Find harsh S and F events and turn each down',
    category: 'clean',
    group: 'Harshness',
    icon: 'deesser',
    keywords: ['sibilance editor', 'sibilance', 'sibilant', 'harsh', 'ess', 'fricative', 'clip gain'],
    requires: 'selection',
    feature: 'sibilanceEditor',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: SibilanceEditorModal,
  },
  {
    id: 'hf-limiter',
    label: 'HF Limiter',
    desc: 'Put a ceiling on brightness, harshness and edges',
    category: 'clean',
    group: 'Harshness',
    icon: 'hflimiter',
    keywords: ['high frequency', 'hf', 'treble', 'limiter', 'bright', 'harsh', 'sibilance', 'transient', 'hifal', 'limen', 'fatso', 'shelf', 'ceiling'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: HFLimiterModal,
  },
  {
    id: 'resonance-suppressor',
    label: 'Reso Soothe',
    desc: 'Soothe harsh resonances',
    category: 'clean',
    group: 'Harshness',
    icon: 'resonance',
    keywords: ['resonance', 'soothe', 'reso smooth', 'resotame', 'harsh', 'ring', 'room mode', 'dynamic eq', 'peak'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: ResonanceModal,
  },
  {
    // Real-time plosive repair: the low thump of a P or B, and the top-end
    // burst of a T, K or P release (the latter moved out of the De-Esser).
    id: 'plosive',
    release: 'dev',
    label: 'Plosive Tamer',
    desc: 'Take the thump out of P and B, the spit out of T and K',
    category: 'clean',
    group: 'Pops & Hum',
    icon: 'plosive',
    keywords: ['plosive', 'pop', 'popping', 'p pop', 'thump', 'boom', 'breath blast', 'pop filter', 'deplosive', 'de-plosive', 'burst', 'spit'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: PlosiveModal,
  },
  {
    id: 'hum-remover',
    label: 'Hum Remover',
    desc: 'Remove electrical hum',
    category: 'clean',
    group: 'Pops & Hum',
    icon: 'hum',
    keywords: ['hum', 'buzz', 'mains', 'ground loop', '50hz', '60hz', 'notch', 'electrical'],
    requires: 'selection',
    // Runs live in the playback chain, so it can take a slot — see chainPlugins().
    chain: true,
    surface: 'window',
    component: HumRemoverModal,
  },
  // Its own group because it is the one entry here that measures rather than
  // changes: it needs a file and a transport, not a selection, and it has no
  // Apply. Filed under Fix because finding a problem is what it is mostly
  // used for, and last so a row that alters nothing sits apart from the rest.
  {
    id: 'spectrum-analyzer',
    label: 'Spectrum Analyzer',
    desc: 'See what is in the file, frequency by frequency',
    category: 'clean',
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
  // DEV ONLY: every Modula control on one page, for review against the kit
  // (docs/design/modula). Stubbed out of production builds (vite.config.js).
  {
    id: 'modula-kit',
    release: 'dev',
    label: 'Modula Kit',
    desc: 'Developer gallery of the plugin control-surface kit',
    category: 'clean',
    group: 'Analysis',
    icon: 'spectrum',
    keywords: ['modula', 'kit', 'gallery', 'design', 'components'],
    requires: 'file',
    surface: 'window',
    component: ModulaGalleryWindow,
  },

  // ---- Not in a toolbar category ----
  // The rack every engaged plugin plays through — reorder, bypass, and apply
  // them all at once. Its door is the toolbar's Chain button, which is always
  // on screen, so it takes no row in a category list; the palette still finds it.
  {
    id: 'plugin-chain',
    label: 'Plugin Chain',
    desc: 'Order, bypass and apply every active plugin at once',
    category: null,
    icon: 'chain',
    keywords: ['chain', 'rack', 'serial', 'order', 'reorder', 'bypass', 'apply all', 'insert', 'plugins'],
    requires: 'selection',
    feature: 'pluginChainApply',
    surface: 'window',
    component: PluginChainWindow,
  },
]

/** Shown in this build: everything released, plus WIP under a dev build. */
export function isReleased(op, devBuild = DEV_TUNING_PANELS) {
  return op.release !== 'dev' || devBuild
}

export const OPERATIONS = ALL_OPERATIONS.filter(op => isReleased(op))

/** The toolbar's categories in this build — gated like the operations. */
export const CATEGORIES = ALL_CATEGORIES.filter(c => isReleased(c))

/** Ids hidden from production builds — for tests and the bundle check. */
export const DEV_ONLY_OPERATION_IDS = ALL_OPERATIONS
  .filter(op => op.release === 'dev').map(op => op.id)

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

/**
 * The plugins that can take a slot in the Plugin Chain — the ones marked
 * `chain: true`, which are exactly those that run live in the playback chain.
 * Peak and Loudness Normalize, the analyzer and the chain itself cannot, which
 * is why the chain is filled from this list rather than by opening windows.
 */
export function chainPlugins() {
  return OPERATIONS.filter(op => op.chain)
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
export function searchOperations(query, { categoryId = null, pool: only = null } = {}) {
  const pool = only ?? (categoryId ? operationsIn(categoryId) : OPERATIONS)
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
