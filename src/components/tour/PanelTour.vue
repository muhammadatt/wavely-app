<script setup>
/**
 * The interactive screenshot: the faceplate with every documented control
 * outlined and numbered. Selecting a control (or its row in the list) lights
 * both and shows what it does — u-he's product pages are the model.
 *
 * The boxes are the controls' own, recorded by `npm run help:shots` (`at` in
 * the manifest, CSS pixels on the image), so a re-laid-out panel moves its
 * hotspots with it the next time the shots are taken. Positions are percentages
 * of the image, so the overlay scales with it at any width.
 *
 * The tour is AMBER (`--pt-accent`, the editor's selected-thing colour), not the
 * page's cyan accent (owner, November 2026).
 *
 * Shared by the marketing pages and the help pages, so it imports nothing but
 * its own geometry and reads its surface colours from optional `--tour-*`
 * properties on an ancestor (defaults are both pages' shared palette). The help
 * pages turn the side list off (their control entries below ARE the list),
 * link the caption to each control's full entry (`detailHref`) and drive the
 * selection from those entries (`v-model:active`, `focusSpot`).
 *
 * Usability rules (November 2026 — each fixed a problem found on the first build):
 * - The caption changes ONLY on a click, tap or key (owner, November 2026).
 *   Pointing just brightens the control's outline. Pointing first selected,
 *   and moving down to read the caption (or click its link) selected whatever
 *   lay on the way — VU meter became HF Emph; a hover PREVIEW of the caption
 *   that reverted on leaving came next, and still changed the text under the
 *   reader's eyes as the pointer crossed the faceplate.
 * - Every hotspot answers the pointer over at least `MIN_HIT` px, grown into
 *   free space only (`hitBoxes`): lamps were 19 px tall on a desktop and 9 px
 *   on a phone. The outline still draws the control's real box.
 * - The caption's height is that of the LONGEST description (every caption
 *   sits in one grid cell, only the shown one visible), so nothing below the
 *   tour jumps as the selection changes.
 * - One Tab stop (roving tabindex); arrows, Home and End move the selection.
 * - Screen readers hear the selection through a hidden live region (the
 *   visible caption is not live; its hidden copies are out of the
 *   accessibility tree).
 * - Under 640 px only the selected control is outlined (owner: fifteen boxes on
 *   a 360 px image cover the controls), so the numbered list is shown there
 *   even when `list` is off — otherwise nothing says what can be tapped.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { badgePlace, hitBoxes, stackOrder, stepIndex } from './tourGeometry.js'

const props = defineProps({
  /** { src, w, h } — the panel screenshot and its CSS size. */
  image: { type: Object, required: true },
  /** [{ id, label, text, at: { x, y, w, h } }], in the order to number them. */
  spots: { type: Array, required: true },
  /** Alt text for the screenshot. */
  alt: { type: String, required: true },
  /** The numbered list beside the image. Off where the page lists the controls
   *  itself — it still shows on phones, where the outlines are hidden. */
  list: { type: Boolean, default: true },
  /** Optional spot → href: the caption links to the control's full description. */
  detailHref: { type: Function, default: null },
  /** Load the picture at once: the help page shows the tour above the fold. */
  eager: { type: Boolean, default: false },
})

/** The SELECTED spot's index (click, tap, key); a parent may bind it. */
const active = defineModel('active', { type: Number, default: 0 })

function select(i) {
  active.value = i
}

// ── Hit areas ────────────────────────────────────────────────────────────────
/** Minimum hit size in screen px: 32 with a mouse, 44 for a finger. */
const MIN_HIT = 32
const MIN_HIT_TOUCH = 44
const stage = ref(null)
const stageWidth = ref(0)
const coarse = ref(false)
let ro = null
let mq = null
const onMq = () => { coarse.value = !!mq?.matches }
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && stage.value) {
    ro = new ResizeObserver(([e]) => { stageWidth.value = e.contentRect.width })
    ro.observe(stage.value)
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    mq = window.matchMedia('(pointer: coarse), (max-width: 640px)')
    onMq()
    mq.addEventListener?.('change', onMq)
  }
})
onBeforeUnmount(() => {
  ro?.disconnect()
  mq?.removeEventListener?.('change', onMq)
})

const boxes = computed(() => props.spots.map(s => s.at))
const stack = computed(() => stackOrder(boxes.value))
const hits = computed(() => {
  const { w, h } = props.image
  const scale = stageWidth.value ? stageWidth.value / w : 1
  const min = (coarse.value ? MIN_HIT_TOUCH : MIN_HIT) / scale
  return hitBoxes(boxes.value, { w, h }, min)
})

