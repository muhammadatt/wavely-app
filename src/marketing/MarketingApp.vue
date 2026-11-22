<script setup>
/**
 * The effect marketing pages — `/effects/` (the index) and `/effects/<slug>/`.
 *
 * A product page per effect, laid out like a commercial plugin's: the hero with
 * the faceplate, "Hear it" (before / after on real material, `ABPlayer` —
 * the audio comes first, owner, November 2026), the Overview (a centred
 * heading and two paragraphs over a numbered list of features, one 960 px block), the interactive screenshot
 * (`PanelTour`), the facts and a call to open the editor. It renders `src/content/marketing/<id>.js`, borrows
 * the control descriptions and screenshots from the help pages, and imports
 * nothing from the editor.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  MARKETING, marketingIdForSlug, marketingPageTitle, marketingTitle, marketingUrl, publishedMarketingIds, spotOnFace, tryOutUrl,
} from '../content/marketing/index.js'
import { HELP, helpUrl } from '../content/help/index.js'
import { isOffline, requiredPlan } from '../auth/plans.js'
import { DEV_TUNING_PANELS } from '../devFlags.js'
import { marketingSlugFromPath } from './route.js'
import ABPlayer from './ABPlayer.vue'
import PanelTour from '../components/tour/PanelTour.vue'
import ConsentBar from '../components/consent/ConsentBar.vue'
import { consent } from '../platform/consent.js'

const SHOTS = Object.fromEntries(
  Object.entries(import.meta.glob('../content/help/shots/*.json', { eager: true, import: 'default' }))
    .map(([path, m]) => [path.replace(/^.*\/(.+)\.json$/, '$1'), m]),
)
const AUDIO = Object.fromEntries(
  Object.entries(import.meta.glob('../content/marketing/audio/*.json', { eager: true, import: 'default' }))
    .map(([path, m]) => [path.replace(/^.*\/(.+)\.json$/, '$1'), m]),
)

const published = publishedMarketingIds(DEV_TUNING_PANELS)
const slug = marketingSlugFromPath(window.location.pathname)
const id = slug ? marketingIdForSlug(slug) : null
const page = id && published.includes(id) ? MARKETING[id] : null
const notFound = !!slug && !page
const title = page ? marketingTitle(id) : ''
const help = page ? HELP[id] : null
const shots = page ? SHOTS[id] ?? null : null

/** Free, or the plan that unlocks Apply (preview stays free for every real-time effect). */
const plan = page?.feature ? requiredPlan(page.feature) : 'free'
// Price only: "runs in your browser" is the pitch's to say, and saying it twice
// in the hero read as filler.
// An offline process (Auto Leveler, Noise Reduction) has no free preview.
const planNote = plan === 'free'
  ? 'Free to use'
  : isOffline(page.feature) ? 'Included with Pro' : 'Preview free · Apply with Pro'

/** Samples that have been rendered; a listed sample with no audio yet is left out. */
const samples = (page?.samples ?? [])
  .map(s => ({ ...s, audio: AUDIO[id]?.samples?.[s.id] }))
  .filter(s => s.audio)

/**
 * The two ways into the editor, kept apart so no two buttons with different
 * words go to the same place: TRY (the hero, and under the player) opens the
 * editor with a sample loaded and the effect on it (`tryOutUrl`); OPEN THE
 * EDITOR (top bar, and the "your own audio" panel) is the plain editor.
 */
const tryHref = s => tryOutUrl(id, s.id)
const heroTry = samples.length ? tryHref(samples[0]) : '/'

/** Hotspots: the help entry's control, placed by the screenshot manifest. */
/**
 * The product shot: the faceplate alone (`face.jpg`, no window header or
 * footer — the selection readout and Preview / Apply read as a screen grab),
 * falling back to the whole window for an effect shot before the crop existed.
 * `x` / `y` are the face's offset inside the window, which the hotspot boxes
 * (measured on the window) are shifted by.
 */
const shot = shots ? (shots.face ?? { ...shots.panel, x: 0, y: 0 }) : null

/** Hotspots: the help entry's control, placed by the screenshot manifest on the face. */
const spots = computed(() => {
  if (!page || !shot) return []
  return (page.hotspots ?? []).flatMap((h) => {
    const control = help?.controls.find(c => c.shot === h.shot)
    const raw = shots.controls?.[h.shot]?.at
    if (!control || !raw) return []
    // A control in the window's header (VoxPressor's faceplate switch) is not on the face.
    const at = spotOnFace(raw, shot)
    if (!at) return []
    return [{ id: h.shot, label: control.label, text: h.text ?? control.text, at }]
  })
})

