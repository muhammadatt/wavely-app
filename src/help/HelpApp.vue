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
import { computed, onMounted } from 'vue'
import { HELP, HELP_META, HELP_CATEGORIES, publishedHelpIds, helpUrl } from '../content/help/index.js'
import { DEV_TUNING_PANELS } from '../devFlags.js'
import { helpIdFromPath } from './route.js'

const published = new Set(publishedHelpIds(DEV_TUNING_PANELS))

const id = helpIdFromPath(window.location.pathname)
const entry = id && published.has(id) ? HELP[id] : null
const meta = entry ? HELP_META[id] : null
const notFound = !!id && !entry

/** The sidebar and the index: published pages bucketed by category, in order. */
const groups = HELP_CATEGORIES
  .map(c => ({
    ...c,
    pages: Object.keys(HELP_META)
      .filter(k => published.has(k) && HELP_META[k].category === c.id)
      .map(k => ({ id: k, title: HELP_META[k].title, summary: HELP[k].summary, href: helpUrl(k) })),
  }))
  .filter(g => g.pages.length)

const categoryLabel = computed(() =>
  meta ? HELP_CATEGORIES.find(c => c.id === meta.category)?.label ?? '' : '',
)

/**
 * Order: what it is, when to reach for it, how to work it, what each control
 * does, then the caveats. Ordered lists only where the order carries meaning.
 */
const leadSections = computed(() => entry ? [
  { key: 'when', heading: 'When to use it', items: entry.whenToUse },
  { key: 'steps', heading: 'How to use it', items: entry.steps, ordered: true },
] : [])

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

          <template v-for="s in leadSections" :key="s.key">
            <section v-if="s.items && s.items.length" class="hp-section">
              <h2 class="hp-heading">{{ s.heading }}</h2>
              <ol v-if="s.ordered" class="hp-list hp-list--ordered">
                <li v-for="(item, i) in s.items" :key="i">{{ item }}</li>
              </ol>
              <ul v-else class="hp-list">
                <li v-for="(item, i) in s.items" :key="i">{{ item }}</li>
              </ul>
            </section>
          </template>

          <section v-if="entry.controls && entry.controls.length" class="hp-section">
            <h2 class="hp-heading">The controls</h2>
            <dl class="hp-controls">
              <div v-for="c in entry.controls" :key="c.label" class="hp-control">
                <dt class="hp-control-label">{{ c.label }}</dt>
                <dd class="hp-control-text">{{ c.text }}</dd>
              </div>
            </dl>
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
          <p class="hp-summary">There is no effect called “{{ id }}”. Pick one from the list below</p>
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
  max-width: 720px;
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

/* Label over text, one row per control: the labels are short and the texts are
   long, so a two-column table would spend its width on the narrow side. */
.hp-controls {
  margin: 0;
  border-top: 1px solid var(--hp-hairline);
}
.hp-control {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--hp-hairline);
}
.hp-control-label {
  padding-top: 3px;
  font: 700 11.5px/1.4 'JetBrains Mono', monospace;
  letter-spacing: 0.06em;
  color: var(--hp-text);
}
.hp-control-text {
  margin: 0;
  color: var(--hp-soft);
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
  .hp-control {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .hp-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