const pct = (v, of) => `${(v / of) * 100}%`
function hitStyle(i) {
  const b = hits.value[i]
  const { w, h } = props.image
  return { left: pct(b.x, w), top: pct(b.y, h), width: pct(b.w, w), height: pct(b.h, h), zIndex: stack.value[i] }
}
/** The control's real box, inside its (possibly larger) hit area. */
function outlineStyle(i) {
  const a = props.spots[i].at
  const b = hits.value[i]
  return { left: pct(a.x - b.x, b.w), top: pct(a.y - b.y, b.h), width: pct(a.w, b.w), height: pct(a.h, b.h) }
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
/** Plain arrays, filled by the template's function refs (not reactive state). */
const spotEls = []
const rowEls = []
function onKey(e, els) {
  const next = stepIndex(e.key, active.value, props.spots.length)
  if (next === null) return
  e.preventDefault()
  select(next)
  els[next]?.focus()
}

/**
 * Select a control and put keyboard focus on it — the help page's entry
 * numbers call this, so a keyboard user lands on the faceplate with the
 * control it asked for rather than being left down on the entry.
 */
function focusSpot(i) {
  select(i)
  spotEls[i]?.focus({ preventScroll: true })
}
defineExpose({ focusSpot })
</script>

<template>
  <div class="pt" :class="{ 'pt--solo': !list }">
    <figure class="pt-figure">
      <div ref="stage" class="pt-stage">
        <img
          :src="image.src" :width="image.w" :height="image.h" :alt="alt"
          class="pt-img" draggable="false" :loading="eager ? 'eager' : 'lazy'"
        />
        <button
          v-for="(s, i) in spots"
          :key="s.id"
          :ref="el => { spotEls[i] = el }"
          type="button"
          class="pt-spot"
          :class="{ 'pt-spot--on': i === active }"
          :style="hitStyle(i)"
          :tabindex="i === active ? 0 : -1"
          :aria-label="`${i + 1}. ${s.label}`"
          :aria-pressed="i === active"
          @click="select(i)"
          @keydown="onKey($event, spotEls)"
        >
          <span class="pt-outline" :style="outlineStyle(i)">
            <span class="pt-badge" :class="`pt-badge--${badgePlace(s.at)}`" aria-hidden="true">{{ i + 1 }}</span>
          </span>
        </button>
      </div>

      <!-- Every caption in one cell, only the shown one visible: the box is
           always as tall as the longest, so nothing below it moves. -->
      <figcaption v-if="spots.length" class="pt-caption">
        <div
          v-for="(s, i) in spots"
          :key="s.id"
          class="pt-caption-item"
          :class="{ 'pt-caption-item--on': i === active }"
        >
          <span class="pt-caption-n">{{ i + 1 }}</span>
          <span>
            <strong>{{ s.label }}</strong>
            <span class="pt-caption-text">{{ s.text }}</span>
            <a
              v-if="detailHref"
              :href="detailHref(s)"
              :tabindex="i === active ? 0 : -1"
              class="pt-caption-more"
            >Full description ↓</a>
          </span>
        </div>
      </figcaption>
      <!-- What a screen reader hears: the selection, never a mouse sweep. -->
      <p class="pt-sr" aria-live="polite">{{ spots[active] ? `${active + 1}. ${spots[active].label}: ${spots[active].text}` : '' }}</p>
    </figure>

    <ol class="pt-list" aria-label="Controls">
      <li v-for="(s, i) in spots" :key="s.id">
        <button
          :ref="el => { rowEls[i] = el }"
          type="button"
          class="pt-row"
          :class="{ 'pt-row--on': i === active }"
          :tabindex="i === active ? 0 : -1"
          :aria-pressed="i === active"
          @click="select(i)"
          @keydown="onKey($event, rowEls)"
        >
          <span class="pt-row-n">{{ i + 1 }}</span>
          <span class="pt-row-label">{{ s.label }}</span>
        </button>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.pt {
  /* Amber, the editor's own accent for a selected thing (#e8a33d). */
  --pt-accent: #e8a33d;
  display: grid;
  grid-template-columns: 1fr 230px;
  gap: 20px;
  align-items: start;
}
.pt--solo { grid-template-columns: minmax(0, 1fr); }
.pt--solo .pt-list { display: none; }
.pt-figure { margin: 0; min-width: 0; }
.pt-stage {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--tour-hairline, rgba(255, 255, 255, 0.08));
}
.pt-img { display: block; width: 100%; height: auto; }

