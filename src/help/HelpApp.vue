<script setup>
/**
 * The standalone help pages — `/help/` (the index) and `/help/<window-id>/`.
 *
 * Opened in a new tab from a plugin window's `?`. Help used to be an overlay
 * inside the window, which was cramped and read differently in every window
 * because no two are the same size. Here it has a page of its own: one reading
 * width, one layout, and it stays open beside the editor while the user works.
 *
 * It renders `src/content/help/<window-id>.js` and owns how that content looks;
 * the content files hold no markup (see `src/content/help/index.js`). It imports
 * nothing from the editor.
 *
 * Navigation between pages is ordinary links and full page loads: the pages are
 * small, and a link is what a user expects to be able to open in another tab,
 * bookmark or send to someone.
 */
import { computed, onMounted, ref } from 'vue'
import {
  HELP, HELP_META, HELP_CATEGORIES, publishedHelpIds, listedHelpIds, helpUrl, helpIdForSlug,
} from '../content/help/index.js'
import { helpPage } from '../content/help/tour.js'
// The marketing pages' interactive faceplate. A self-contained component (it
// imports nothing), so the help bundle still carries none of the editor.
import PanelTour from '../components/tour/PanelTour.vue'
import { DEV_TUNING_PANELS } from '../devFlags.js'
import { helpSlugFromPath } from './route.js'

/**
 * Which pages this build serves (dev-only effects only in a dev build, so their
 * `?` works there) and which the index and sidebar LIST — shipping effects
 * only, in every build: a help list is not where unreleased work shows up.
 */
const published = new Set(publishedHelpIds(DEV_TUNING_PANELS))
const listed = new Set(listedHelpIds())

/**
 * Screenshots, from `npm run help:shots`: `src/content/help/shots/<id>.json`
 * says which images exist and their CSS size (the files are 2x). An effect
 * with no manifest yet simply has no pictures.
 */
const SHOTS = Object.fromEntries(
  Object.entries(import.meta.glob('../content/help/shots/*.json', { eager: true, import: 'default' }))
    .map(([path, m]) => [path.replace(/^.*\/(.+)\.json$/, '$1'), m]),
)

const slug = helpSlugFromPath(window.location.pathname)
const id = slug ? helpIdForSlug(slug) : null
const entry = id && published.has(id) ? HELP[id] : null
const meta = entry ? HELP_META[id] : null
const notFound = !!slug && !entry
const shots = entry ? SHOTS[id] ?? null : null

/**
 * The controls in panel order, bucketed under their `group` heading where they
 * have one. Consecutive entries only: a group that recurs further down is a
 * second section on the panel, not the first one continued.
 */
const controlGroups = []
// The page's controls with the window's own around them (header first, footer
// last) and its tour, from one merge (`helpPage`), so the entries and the
// tour's numbers cannot drift apart.
const page = entry ? helpPage(entry.controls, shots) : { controls: [], tour: null }
const pageControls = page.controls
for (const c of pageControls) {
  const last = controlGroups[controlGroups.length - 1]
  if (last && last.group === (c.group ?? null)) last.controls.push(c)
  else controlGroups.push({ group: c.group ?? null, controls: [c] })
}

/**
 * The tour (every page with enough numbered controls, `helpTour`): the faceplate with every
 * documented control outlined and numbered, in place of the static window
 * picture. Each numbered control's entry below carries the same number, and
 * the two link both ways — the caption jumps to the entry, the entry's number
 * lights the control on the faceplate and scrolls back up to it.
 */
const pageTour = page.tour
const tourShot = pageTour?.image ?? null
const tourSpots = pageTour?.spots ?? []
const tourIndex = new Map(tourSpots.map((s, i) => [s.id, i]))
const tourActive = ref(0)
const tourEl = ref(null)
const tour = ref(null)

/** The control's number on the tour, or null when it has no hotspot. */
function tourNumber(c) {
  const i = c.shot ? tourIndex.get(c.shot) : undefined
  return i === undefined ? null : i + 1
}
/** An entry's anchor: the control's shot id, which the tour links to. */
const controlAnchor = c => (c.shot && tourIndex.has(c.shot) ? `control-${c.shot}` : undefined)
const detailHref = s => `#control-${s.id}`

/**
 * An entry's number: select its control, move keyboard focus onto it (a
 * keyboard user was left down on the entry while the page scrolled away) and
 * bring the faceplate into view.
 */
