/**
 * Per-effect MARKETING pages — `/plugins/<slug>/`, one product page per effect,
 * written to sell it the way a commercial plugin's page does: a hero with the
 * faceplate, before / after audio on real material, an interactive screenshot,
 * what makes it different, and the facts.
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
 *   pitch      string[]  1–2 short paragraphs under it
 *   description string   ≤ 160 characters, for <meta name="description"> and
 *                        social cards. Required: it is what a search result shows
 *   highlights [{ title, text }]  3–6 selling points, each one true and specific
 *   samples    [sample]  The before / after clips (see below)
 *   hotspots   [{ shot, text? }]  Controls on the screenshot, by help `shot` id;
 *                        `text` overrides the help sentence
 *   specs      [{ label, value }] The facts box
 *   related    string[]  Window ids of other effects with a page
 *
 * ── A SAMPLE ────────────────────────────────────────────────────────────────
 *
 *   id         string    File name: `marketing/samples/<slug>/<id>.wav` is the
 *                        DRY source; `npm run marketing:render` writes the pair
 *                        the page plays (`public/plugins/<slug>/audio/`)
 *   title      string    What the listener is hearing (`Uneven narration`)
 *   text       string    One sentence: what to listen for
 *   settings   object    PANEL params over the effect's defaults, as Apply
 *                        would use them. Empty = the factory default
 *   setting    string    How the settings read on the panel, for the caption
 *   brief      string    NOT SHOWN: what to record for this slot, so the clip
 *                        demonstrates the thing the caption promises
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * A buyer reads this, not a user, so it may sell — but every claim must be one
 * the DSP keeps (CLAUDE.md is the record). No invented comparisons, no "best",
 * no hardware we did not model. Hardware names identify what was studied and
 * the footer says so.
 */

import optoSmooth from './opto-smooth.js'
import voxPressor from './vox-pressor.js'
import { HELP_META, helpSlug } from '../help/index.js'

export const MARKETING = {
  'opto-smooth': optoSmooth,
  'vox-pressor': voxPressor,
}

/** A page's URL segment: the help page's, the product name. */
export function marketingSlug(windowId) {
  return helpSlug(windowId)
}

/** The page's URL. Trailing slash: built as `plugins/<slug>/index.html`. */
export function marketingUrl(windowId) {
  return `/plugins/${marketingSlug(windowId)}/`
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
  return Object.keys(MARKETING).filter(id => devBuild || HELP_META[id]?.release !== 'dev')
}