const index = published.map(r => ({
  id: r, title: marketingTitle(r), eyebrow: MARKETING[r].eyebrow, headline: MARKETING[r].headline,
  href: marketingUrl(r), shot: SHOTS[r]?.face ?? SHOTS[r]?.panel,
}))

// The build writes the title into each page's HTML; the dev server serves one entry for all.
// "Your privacy choices" — shown wherever ad consent is live (opt-in and
// opt-out regions alike: it is how a choice is withdrawn or an opt-out made).
const consentLive = ref(false)
const stopConsent = consent.subscribe(s => { consentLive.value = s.ready && !s.inert })
onBeforeUnmount(stopConsent)

onMounted(() => {
  if (page) document.title = marketingPageTitle(id)
  else if (notFound) document.title = 'Effect not found — crisp.fm'
})
</script>

<template>
  <div class="mk">
    <header class="mk-top">
      <a href="/effects/" class="mk-brand" aria-label="All effects">
        <img src="/crisp-fm-logo.png" alt="crisp.fm" class="mk-logo" draggable="false" />
        <span class="mk-rule" aria-hidden="true"></span>
        <span class="mk-brand-word">Effects</span>
      </a>
      <nav class="mk-topnav">
        <a v-if="page" :href="helpUrl(id)" class="mk-toplink">Manual</a>
        <a href="/" class="mk-cta mk-cta--small">Open the editor</a>
      </nav>
    </header>

    <!-- ── One effect ───────────────────────────────────────────────────── -->
    <main v-if="page" class="mk-main">
      <section class="mk-hero">
        <div class="mk-hero-copy">
          <p class="mk-eyebrow">{{ page.eyebrow }}</p>
          <h1 class="mk-name">{{ title }}</h1>
          <p class="mk-headline">{{ page.headline }}</p>
          <p v-for="(p, i) in page.pitch" :key="i" class="mk-pitch">{{ p }}</p>
          <div class="mk-actions">
            <a :href="heroTry" class="mk-cta">{{ samples.length ? 'Try it on a sample' : 'Try it in your browser' }}</a>
            <a v-if="samples.length" href="#hear" class="mk-ghost">Hear it</a>
          </div>
          <p class="mk-plan" :class="{ 'mk-plan--pro': plan !== 'free' }">{{ planNote }}</p>
        </div>
        <div v-if="shot" class="mk-hero-shot">
          <img
            :src="shot.src" :width="shot.w" :height="shot.h"
            :alt="`The ${title} faceplate`" class="mk-hero-img" draggable="false"
          />
        </div>
      </section>

      <section v-if="samples.length" id="hear" class="mk-section">
        <h2 class="mk-h2">Hear it</h2>
        <p class="mk-lede">Real {{ title }} renders — the same processing Apply does in the editor. Switch it on and off while it plays.</p>
        <ABPlayer :samples="samples" :name="title" :try-href="tryHref" />
      </section>

      <!-- Owner, November 2026: the heading, both paragraphs and the numbered list
           share ONE centred 960 px block, the heading and paragraphs centred line by
           line (3b's left-edge column read as too weird). The heading is the page's own line. -->
      <section v-if="page.overview?.length || page.features?.length" class="mk-section mk-overview">
        <div class="mk-overview-head">
          <h2 class="mk-h2">{{ page.overviewTitle ?? 'Overview' }}</h2>
          <p
            v-for="(p, i) in page.overview" :key="i"
            class="mk-overview-text" :class="{ 'mk-overview-text--lead': i === 0 }"
          >{{ p }}</p>
        </div>
        <ol v-if="page.features?.length" class="mk-features">
          <li v-for="(f, i) in page.features" :key="f.title" class="mk-feature">
            <span class="mk-feature-n" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="mk-feature-body">
              <span class="mk-feature-title">{{ f.title }}</span>
              <span class="mk-feature-text">{{ f.text }}</span>
            </span>
          </li>
        </ol>
      </section>

      <section v-if="spots.length" class="mk-section">
        <h2 class="mk-h2">Take the tour</h2>
        <p class="mk-lede">Click any control to see what it does.</p>
        <PanelTour :image="shot" :spots="spots" :alt="`The ${title} faceplate`" />
      </section>

      <section class="mk-section mk-split">
        <div>
          <h2 class="mk-h2">At a glance</h2>
          <dl class="mk-specs">
            <template v-for="s in page.specs" :key="s.label">
              <dt>{{ s.label }}</dt>
              <dd>{{ s.value }}</dd>
            </template>
          </dl>
        </div>
        <aside class="mk-band">
          <h2 class="mk-band-title">Use it on your own audio</h2>
          <p class="mk-band-text">Open the editor, drop in your file, select a passage and open {{ title }}. Nothing to install.</p>
          <a href="/" class="mk-cta">Open the editor</a>
          <a :href="helpUrl(id)" class="mk-band-link">Read the {{ title }} manual</a>
        </aside>
      </section>

    </main>

    <!-- ── Not found ────────────────────────────────────────────────────── -->
    <main v-else-if="notFound" class="mk-main mk-empty">
      <h1 class="mk-name">There is no page for that effect.</h1>
      <p class="mk-pitch"><a href="/effects/">See every effect</a>.</p>
    </main>

    <!-- ── Index ────────────────────────────────────────────────────────── -->
    <main v-else class="mk-main">
      <section class="mk-index-head">
        <h1 class="mk-name">Effects</h1>
        <p class="mk-headline">Studio-grade vocal processing that runs in your browser.</p>
      </section>
      <div class="mk-related">
        <a v-for="r in index" :key="r.id" :href="r.href" class="mk-tile">
          <img v-if="r.shot" :src="r.shot.src" alt="" class="mk-tile-img" loading="lazy" />
          <span class="mk-tile-body">
            <span class="mk-eyebrow">{{ r.eyebrow }}</span>
            <span class="mk-tile-title">{{ r.title }}</span>
            <span class="mk-tile-text">{{ r.headline }}</span>
          </span>
        </a>
      </div>
    </main>

    <footer class="mk-footer">
      <p v-if="consentLive"><button type="button" class="mk-privacy" @click="consent.reopen()">Your privacy choices</button></p>
      <p>All product names are trademarks of their respective owners and are used only to identify the products whose sound was studied in developing these effects. crisp.fm is not affiliated with or endorsed by them.</p>
    </footer>
    <ConsentBar />
  </div>
</template>

<style>
html, body { margin: 0; background: #0b0e12; }
</style>

<style scoped>
.mk {
  --mk-bg: #0b0e12;
  --mk-surface: #141920;
  --mk-hairline: rgba(255, 255, 255, 0.08);
  --mk-text: #eaf6f8;
  --mk-soft: rgba(234, 246, 248, 0.7);
  --mk-muted: rgba(234, 246, 248, 0.45);
  --mk-accent: #35d3e6;
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 75% -10%, rgba(53, 211, 230, 0.10), transparent 60%),
    var(--mk-bg);
  color: var(--mk-text);
  font-family: Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }

.mk-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 32px;
  border-bottom: 1px solid var(--mk-hairline);
}
.mk-brand { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; }
.mk-logo { height: 22px; }
.mk-rule { width: 1px; height: 18px; background: rgba(255, 255, 255, 0.18); }
.mk-brand-word { font-weight: 600; font-size: 14px; color: var(--mk-soft); }
.mk-topnav { display: flex; align-items: center; gap: 18px; }
.mk-toplink { font-size: 14px; color: var(--mk-soft); text-decoration: none; }
.mk-toplink:hover { color: var(--mk-text); }