/* The hit area: invisible, at least MIN_HIT px; the outline inside it draws
   the control's real box. */
.pt-spot {
  position: absolute;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.pt-spot:focus { outline: none; }
.pt-outline {
  position: absolute;
  border: 1.5px solid rgba(232, 163, 61, 0.18);
  border-radius: 10px;
  pointer-events: none;
  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
/* Every hotspot is faintly visible, so the screenshot reads as explorable. */
/* Hover only brightens the outline; the caption waits for a click. */
.pt-spot:hover:not(.pt-spot--on) .pt-outline {
  border-color: rgba(232, 163, 61, 0.6);
  background: rgba(232, 163, 61, 0.05);
}
.pt-spot--on .pt-outline {
  border-color: var(--pt-accent);
  background: rgba(232, 163, 61, 0.1);
  box-shadow: 0 0 0 4px rgba(232, 163, 61, 0.15), 0 0 30px rgba(232, 163, 61, 0.25);
}
.pt-spot:focus-visible .pt-outline {
  box-shadow: 0 0 0 2px #0b0e12, 0 0 0 4px var(--pt-accent), 0 0 30px rgba(232, 163, 61, 0.25);
}
/* Placed by `badgePlace`: inside a large box's corner, beside a short one. It
   sat outside every box's corner (−9 px) and on a crowded panel landed on the
   neighbouring control — LA Vintage 2A's Gain badge read as the meter's. */
.pt-badge {
  position: absolute;
  top: 3px;
  left: 3px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: rgba(11, 14, 18, 0.9);
  border: 1px solid rgba(232, 163, 61, 0.5);
  color: var(--pt-accent);
  font: 600 10px/16px 'JetBrains Mono', ui-monospace, monospace;
  text-align: center;
}
.pt-badge--side { top: 50%; left: auto; right: calc(100% + 4px); transform: translateY(-50%); }
.pt-badge--inside { top: 50%; transform: translateY(-50%); }
.pt-spot--on .pt-badge { background: var(--pt-accent); color: #06181b; border-color: var(--pt-accent); }

.pt-caption {
  margin-top: 14px;
  display: grid;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--tour-surface, #141920);
  border: 1px solid var(--tour-hairline, rgba(255, 255, 255, 0.08));
  font-size: 14px;
  line-height: 1.5;
}
.pt-caption-item {
  grid-area: 1 / 1;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  visibility: hidden;
}
.pt-caption-item--on { visibility: visible; }
.pt-caption-n {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--pt-accent);
  color: #06181b;
  display: grid;
  place-items: center;
  font: 700 12px 'JetBrains Mono', ui-monospace, monospace;
}
.pt-caption strong { display: block; margin-bottom: 2px; }
.pt-caption-text { color: var(--tour-soft, rgba(234, 246, 248, 0.7)); }
/* On a line of its own under the description. */
.pt-caption-more {
  display: block;
  width: fit-content;
  margin-top: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--pt-accent);
  text-decoration: none;
}
.pt-caption-more:hover { text-decoration: underline; }

.pt-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.pt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pt-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--tour-soft, rgba(234, 246, 248, 0.7));
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}
.pt-row:hover { background: rgba(255, 255, 255, 0.04); }
.pt-row--on { background: rgba(232, 163, 61, 0.1); color: var(--tour-text, #eaf6f8); }
.pt-row:focus { outline: none; }
.pt-row:focus-visible { box-shadow: inset 0 0 0 2px var(--pt-accent); }
.pt-row-n {
  flex: none;
  width: 20px;
  font: 600 11px 'JetBrains Mono', ui-monospace, monospace;
  color: var(--tour-muted, rgba(234, 246, 248, 0.45));
}
.pt-row--on .pt-row-n { color: var(--pt-accent); }

@media (max-width: 900px) {
  .pt { grid-template-columns: 1fr; }
  .pt-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
}
/* Phones: fifteen numbered boxes on a 360 px image cover the controls they
   point at, and there is no hover. Only the selected control is outlined
   (with its number); the list is how you move between them — so it shows
   here even on a page that turned it off. */
@media (max-width: 640px) {
  .pt-spot:not(.pt-spot--on) .pt-outline { border-color: transparent; background: transparent; }
  .pt-spot:not(.pt-spot--on) .pt-badge { display: none; }
  .pt-spot--on .pt-outline { box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.2); }
  .pt--solo .pt-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    margin-top: 10px;
  }
  .pt-row { padding: 10px; min-height: 44px; }
}
</style>