function showOnPanel(c) {
  tour.value?.focusSpot(tourIndex.get(c.shot))
  tourEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
/**
 * The entry's highlight is a `:target` animation, which plays once per hash:
 * following the same "Full description" link twice scrolled to the entry
 * with no highlight the second time. Restart it.
 */
function replayTarget(e) {
  const a = e.target.closest?.('a.pt-caption-more')
  if (!a || a.getAttribute('href') !== window.location.hash) return
  const el = document.getElementById(window.location.hash.slice(1))
  if (!el) return
  el.style.animation = 'none'
  void el.offsetWidth
  el.style.animation = ''
}

/**
 * The window picture's corners, rounded as the window's are (`radius`, recorded
 * by help:shots). panel.jpg is a rectangle, and its corners hold what sat
 * behind the window in the editor — at the page's old fixed 14 px a sliver of
 * the cyan waveform showed in each. In percent, so it scales with the image.
 */
function panelRadius(p) {
  if (!p?.radius) return null
  return { borderRadius: `${(p.radius / p.w) * 100}% / ${(p.radius / p.h) * 100}%` }
}

/** A crop for a control, or null; CSS size capped so a wide strip fits. */
function crop(c) {
  const m = c.shot && shots?.controls?.[c.shot]
  if (!m) return null
  const scale = Math.min(1, 240 / m.w, 200 / m.h)
  return { src: m.src, w: Math.round(m.w * scale), h: Math.round(m.h * scale) }
}
/** The sidebar and the index: listed pages bucketed by category, in order. */
const groups = HELP_CATEGORIES
  .map(c => ({
    ...c,
    pages: Object.keys(HELP_META)
      .filter(k => listed.has(k) && HELP_META[k].category === c.id)
      .map(k => ({ id: k, title: HELP_META[k].title, summary: HELP[k].summary, href: helpUrl(k) })),
  }))
  .filter(g => g.pages.length)

const categoryLabel = computed(() =>
  meta ? HELP_CATEGORIES.find(c => c.id === meta.category)?.label ?? '' : '',
)

/**
 * Order: the intro (what it is and what it is for), the quick start, the interface and
 * each control (the manuals' layout — Waves' CLA-2A guide is the model), then
 * the caveats.
 */

onMounted(() => {
  document.title = meta
    ? `${meta.title} help — crisp.fm`
    : notFound ? 'Help page not found — crisp.fm' : 'Effect help — crisp.fm'
})
</script>

<template>
  <div class="hp">
    <header class="hp-top">
      <a href="/help/" class="hp-brand" aria-label="All effect help">
        <img src="/crisp-fm-logo.png" alt="crisp.fm" class="hp-logo" draggable="false" />
        <span class="hp-rule" aria-hidden="true"></span>
        <span class="hp-brand-word">Help</span>
      </a>
      <a href="/" class="hp-editor">Open the editor</a>
    </header>

    <div class="hp-body" :class="{ 'hp-body--index': !entry }">
      <!-- The sidebar: every page, so moving from one effect to its neighbour
           is one click. On the index the cards already are the list. -->
      <nav v-if="entry" class="hp-nav" aria-label="Effects">
        <a href="/help/" class="hp-nav-all">All effects</a>
        <div v-for="g in groups" :key="g.label" class="hp-nav-group">
          <div class="hp-nav-heading">{{ g.label }}</div>
          <a
            v-for="p in g.pages"
            :key="p.id"
            :href="p.href"
            class="hp-nav-link"
            :class="{ 'hp-nav-link--on': p.id === id }"
            :aria-current="p.id === id ? 'page' : undefined"
          >{{ p.title }}</a>
        </div>
      </nav>

      <main class="hp-main">
        <!-- ── One effect ─────────────────────────────────────────────── -->
        <article v-if="entry" class="hp-article">
          <nav class="hp-crumbs" aria-label="Breadcrumb">
            <a href="/help/">Help</a>
            <span aria-hidden="true">›</span>
            <span>{{ categoryLabel }}</span>
          </nav>
          <h1 class="hp-title">{{ meta.title }}</h1>
          <p class="hp-summary">{{ entry.summary }}</p>

          <!-- The tour sits above the fold, before the intro (owner, November
               2026): the panel is what a reader came to look at. The entries it
               numbers stay under Interface and controls, linked both ways. -->
          <div v-if="tourSpots.length" ref="tourEl" class="hp-tour" @click="replayTarget">
            <p class="hp-tour-lede">Hint: Click on any numbered control to see what it does.</p>
            <PanelTour
              ref="tour"
              eager
              v-model:active="tourActive"
              :image="tourShot"
              :spots="tourSpots"
              :list="false"
              :detail-href="detailHref"
              :alt="`The ${meta.title} faceplate`"
            />
          </div>

          <section class="hp-section">
            <h2 class="hp-heading">Intro</h2>
            <p v-for="(para, i) in entry.intro" :key="i" class="hp-intro-text">{{ para }}</p>
          </section>

          <section class="hp-section">
            <h2 class="hp-heading">Quick start</h2>
            <ol class="hp-list hp-list--ordered">
              <li v-for="(item, i) in entry.quickStart" :key="i">{{ item }}</li>
            </ol>
          </section>

          <section class="hp-section">
            <h2 class="hp-heading">Interface and controls</h2>
            <figure v-if="!tourSpots.length && shots?.panel" class="hp-panel">
              <img
                :src="shots.panel.src"
                :width="shots.panel.w"
                :height="shots.panel.h"
                :style="panelRadius(shots.panel)"
                :alt="`The ${meta.title} window`"
                loading="lazy"
              />
            </figure>

            <template v-for="(g, gi) in controlGroups" :key="gi">
              <h3 v-if="g.group" class="hp-group">{{ g.group }}</h3>
              <div class="hp-controls">
                <div
                  v-for="c in g.controls"
                  :id="controlAnchor(c)"
                  :key="c.label"
                  class="hp-control"
                  :class="{ 'hp-control--shot': crop(c) }"
                >
                  <div v-if="crop(c)" class="hp-crop">
                    <img
                      :src="crop(c).src"
                      :width="crop(c).w"
                      :height="crop(c).h"
                      :alt="`${c.label} control`"
                      loading="lazy"
                    />
                  </div>
                  <div class="hp-control-body">
                    <h4 class="hp-control-label">
                      <button
                        v-if="tourNumber(c)"
                        type="button"
                        class="hp-control-n"
                        :aria-label="`Show ${c.label} on the panel`"
                        title="Show on the panel"
                        @click="showOnPanel(c)"
                      >{{ tourNumber(c) }}</button>
                      {{ c.label }}
                    </h4>
                    <p class="hp-control-text">{{ c.text }}</p>
                    <p v-for="(d, di) in c.details ?? []" :key="di" class="hp-control-detail">{{ d }}</p>
                    <dl v-if="c.range || c.default" class="hp-spec">
                      <template v-if="c.range">
                        <dt>Range</dt>
                        <dd>{{ c.range }}</dd>
                      </template>
                      <template v-if="c.default">
                        <dt>Default</dt>
                        <dd>{{ c.default }}</dd>
                      </template>
                    </dl>
                  </div>
                </div>
              </div>
            </template>
          </section>

          <section v-if="entry.notes && entry.notes.length" class="hp-section">
            <h2 class="hp-heading">Worth knowing</h2>
            <ul class="hp-list">
              <li v-for="(item, i) in entry.notes" :key="i">{{ item }}</li>
            </ul>
          </section>
        </article>

        <!-- ── Not found ──────────────────────────────────────────────── -->
        <div v-else-if="notFound" class="hp-article">
          <h1 class="hp-title">No help page here</h1>
          <p class="hp-summary">There is no effect called “{{ slug }}”. Pick one from the list below</p>
        </div>

        <!-- ── The index ──────────────────────────────────────────────── -->
        <template v-if="!entry">
          <div v-if="!notFound" class="hp-intro">
            <h1 class="hp-title">Effect help</h1>
            <p class="hp-summary">What each effect does, when to reach for it and what every control on its panel means</p>
          </div>
          <section v-for="g in groups" :key="g.label" class="hp-index-group">
            <h2 class="hp-heading">{{ g.label }}</h2>
            <div class="hp-cards">
              <a v-for="p in g.pages" :key="p.id" :href="p.href" class="hp-card">
                <span class="hp-card-title">{{ p.title }}</span>
                <span class="hp-card-text">{{ p.summary }}</span>
              </a>
            </div>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>

<style>
/* Page-level: this entry has no main.css, so the document is styled here. */
html,
body {
  margin: 0;
  background: #0b0e12;
  color: #eaf6f8;
  -webkit-font-smoothing: antialiased;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}
</style>

<style scoped>
.hp {
  --hp-bg: #0b0e12;
  --hp-chrome: #0e1216;
  --hp-surface: #141920;
  --hp-surface-hover: #1a2029;
  --hp-hairline: rgba(255, 255, 255, 0.08);
  --hp-text: #eaf6f8;
  --hp-soft: rgba(234, 246, 248, 0.68);
  --hp-muted: rgba(234, 246, 248, 0.42);
  --hp-accent: #35d3e6;

  min-height: 100vh;
  font: 400 15px/1.6 'Inter', system-ui, sans-serif;
  color: var(--hp-text);
}

a {
  color: inherit;
  text-decoration: none;
}
a:focus-visible {
  outline: 2px solid var(--hp-accent);
  outline-offset: 2px;
  border-radius: 6px;
}

/* ── Top bar ─────────────────────────────────────────────────────────────── */
.hp-top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 20px;
  background: var(--hp-chrome);
  border-bottom: 1px solid var(--hp-hairline);
}
.hp-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.hp-logo {
  height: 22px;
  width: auto;
  user-select: none;
}
.hp-rule {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.18);
}
.hp-brand-word {
  font: 600 14px/1 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
}
.hp-editor {
  padding: 7px 12px;
  border-radius: 10px;
  font: 500 13px/1 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  white-space: nowrap;
}
.hp-editor:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--hp-text);
}

