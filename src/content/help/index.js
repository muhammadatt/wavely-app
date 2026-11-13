/**
 * Per-effect help content — the pages behind the harness's `?` button.
 *
 * ── THE PAGES LIVE ON THEIR OWN URL ─────────────────────────────────────────
 * Each entry is rendered as a standalone page at `/help/<window-id>/` (the
 * `help/index.html` entry, `src/help/`), which the `?` opens in a new browser
 * tab. It used to be an overlay inside the plugin window, and the windows are
 * small and all different sizes, so the same text read differently in every
 * one. The page imports nothing from the editor — only this directory — so it
 * loads fast and cannot pull the audio engine into a help tab.
 *
 * ── THE SHAPE IS FIXED SO THE PANEL CANNOT DRIFT ────────────────────────────
 * Each entry is data, not markup. There is no rich text, no markdown and no
 * HTML, which is deliberate: fifteen authors editing fifteen files will not
 * converge on one layout by agreement, and the one thing this panel has to be
 * is the same panel on every effect. The component owns how a section looks;
 * this directory owns only what it says.
 *
 * ── KEYED BY WINDOW ID, WHICH IS WHY NO PLUGIN HAD TO BE TOUCHED ────────────
 * The keys are the same ids `FloatingWindow` already receives as `windowId`
 * and `src/ui/registry.js` already uses for its operations. The harness looks
 * its own help up by the id it was given, so adding help to a window is a file
 * here and nothing else — no prop to thread, no import in a faceplate, and no
 * chance of a window showing another effect's instructions.
 *
 * ── EDITING ─────────────────────────────────────────────────────────────────
 * One file per effect under this directory. To add an effect: write
 * `<window-id>.js` exporting the shape below, then add the import and the entry
 * here. `test/ui/helpContent.test.js` fails if an effect window has no entry,
 * so the list cannot silently fall behind the app.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 *   summary   string    Required. One sentence: what this effect does to the
 *                       audio. Written like the registry's own `desc` — a verb
 *                       phrase about the user's file, not about the DSP.
 *
 *   whenToUse string[]  Required, 1–5 entries. The situations that should make
 *                       someone reach for this rather than its neighbours. This
 *                       is the section that earns the panel: a control list can
 *                       be inferred from the faceplate, "when is this the right
 *                       tool" cannot.
 *
 *   controls  [control]  Required. One entry per control on the faceplate, in
 *                       the order they appear on it (fields below). `label`
 *                       must match what is printed on the panel exactly — a
 *                       help entry naming a knob that is not there is worse
 *                       than no entry. Controls that are not on the panel
 *                       (bench rows, pinned parameters) are not documented.
 *
 *   quickStart string[]  Required, 2–6 entries. The fastest route from opening
 *                       the window to a good result, in order — the manuals'
 *                       "Quick Start" (Waves' CLA-2A and Parallel Particles
 *                       guides are the model). Name the controls as printed
 *
 *   notes     string[]  Optional. What is easy to get wrong, and anything the
 *                       panel implies but does not say — a latency cost, a
 *                       control that only applies in one mode, a limit
 *
 * ── A CONTROL ENTRY ─────────────────────────────────────────────────────────
 *
 *   label     string    Required. Exactly as printed on the panel
 *   text      string    Required. One sentence: what it controls
 *   group     string    Optional. The panel section it sits in (DE-ESS, AIR…);
 *                       consecutive controls with the same group share a
 *                       heading on the page
 *   details   string[]  Optional. Further paragraphs: how it behaves, what it
 *                       interacts with, the technical detail behind it
 *   range     string    Optional. Its travel, with units: `0 to 100`,
 *                       `−24 to +24 dB in 0.1 dB steps`, `COMP, LIMIT`
 *   default   string    Optional. What a fresh window opens at
 *   shot      string    Optional. A `data-help` id carried by the control's
 *                       element on the panel. `npm run help:shots` crops it
 *                       into `public/help/shots/<id>/<shot>.png`; the page shows
 *                       the crop beside the entry. The whole window is always
 *                       shot as the Interface image
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * The product's rules apply here and are partly enforced by the test: second
 * person, present tense, sentence case, exact numbers with units, and **no
 * terminal punctuation** — every string ends bare, the same as every other
 * string in the app. Write one clause per entry rather than a paragraph; two
 * sentences in one bullet is a sign it should be two bullets. No emoji.
 */

import airBand from './air-band.js'
import autoLeveler from './auto-leveler.js'
import sibilanceEditor from './clip-gain-deesser.js'
import fetPunch from './fet-punch.js'
import hfLimiter from './hf-limiter.js'
import deEsser from './de-esser.js'
import humRemover from './hum-remover.js'
import loudness from './loudness.js'
import manualEq from './manual-eq.js'
import noiseReduction from './noise-reduction.js'
import normalize from './normalize.js'
import optoSmooth from './opto-smooth.js'
import phatass from './phatass.js'
import pluginChain from './plugin-chain.js'
import plosive from './plosive.js'
import resonanceSuppressor from './resonance-suppressor.js'
import saturationBench from './saturation-bench.js'
import schepsParallel from './scheps-parallel.js'
import softClipper from './soft-clipper.js'
import spectrumAnalyzer from './spectrum-analyzer.js'
import inflator from './inflator.js'
import vocalSaturation from './vocal-saturation.js'
import voicerx from './voicerx.js'
import voxPressor from './vox-pressor.js'

