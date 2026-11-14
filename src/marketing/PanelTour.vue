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
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** { src, w, h } — the panel screenshot and its CSS size. */
  image: { type: Object, required: true },
  /** [{ id, label, text, at: { x, y, w, h } }], in the order to number them. */
  spots: { type: Array, required: true },
  /** Alt text for the screenshot. */
  alt: { type: String, required: true },
})

const active = ref(0)
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
  <div class="pt">
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
          <span class="pt-badge" aria-hidden="true">{{ i + 1 }}</span>
        </button>
      </div>
      <figcaption v-if="current" class="pt-caption" aria-live="polite">
        <span class="pt-caption-n">{{ active + 1 }}</span>
        <span>
          <strong>{{ current.label }}</strong>
          <span class="pt-caption-text">{{ current.text }}</span>
        </span>
      </figcaption>
    </figure>

    <ol class="pt-list">
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
  display: grid;
  grid-template-columns: 1fr 230px;
  gap: 20px;
  align-items: start;
}
.pt-figure { margin: 0; min-width: 0; }
.pt-stage {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--mk-hairline);
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
.pt-spot:not(.pt-spot--on) { border-color: rgba(53, 211, 230, 0.18); }
.pt-spot--on {
  border-color: var(--mk-accent);
  background: rgba(53, 211, 230, 0.1);
  box-shadow: 0 0 0 4px rgba(53, 211, 230, 0.15), 0 0 30px rgba(53, 211, 230, 0.25);
}
.pt-spot:focus-visible { outline: none; }
.pt-badge {
  position: absolute;
  top: -9px;
  left: -9px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: rgba(11, 14, 18, 0.9);
  border: 1px solid rgba(53, 211, 230, 0.5);
  color: var(--mk-accent);
  font: 600 10px/16px 'JetBrains Mono', ui-monospace, monospace;
  text-align: center;
}
.pt-spot--on .pt-badge { background: var(--mk-accent); color: #06181b; border-color: var(--mk-accent); }

.pt-caption {
  margin-top: 14px;
  min-height: 64px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--mk-surface);
  border: 1px solid var(--mk-hairline);
  font-size: 14px;
  line-height: 1.5;
}
.pt-caption-n {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--mk-accent);
  color: #06181b;
  display: grid;
  place-items: center;
  font: 700 12px 'JetBrains Mono', ui-monospace, monospace;
}
.pt-caption strong { display: block; margin-bottom: 2px; }
.pt-caption-text { color: var(--mk-soft); }

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
  color: var(--mk-soft);
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
}
.pt-row:hover { background: rgba(255, 255, 255, 0.04); }
.pt-row--on { background: rgba(53, 211, 230, 0.1); color: var(--mk-text); }
.pt-row-n {
  flex: none;
  width: 20px;
  font: 600 11px 'JetBrains Mono', ui-monospace, monospace;
  color: var(--mk-muted);
}
.pt-row--on .pt-row-n { color: var(--mk-accent); }

@media (max-width: 900px) {
  .pt { grid-template-columns: 1fr; }
  .pt-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
}
</style>