/* ── Layout ──────────────────────────────────────────────────────────────── */
.hp-body {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 48px;
  max-width: 1080px;
  margin: 0 auto;
  padding: 40px 24px 80px;
}
.hp-body--index {
  grid-template-columns: minmax(0, 1fr);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
.hp-nav {
  position: sticky;
  top: 96px;
  align-self: start;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.hp-nav-all {
  display: block;
  margin-bottom: 18px;
  font: 500 13px/1 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
}
.hp-nav-all::before {
  content: '← ';
}
.hp-nav-all:hover {
  color: var(--hp-text);
}
.hp-nav-group + .hp-nav-group {
  margin-top: 18px;
}
.hp-nav-heading {
  margin-bottom: 6px;
  font: 700 10px/1 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hp-muted);
}
.hp-nav-link {
  display: block;
  padding: 5px 10px;
  margin-left: -10px;
  border-radius: 8px;
  font: 400 13.5px/1.35 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
}
.hp-nav-link:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--hp-text);
}
.hp-nav-link--on {
  background: rgba(53, 211, 230, 0.1);
  color: var(--hp-accent);
  font-weight: 500;
}

/* ── Article ─────────────────────────────────────────────────────────────── */
.hp-article,
.hp-intro {
  max-width: 820px;
}
.hp-crumbs {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  font: 500 12px/1 'Inter', system-ui, sans-serif;
  color: var(--hp-muted);
}
.hp-crumbs a:hover {
  color: var(--hp-text);
}
.hp-title {
  margin: 0;
  font: 700 32px/1.15 'Inter', system-ui, sans-serif;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.hp-summary {
  margin: 12px 0 0;
  font: 400 18px/1.5 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
  text-wrap: pretty;
}

.hp-section {
  margin-top: 40px;
}
.hp-heading {
  margin: 0 0 14px;
  font: 700 11px/1 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hp-muted);
}