.mk-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 22px;
  border-radius: 12px;
  background: var(--mk-accent);
  color: #06181b;
  font-weight: 700;
  font-size: 15px;
  text-decoration: none;
  transition: filter 0.15s ease;
}
.mk-cta:hover { filter: brightness(1.1); }
.mk-cta--small { padding: 8px 14px; font-size: 13px; border-radius: 10px; }
.mk-ghost {
  display: inline-flex;
  align-items: center;
  padding: 12px 20px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
}
.mk-ghost:hover { background: rgba(255, 255, 255, 0.05); }

.mk-main { max-width: 1180px; margin: 0 auto; padding: 0 32px 64px; }

.mk-hero {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: 48px;
  align-items: center;
  padding: 64px 0 40px;
}
.mk-eyebrow {
  margin: 0;
  font: 600 12px 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mk-accent);
}
.mk-name { margin: 10px 0 0; font-size: 52px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; }
.mk-headline { margin: 14px 0 0; font-size: 22px; line-height: 1.35; font-weight: 600; color: var(--mk-text); }
.mk-pitch { margin: 14px 0 0; font-size: 16px; line-height: 1.6; color: var(--mk-soft); }
.mk-actions { display: flex; gap: 12px; margin-top: 28px; flex-wrap: wrap; }
.mk-plan { margin: 14px 0 0; font-size: 13px; color: var(--mk-muted); }
.mk-plan--pro { color: #f2c66d; }
.mk-hero-shot { perspective: 1600px; }
.mk-hero-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 14px;
  box-shadow: 0 40px 100px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--mk-hairline), 0 0 80px rgba(53, 211, 230, 0.08);
  transform: rotateY(-6deg) rotateX(2deg);
}

