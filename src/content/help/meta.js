/**
 * The help pages' titles, categories and URL slugs — split out of `index.js`
 * so code that only needs an effect's name or slug (the editor's try-out link,
 * the marketing pages) does not bundle every help page's text.
 */

/**
 * What the help pages print around an entry: its title and the toolbar category
 * it is filed under, in toolbar order — the index page lists them this way.
 *
 * ⚠ It repeats the registry's `label`, `category` and `release` on purpose: the
 * registry imports every faceplate, and a help tab must not load the editor to
 * learn a name. `test/ui/helpContent.test.js` reads them back out of
 * `src/ui/registry.js`, so the two cannot drift.
 *
 *   release: 'dev'  not on the index or in the sidebar in ANY build — they
 *                   list shipping effects only — and in a production build no
 *                   page, no screenshots and no link from a window. A dev build
 *                   still serves the page itself, so its `?` works there
 *
 * Every page's URL is its product name (`helpSlug`), never the window id: the
 * ids keep old names (`opto-smooth` is LA Vintage 2A).
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

/** The ids with a page in this build (dev-only ones only in dev). */
export function publishedHelpIds(devBuild) {
  return Object.keys(HELP_META).filter(id => devBuild || HELP_META[id].release !== 'dev')
}

/** The ids the index and sidebar list: shipping effects only, in every build. */
export function listedHelpIds() {
  return Object.keys(HELP_META).filter(id => HELP_META[id].release !== 'dev')
}

/**
 * A page's URL segment, from its product name: `LA Vintage 2A` →
 * `la-vintage-2a`, `PHAT*SS` → `phatss`.
 */
export function helpSlug(windowId) {
  return HELP_META[windowId].title
    .toLowerCase()
    .replace(/[*']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