.hp-list {
  margin: 0;
  padding-left: 22px;
  list-style: disc outside;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--hp-soft);
}
.hp-list li::marker {
  color: rgba(255, 255, 255, 0.3);
}
.hp-list--ordered {
  list-style: decimal outside;
  font-variant-numeric: tabular-nums;
}

/* The intro: prose, at full reading colour. */
.hp-intro-text {
  margin: 0;
  color: var(--hp-soft);
  text-wrap: pretty;
}
.hp-intro-text + .hp-intro-text {
  margin-top: 12px;
}

/* The interface image: the whole window, at most its own 1x width. */
.hp-panel {
  margin: 0 0 28px;
}
.hp-panel img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 14px;
  box-shadow: 0 0 0 1px var(--hp-hairline), 0 18px 40px rgba(0, 0, 0, 0.45);
}

/* The tour: the faceplate, numbered. Its colours come from PanelTour's
   defaults, which are this page's palette. */
.hp-tour {
  margin: 28px 0 0;
  scroll-margin-top: 76px;
}
.hp-tour-lede {
  margin: 0 0 14px;
  color: var(--hp-soft);
  font-size: 12px;
}
/* An entry the tour's caption jumped to: clear of the sticky bar, and lit. */
.hp-control[id] {
  scroll-margin-top: 84px;
}
/* Held lit for a beat, then faded: an amber block grown 12 px past the entry
   (box-shadow spread, so the layout does not move) with an amber ring. The
   first version was a 12 % tint fading over 1.6 s and was easy to miss. */