.mk-section { padding: 48px 0 8px; scroll-margin-top: 24px; }
.mk-h2 { margin: 0; font-size: 30px; font-weight: 800; letter-spacing: -0.01em; }
.mk-lede { margin: 8px 0 24px; font-size: 15px; color: var(--mk-soft); }

/* One centred 960 px block: heading, text and list share both edges; the heading
   and paragraphs are centred line by line (owner). */
.mk-overview { --mk-col-gap: 48px; max-width: 960px; margin-left: auto; margin-right: auto; }
.mk-overview-head {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  text-align: center;
}
.mk-overview-text { margin: 0; font-size: 16px; line-height: 1.7; color: var(--mk-soft); text-wrap: pretty; }
.mk-overview-text--lead { font-size: 18px; line-height: 1.6; color: var(--mk-text); }
.mk-features {
  list-style: none;
  /* The block's full width, so the list and the text share both edges. */
  margin: 44px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--mk-col-gap);
  border-top: 1px solid var(--mk-hairline);
}
.mk-feature {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--mk-hairline);
}
.mk-feature-n { font: 600 13px/21px 'JetBrains Mono', ui-monospace, monospace; color: var(--mk-accent); }
.mk-feature-body { display: flex; flex-direction: column; gap: 2px; }
.mk-feature-title { font-size: 15px; font-weight: 600; line-height: 1.4; }
.mk-feature-text { font-size: 14px; line-height: 1.5; color: var(--mk-soft); text-wrap: pretty; }

.mk-split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 40px; align-items: start; }
.mk-specs {
  display: grid;
  grid-template-columns: max-content 1fr;
  margin: 24px 0 0;
  border-top: 1px solid var(--mk-hairline);
}
.mk-specs dt, .mk-specs dd {
  margin: 0;
  padding: 12px 0;
  border-bottom: 1px solid var(--mk-hairline);
  font-size: 14.5px;
}
.mk-specs dt { color: var(--mk-muted); padding-right: 28px; }
.mk-band {
  margin-top: 24px;
  padding: 28px;
  border-radius: 18px;
  background: linear-gradient(160deg, rgba(53, 211, 230, 0.14), rgba(53, 211, 230, 0.03));
  border: 1px solid rgba(53, 211, 230, 0.3);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}
.mk-band-title { margin: 0; font-size: 22px; font-weight: 800; }
.mk-band-text { margin: 0; font-size: 15px; line-height: 1.55; color: var(--mk-soft); }
.mk-band-link { font-size: 14px; color: var(--mk-soft); }

.mk-related {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  margin-top: 24px;
}
.mk-tile {
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  overflow: hidden;
  background: var(--mk-surface);
  border: 1px solid var(--mk-hairline);
  text-decoration: none;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.mk-tile:hover { border-color: rgba(53, 211, 230, 0.45); transform: translateY(-2px); }
.mk-tile-img { display: block; width: 100%; height: 190px; object-fit: cover; object-position: top; }
.mk-tile-body { display: flex; flex-direction: column; gap: 6px; padding: 18px; }
.mk-tile-title { font-size: 19px; font-weight: 700; }
.mk-tile-text { font-size: 14px; color: var(--mk-soft); line-height: 1.5; }

.mk-index-head { padding: 56px 0 8px; }
.mk-empty { padding-top: 80px; }

.mk-footer {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 32px 40px;
  border-top: 1px solid var(--mk-hairline);
  font-size: 12px;
  line-height: 1.6;
  color: var(--mk-muted);
}

.mk-privacy {
  padding: 0;
  border: 0;
  background: none;
  color: var(--mk-soft);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.mk-privacy:hover { color: var(--mk-text); }

@media (max-width: 900px) {
  .mk-hero, .mk-split { grid-template-columns: 1fr; }
  .mk-hero { padding-top: 40px; gap: 32px; }
  .mk-hero-img { transform: none; }
  .mk-name { font-size: 40px; }
}
@media (max-width: 640px) {
  .mk-top { padding: 12px 16px; }
  .mk-main { padding: 0 16px 48px; }
  .mk-footer { padding: 20px 16px 32px; }
  .mk-toplink { display: none; }
  .mk-headline { font-size: 19px; }
  .mk-related { grid-template-columns: 1fr; }
  .mk-features { grid-template-columns: 1fr; margin-top: 36px; }
  .mk-overview-text--lead { font-size: 17px; }
}
</style>
