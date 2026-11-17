/**
 * Per-effect MARKETING pages — `/effects/<slug>/`, one product page per effect,
 * written to sell it the way a commercial plugin's page does: a hero with the
 * faceplate, an overview with a bulleted list of what it does, before / after
 * audio on real material, an interactive screenshot, and the facts.
 *
 * ── WHAT THIS SHARES WITH THE HELP PAGES, AND WHY ───────────────────────────
 * Keyed by the same window ids, at the same URL slug (`helpSlug`: the product
 * name), with the same screenshots (`npm run help:shots`). The interactive
 * screenshot's hotspots ARE the help entry's controls: a hotspot's label and
 * text come from `src/content/help/<id>.js`, so the sales page and the manual
 * cannot describe the same knob two ways. `hotspots` below only picks which
 * controls get one and may reword the sentence for a buyer rather than a user.
 *
 * Like the help pages it is data, not markup, and the page imports nothing from
 * the editor. Only effects listed here get a page; start small (owner, November
 * 2026: LA Vintage 2A and VoxPressor first, to settle the design).
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 *   feature    string    Optional. The plan feature that gates its Apply
 *                        (`src/auth/plans.js`); absent = free. The page reads
 *                        the plan from there, so pricing copy cannot drift
 *   eyebrow    string    The kind of effect, above the name (`Opto compressor`)
 *   headline   string    The hero line: the one promise, in a few words
 *   pitch      string[]  1 short paragraph under it (the hero is a glance)
 *   description string   ≤ 160 characters, for <meta name="description"> and
 *                        social cards. Required: it is what a search result shows
 *   overviewTitle string The OVERVIEW section's heading: a short line of the
 *                        page's own (`A modern take on a studio classic`), not
 *                        the word "Overview" (owner, November 2026)
 *   overview   string[]  Its text, exactly 2 paragraphs, the first a brighter
 *                        lead, the second softer; heading, text and list share
 *                        one centred 960 px block, heading and text centred
 *                        line by line (owner, November 2026). Short:
 *                        what it is and what it is modelled on, then what it adds
 *   features   [{ title, text }]  The numbered list under it, two columns,
 *                        10–12 items (owner, November 2026): a title of a few words and a one-line
 *                        description in lower case with no full stop
 *   samples    [sample]  The before / after clips (see below)
 *   hotspots   [{ shot, text? }]  Controls on the screenshot, by help `shot` id;
 *                        `text` overrides the help sentence
 *   specs      [{ label, value }] The facts box
 *
 * ── A SAMPLE ────────────────────────────────────────────────────────────────
 *
 *   id         string    File name: `marketing/samples/<slug>/<id>.wav` is the
 *                        DRY source; `npm run marketing:render` writes the pair
 *                        the page plays (`public/effects/<slug>/audio/`)
 *   title      string    What the listener is hearing (`Uneven narration`)
 *   text       string    One sentence: what to listen for
 *   settings   object    PANEL params over the effect's defaults, as Apply
 *                        would use them. Empty = the factory default
 *   setting    string    How the settings read on the panel, for the caption
 *   brief      string    NOT SHOWN: what to record for this slot, so the clip
 *                        demonstrates the thing the caption promises
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * A buyer reads this, not a user, so it sells. SOUND FIRST (owner, November
 * 2026): plugin buyers want a result they can hear, so the headline, the lead
 * paragraph and the top of the feature list are the character and what it does
 * for a voice. Convenience — input alignment, auto makeup, guards, lookahead —
 * is the reason it is EASY to get that sound: one sentence in the second
 * paragraph and the bottom of the list, never the pitch.
 *
 * For an EMULATION (LA Vintage 2A, LA Classic 76, Air Boost, Cambridge
 * Inflator) borrow freely from what is commonly said about the original —
 * smooth, warm, forward, the sound of countless records — and promise that
 * kind of outcome, never a replica ("indistinguishable from", "the LA-2A
 * sound"). Facts about our own DSP must still be ones it keeps (CLAUDE.md is
 * the record): no invented comparisons, no "best", no hardware we did not
 * model. Hardware names identify what was studied and the footer says so.
 */

import optoSmooth from './opto-smooth.js'
import voxPressor from './vox-pressor.js'
import normalize from './normalize.js'
import loudness from './loudness.js'
import autoLeveler from './auto-leveler.js'
import softClipper from './soft-clipper.js'
import fetPunch from './fet-punch.js'
import inflator from './inflator.js'
import manualEq from './manual-eq.js'
import airBand from './air-band.js'
import phatass from './phatass.js'
import saturationBench from './saturation-bench.js'
import noiseReduction from './noise-reduction.js'
import deEsser from './de-esser.js'
import hfLimiter from './hf-limiter.js'
import resonanceSuppressor from './resonance-suppressor.js'
import humRemover from './hum-remover.js'
import { HELP_META, helpSlug } from '../help/meta.js'