export const HELP = {
  'air-band': airBand,
  'auto-leveler': autoLeveler,
  'clip-gain-deesser': sibilanceEditor,
  'fet-punch': fetPunch,
  'hf-limiter': hfLimiter,
  'de-esser': deEsser,
  'hum-remover': humRemover,
  loudness,
  'manual-eq': manualEq,
  'noise-reduction': noiseReduction,
  normalize,
  'opto-smooth': optoSmooth,
  phatass,
  plosive,
  'resonance-suppressor': resonanceSuppressor,
  'saturation-bench': saturationBench,
  'scheps-parallel': schepsParallel,
  'soft-clipper': softClipper,
  'spectrum-analyzer': spectrumAnalyzer,
  'plugin-chain': pluginChain,
  'inflator': inflator,
  'vocal-saturation': vocalSaturation,
  voicerx,
  'vox-pressor': voxPressor,
}

/**
 * What the help pages print around an entry: its title and the toolbar category
 * it is filed under, in toolbar order — the index page lists them this way.
 *
 * ⚠ It repeats the registry's `label`, `category` and `release` on purpose: the
 * registry imports every faceplate, and a help tab must not load the editor to
 * learn a name. `test/ui/helpContent.test.js` reads them back out of
 * `src/ui/registry.js`, so the two cannot drift.
 *
 *   release: 'dev'  hidden from production builds exactly as the operation is:
 *                   not on the index, no page emitted, no link from a window
 */
export const HELP_CATEGORIES = [
  { id: 'level', label: 'Level' },
  { id: 'dynamics', label: 'Dynamics' },
  { id: 'tone', label: 'Tone' },
  { id: 'clean', label: 'Fix' },
  { id: null, label: 'Workflow' },
]

export const HELP_META = {
  normalize: { title: 'Peak Normalize', category: 'level' },
  loudness: { title: 'Loudness Normalize', category: 'level' },
  'auto-leveler': { title: 'Auto Leveler', category: 'dynamics' },
  'soft-clipper': { title: 'Soft Clipper', category: 'dynamics' },
  'opto-smooth': { title: 'LA Vintage 2A', category: 'dynamics' },
  'fet-punch': { title: 'LA Classic 76', category: 'dynamics' },
  'vox-pressor': { title: 'VoxPressor', category: 'dynamics' },
  'scheps-parallel': { title: 'Scheps Parallel', category: 'dynamics', release: 'dev' },
  inflator: { title: 'Cambridge Inflator', category: 'dynamics' },
  'manual-eq': { title: 'EQ', category: 'tone' },
  voicerx: { title: 'VoiceRx', category: 'tone', release: 'dev' },
  'air-band': { title: 'Air Boost', category: 'tone' },
  phatass: { title: 'PHAT*SS', category: 'tone' },
  'vocal-saturation': { title: 'Tube Saturation', category: 'tone', release: 'dev' },
  'saturation-bench': { title: 'Saturation Workbench', category: 'tone' },
  'noise-reduction': { title: 'Noise Reduction', category: 'clean' },
  'de-esser': { title: 'De-Esser', category: 'clean' },
  'clip-gain-deesser': { title: 'Sibilance Editor', category: 'clean', release: 'dev' },
  'hf-limiter': { title: 'Hi-Freq Limiter', category: 'clean' },
  'resonance-suppressor': { title: 'Reso Soothe', category: 'clean' },
  plosive: { title: 'Plosive Tamer', category: 'clean', release: 'dev' },
  'hum-remover': { title: 'Hum Remover', category: 'clean' },
  'spectrum-analyzer': { title: 'Spectrum Analyzer', category: 'clean' },
  'plugin-chain': { title: 'Effect Chain', category: null },
}

/** The ids with a published page in this build (dev-only ones only in dev). */
export function publishedHelpIds(devBuild) {
  return Object.keys(HELP_META).filter(id => devBuild || HELP_META[id].release !== 'dev')
}

/**
 * The URL of an effect's help page. Trailing slash: the build emits each page
 * as `help/<id>/index.html`, which every static host serves at this path with
 * no rewrite rule.
 */
export function helpUrl(windowId) {
  return `/help/${encodeURIComponent(windowId)}/`
}

/**
 * Help for one window, or null.
 *
 * Null rather than a stub, because the harness uses it to decide whether to
 * show the `?` at all: a button that opens an empty panel is worse than no
 * button. Nothing else in the app should special-case a missing entry.
 */
export function helpFor(windowId) {
  return HELP[windowId] ?? null
}
