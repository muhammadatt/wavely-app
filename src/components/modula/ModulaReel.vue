<script setup>
/**
 * MODULA TAPE REEL — a spinning tape-reel flange, the 6g finish from the
 * PHAT*SS layout study (`docs/design/modula/PHATaSS_Layouts.dc.html`): satin
 * steel rim and inner ring, three holes, an amber hub and a white index dot.
 *
 * Decoration only: it shows the selected speed by how fast it turns and has
 * no control of its own. `period` is the seconds per turn (PHAT*SS: 1.6 /
 * 3.2 / 6.4 s at 30 / 15 / 7.5 IPS); `spinning` pauses it where it is rather
 * than snapping back to the top, so stopping and starting playback never
 * jumps. Honours `prefers-reduced-motion`.
 */
import { computed } from 'vue'

const props = defineProps({
  /** Diameter, px. Every part scales with it. */
  size: { type: Number, default: 100 },
  spinning: { type: Boolean, default: false },
  /** Seconds per turn. */
  period: { type: Number, default: 1.6 },
})

const HOLE = 0.26
const HOLE_R = 0.29
const HUB = 0.2

const holes = computed(() => [0, 1, 2].map(k => {
  const a = (k * 120 * Math.PI) / 180
  const z = props.size
  const hs = z * HOLE
  return {
    left: `${z / 2 + z * HOLE_R * Math.sin(a) - hs / 2}px`,
    top: `${z / 2 - z * HOLE_R * Math.cos(a) - hs / 2}px`,
    width: `${hs}px`,
    height: `${hs}px`,
  }
}))
const hub = computed(() => {
  const h = props.size * HUB
  return { left: `${(props.size - h) / 2}px`, top: `${(props.size - h) / 2}px`, width: `${h}px`, height: `${h}px` }
})
</script>

<template>
  <div class="m-reel" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <div
      class="m-reel-face"
      :style="{ animationDuration: `${period}s`, animationPlayState: spinning ? 'running' : 'paused' }"
    >
      <div class="m-reel-ring" :style="{ inset: `${size * 0.07}px` }"></div>
      <div v-for="(h, k) in holes" :key="k" class="m-reel-hole" :style="h"></div>
      <div class="m-reel-hub" :style="hub"></div>
      <div class="m-reel-dot" :style="{ left: `${(size - 4) / 2}px`, top: `${size * 0.05}px` }"></div>
    </div>
  </div>
</template>

<style scoped>
.m-reel { position: relative; flex: none; }
.m-reel-face {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: linear-gradient(160deg, #868d96 0%, #6c727b 55%, #5c626a 100%);
  box-shadow: 0 8px 14px -10px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .22), 0 0 0 1px rgba(0, 0, 0, .4);
  animation: m-reel-spin 1.6s linear infinite;
}
.m-reel-ring { position: absolute; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .12), 0 1px 0 rgba(255, 255, 255, .08); }
.m-reel-hole { position: absolute; border-radius: 50%; background: #3b4048; box-shadow: inset 0 1px 2px rgba(0, 0, 0, .35); }
.m-reel-hub {
  position: absolute;
  border-radius: 50%;
  background: radial-gradient(circle at 45% 40%, #f5c56a, var(--m-accent) 60%, #b37420);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .5), 0 0 8px rgba(232, 163, 61, .45);
}
.m-reel-dot { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: var(--m-ink); box-shadow: 0 0 5px var(--m-ink); }
@keyframes m-reel-spin { to { transform: rotate(-360deg); } }
@media (prefers-reduced-motion: reduce) {
  .m-reel-face { animation: none; }
}
</style>