export const MARKETING = {
  'opto-smooth': optoSmooth,
  'vox-pressor': voxPressor,
  'normalize': normalize,
  'loudness': loudness,
  'auto-leveler': autoLeveler,
  'soft-clipper': softClipper,
  'fet-punch': fetPunch,
  'inflator': inflator,
  'manual-eq': manualEq,
  'air-band': airBand,
  'phatass': phatass,
  'saturation-bench': saturationBench,
  'noise-reduction': noiseReduction,
  'de-esser': deEsser,
  'hf-limiter': hfLimiter,
  'resonance-suppressor': resonanceSuppressor,
  'hum-remover': humRemover,
}

/** A page's URL segment: the help page's, the product name. */
export function marketingSlug(windowId) {
  return helpSlug(windowId)
}

/** The page's URL. Trailing slash: built as `effects/<slug>/index.html`. */
export function marketingUrl(windowId) {
  return `/effects/${marketingSlug(windowId)}/`
}

const ID_BY_SLUG = new Map(Object.keys(MARKETING).map(id => [marketingSlug(id), id]))

/** The window id a URL segment names, or null. */
export function marketingIdForSlug(slug) {
  return ID_BY_SLUG.get(slug) ?? null
}

/** The product name the page is about (the registry's label, via the help index). */
export function marketingTitle(windowId) {
  return HELP_META[windowId].title
}

/** The page's <title>: the name, what it is, the site. Also the social card's title. */
export function marketingPageTitle(windowId) {
  return `${marketingTitle(windowId)} — ${MARKETING[windowId].eyebrow} plugin | crisp.fm`
}

/**
 * The ids with a page in this build. A marketing page for an effect production
 * hides would advertise something nobody can open, so dev-only effects get one
 * only in a dev build — the help pages' rule.
 */
export function publishedMarketingIds(devBuild) {
  // In the help index's order (the toolbar's: Level, Dynamics, Tone, Fix).
  return Object.keys(HELP_META).filter(id => MARKETING[id] && (devBuild || HELP_META[id].release !== 'dev'))
}

// ── The editor's try-out link ───────────────────────────────────────────────

/**
 * The link that opens the EDITOR with a sample loaded, selected, its effect
 * open at the sample's settings and playing — "Try it on this clip". The
 * editor reads it with `tryOutFromSearch`; both live here so the marketing page
 * and the editor cannot disagree about its shape.
 */
export function tryOutUrl(windowId, sampleId) {
  return `/?try=${encodeURIComponent(marketingSlug(windowId))}&clip=${encodeURIComponent(sampleId)}`
}

/** Where a sample's DRY take is served (`npm run marketing:render`). */
export function sampleDryUrl(windowId, sampleId) {
  return `/effects/${marketingSlug(windowId)}/audio/${sampleId}-off.mp3`
}

/**
 * What a try-out link asks for, or null if it asks for nothing this build
 * has: `{ windowId, title, sample: { id, title, setting, settings }, url }`.
 * A clip name is only ever looked up in the page's own sample list, so the
 * link cannot point the editor at an arbitrary URL.
 */
/**
 * Effects a try-out cannot just play: Peak and Loudness Normalize have no live
 * preview (the change is heard after Apply), and Hum Remover hears nothing
 * until Analyse has found the hum. The editor opens these without starting
 * playback and says which button comes first.
 */
export const TRY_OUT_FIRST_STEP = {
  'normalize': 'apply',
  'loudness': 'apply',
  'hum-remover': 'analyse',
}

export function tryOutFromSearch(search, devBuild = false) {
  let params
  try { params = new URLSearchParams(search || '') } catch { return null }
  const slug = params.get('try')
  if (!slug) return null
  const windowId = marketingIdForSlug(slug)
  if (!windowId || !publishedMarketingIds(devBuild).includes(windowId)) return null
  const samples = MARKETING[windowId].samples ?? []
  const clip = params.get('clip')
  const sample = (clip ? samples.find(s => s.id === clip) : samples[0]) ?? null
  if (!sample) return null
  return {
    windowId,
    title: marketingTitle(windowId),
    sample: { id: sample.id, title: sample.title, setting: sample.setting, settings: { ...(sample.settings ?? {}) } },
    url: sampleDryUrl(windowId, sample.id),
    firstStep: TRY_OUT_FIRST_STEP[windowId] ?? null,
  }
}

/**
 * A control's box (`at`, measured on the whole window) on the faceplate crop
 * (`face`: its size and offset in the window), clamped to the face — or null
 * when most of it lies off the face (a control in the window's header). A box
 * a few pixels over the edge is kept: LA Vintage 2A's meter bezel starts 2 px
 * into the header.
 */
export function spotOnFace(at, face) {
  const x0 = Math.max(0, at.x - face.x), y0 = Math.max(0, at.y - face.y)
  const x1 = Math.min(face.w, at.x - face.x + at.w), y1 = Math.min(face.h, at.y - face.y + at.h)
  if (x1 <= x0 || y1 <= y0) return null
  return (x1 - x0) * (y1 - y0) >= 0.5 * at.w * at.h ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}
