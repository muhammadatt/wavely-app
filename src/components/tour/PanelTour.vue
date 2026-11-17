<script setup>
/**
 * The interactive screenshot: the faceplate with every documented control
 * outlined and numbered. Pointing at a control (or its row in the list, or
 * tabbing to either) lights both and shows what it does — u-he's product pages
 * are the model.
 *
 * The boxes are the controls' own, recorded by `npm run help:shots` (`at` in
 * the manifest, CSS pixels on panel.jpg), so a re-laid-out panel moves its
 * hotspots with it the next time the shots are taken. Positions are percentages
 * of the image, so the overlay scales with it at any width.
 *
 * The tour is AMBER (`--pt-accent`, the editor's selected-thing colour), not the
 * page's cyan accent (owner, November 2026).
 *
 * Shared by the marketing pages and the help pages, so it imports nothing and
 * reads its surface colours from optional `--tour-*` properties on an ancestor
 * (defaults are both pages' shared palette). The help pages turn the side list
 * off (their control entries below ARE the list), link the caption to each
 * control's full entry (`detailHref`) and drive the selection from those
 * entries (`v-model:active`).
 */
import { computed } from 'vue'

const props = defineProps({
  /** { src, w, h } — the panel screenshot and its CSS size. */
  image: { type: Object, required: true },
  /** [{ id, label, text, at: { x, y, w, h } }], in the order to number them. */
  spots: { type: Array, required: true },
  /** Alt text for the screenshot. */
  alt: { type: String, required: true },
  /** The numbered list beside the image. Off where the page lists the controls itself. */
  list: { type: Boolean, default: true },
  /** Optional spot → href: the caption links to the control's full description. */
  detailHref: { type: Function, default: null },
})

/** The selected spot's index; a parent may bind it (`v-model:active`). */
const active = defineModel('active', { type: Number, default: 0 })
const current = computed(() => props.spots[active.value] ?? null)

/**
 * Smaller boxes stack ABOVE larger ones. Controls nest — Gain's box holds the
 * AUTO lamp, VoxPressor's Peak reduction holds its Knee keys — and whichever
 * box is on top takes the pointer, so a nested control under its parent could
 * never be pointed at. Stacking by area keeps every one reachable; the active
 * box is not raised, for the same reason.
 */
const stack = computed(() => {
  const order = props.spots.map((s, i) => [s.at.w * s.at.h, i]).sort((a, b) => b[0] - a[0])
  const z = new Array(props.spots.length)
  order.forEach(([, i], rank) => { z[i] = rank + 1 })
  return z
})

/**
 * Where a box's number goes. Large controls (knobs, meters) carry it inside
 * their top-left corner. A short box — a lamp, a switch, a one-line setter —
 * would be covered by it, so its badge sits just outside its LEFT edge,
 * vertically centred; or inside on the left, centred, when the box starts at
 * the image's edge and there is no room outside.
 */
const SHORT_BOX_PX = 48
const SIDE_ROOM_PX = 26
function badgePlace(s) {
  if (s.at.h >= SHORT_BOX_PX) return 'corner'
  return s.at.x >= SIDE_ROOM_PX ? 'side' : 'inside'
}

function box(s, i) {
  const { w, h } = props.image
  return {
    left: `${(s.at.x / w) * 100}%`,
    top: `${(s.at.y / h) * 100}%`,
    width: `${(s.at.w / w) * 100}%`,
    height: `${(s.at.h / h) * 100}%`,
    zIndex: stack.value[i],
  }
}
</script>

<template>
  <div class="pt" :class="{ 'pt--solo': !list }">
    <figure class="pt-figure">
      <div class="pt-stage">
        <img
          :src="image.src" :width="image.w" :height="image.h" :alt="alt"
          class="pt-img" draggable="false" loading="lazy"
        />
        <button
          v-for="(s, i) in spots"
          :key="s.id"
          type="button"
          class="pt-spot"
          :class="{ 'pt-spot--on': i === active }"
          :style="box(s, i)"
          :aria-label="`${i + 1}. ${s.label}`"
          @mouseenter="active = i"
          @focus="active = i"
          @click="active = i"
        >
          <span class="pt-badge" :class="`pt-badge--${badgePlace(s)}`" aria-hidden="true">{{ i + 1 }}</span>
        </button>
      </div>
      <figcaption v-if="current" class="pt-caption" aria-live="polite">
        <span class="pt-caption-n">{{ active + 1 }}</span>
        <span>
          <strong>{{ current.label }}</strong>
          <span class="pt-caption-text">{{ current.text }}</span>
          <a v-if="detailHref" :href="detailHref(current)" class="pt-caption-more">Full description ↓</a>
        </span>
      </figcaption>
    </figure>

    <ol v-if="list" class="pt-list">
      <li v-for="(s, i) in spots" :key="s.id">
        <button
          type="button"
          class="pt-row"
          :class="{ 'pt-row--on': i === active }"
          @mouseenter="active = i"
          @focus="active = i"
          @click="active = i"
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
.pt-figure { margin: 0; min-width: 0; }
.pt-stage {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--tour-hairline, rgba(255, 255, 255, 0.08));
}
.pt-img { display: block; width: 100%; height: auto; }

.pt-spot {
  position: absolute;
  padding: 0;
  margin: 0;
  border: 1.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
/* Every hotspot is faintly visible, so the screenshot reads as explorable. */
.pt-spot:not(.pt-spot--on) { border-color: rgba(232, 163, 61, 0.18); }
.pt-spot--on {
  border-color: var(--pt-accent);
  background: rgba(232, 163, 61, 0.1);
  box-shadow: 0 0 0 4px rgba(232, 163, 61, 0.15), 0 0 30px rgba(232, 163, 61, 0.25);
}
.pt-spot:focus-visible { outline: none; }
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
  min-height: 64px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--tour-surface, #141920);
  border: 1px solid var(--tour-hairline, rgba(255, 255, 255, 0.08));
  font-size: 14px;
  line-height: 1.5;
}
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
.pt-caption-more {
  display: inline-block;
  margin-top: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--pt-accent);
  text-decoration: none;
}
.pt-caption-more:hover { text-decoration: underline; }

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
   (with its number); the list below is how you move between them. */
@media (max-width: 640px) {
  .pt-spot:not(.pt-spot--on) { border-color: transparent; }
  .pt-spot:not(.pt-spot--on) .pt-badge { display: none; }
  .pt-spot--on { box-shadow: 0 0 0 3px rgba(232, 163, 61, 0.2); }
}
</style>