.hp-control:target {
  border-radius: 10px;
  outline: 1.5px solid transparent;
  outline-offset: 12px;
  animation: hp-target 3.2s ease-in forwards;
}
@keyframes hp-target {
  0%,
  45% {
    background-color: rgba(232, 163, 61, 0.2);
    box-shadow: 0 0 0 12px rgba(232, 163, 61, 0.2);
    outline-color: rgba(232, 163, 61, 0.9);
  }
  100% {
    background-color: rgba(232, 163, 61, 0);
    box-shadow: 0 0 0 12px rgba(232, 163, 61, 0);
    outline-color: rgba(232, 163, 61, 0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .hp-control:target { animation: none; outline-color: rgba(232, 163, 61, 0.9); }
}
/* The control's tour number, amber like the tour; a button back up to it. */
.hp-control-n {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  margin-right: 8px;
  padding: 0 5px;
  vertical-align: 1px;
  border: 1px solid rgba(232, 163, 61, 0.5);
  border-radius: 11px;
  background: rgba(11, 14, 18, 0.9);
  color: #e8a33d;
  font: 600 11px/1 'JetBrains Mono', monospace;
  letter-spacing: 0;
  cursor: pointer;
}
.hp-control-n:hover,
.hp-control-n:focus-visible {
  background: #e8a33d;
  color: #06181b;
  outline: none;
}

/* A panel section (DE-ESS, AIR…), as printed. */
.hp-group {
  margin: 28px 0 0;
  padding-bottom: 8px;
  font: 700 12px/1 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--hp-accent);
  border-bottom: 1px solid var(--hp-hairline);
}

/* One row per control: its crop beside its entry, the manuals' layout. */
.hp-controls {
  margin: 0;
}
.hp-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  padding: 20px 0;
  border-bottom: 1px solid var(--hp-hairline);
}
.hp-control--shot {
  grid-template-columns: 240px minmax(0, 1fr);
}
.hp-crop {
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
.hp-crop img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  box-shadow: 0 0 0 1px var(--hp-hairline);
}
.hp-control-label {
  margin: 0;
  font: 700 13px/1.4 'JetBrains Mono', monospace;
  letter-spacing: 0.06em;
  color: var(--hp-text);
}
.hp-control-text {
  margin: 6px 0 0;
  color: var(--hp-text);
}
.hp-control-detail {
  margin: 8px 0 0;
  color: var(--hp-soft);
  font-size: 14px;
}

/* Range / Default, as a small spec table. */
.hp-spec {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 14px;
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--hp-surface);
  font: 400 13px/1.45 'Inter', system-ui, sans-serif;
}
.hp-spec dt {
  font: 700 10px/1.9 'JetBrains Mono', monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--hp-muted);
}
.hp-spec dd {
  margin: 0;
  color: var(--hp-soft);
  font-variant-numeric: tabular-nums;
}

/* ── Index ───────────────────────────────────────────────────────────────── */
.hp-intro {
  margin-bottom: 8px;
}
.hp-index-group {
  margin-top: 40px;
}
.hp-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.hp-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  border-radius: 14px;
  background: var(--hp-surface);
  box-shadow: inset 0 0 0 1px var(--hp-hairline);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.hp-card:hover {
  background: var(--hp-surface-hover);
  box-shadow: inset 0 0 0 1px rgba(53, 211, 230, 0.35);
}
.hp-card-title {
  font: 600 15px/1.3 'Inter', system-ui, sans-serif;
  color: var(--hp-text);
}
.hp-card-text {
  font: 400 13.5px/1.5 'Inter', system-ui, sans-serif;
  color: var(--hp-soft);
}

/* ── Narrow screens ──────────────────────────────────────────────────────── */
@media (max-width: 860px) {
  .hp-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    padding: 28px 16px 64px;
  }
  /* The sidebar would push the article below a screen of links; the
     breadcrumb and the brand mark both lead back to the index instead. */
  .hp-nav {
    display: none;
  }
  .hp-title {
    font-size: 26px;
  }
  .hp-summary {
    font-size: 16px;
  }
  .hp-control--shot {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .hp-crop {
    justify-content: flex-start;
  }
  .hp-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
