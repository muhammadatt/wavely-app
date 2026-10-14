<script setup>
/**
 * MODULA VU / TUBE — a needle over a warm, glowing face (the kit's PROGRAM
 * LEVEL). The needle sweeps ±52° over −30 … 0 VU, engraved where the kit
 * engraves it; the last two marks are red.
 *
 * Pass `db` (VU, 0 = reference). The needle is a CSS transition, which is
 * the right ballistics for a reading pushed a few times a second; a caller
 * pushing every frame should damp upstream.
 */
import { computed } from 'vue'

const props = defineProps({
  db: { type: Number, default: -Infinity },
  title: { type: String, default: 'VU / TUBE' },
  caption: { type: String, default: '' },
})

const MARKS = [-30, -20, -10, -7, -5, -3, 0]
const SWEEP = 52
const step = (2 * SWEEP) / (MARKS.length - 1)
const ticks = MARKS.map((m, i) => ({ label: String(m), deg: -SWEEP + step * i, red: i >= 5 }))

/** Engraved-mark law: linear between neighbouring marks, pinned at both ends. */
const needle = computed(() => {
  const d = props.db
  if (!(d > MARKS[0])) return -SWEEP
  if (d >= 0) return SWEEP
  for (let i = 1; i < MARKS.length; i++) {
    if (d <= MARKS[i]) return ticks[i - 1].deg + (ticks[i].deg - ticks[i - 1].deg) * (d - MARKS[i - 1]) / (MARKS[i] - MARKS[i - 1])
  }
  return SWEEP
})
</script>

<template>
  <div class="m-vu">
    <div class="m-vu-face" role="meter" :aria-label="caption || title" :aria-valuenow="Number.isFinite(db) ? Number(db.toFixed(1)) : -30" aria-valuemin="-30" aria-valuemax="0">
      <div class="m-vu-arc"></div>
      <div v-for="t in ticks" :key="t.label" class="m-vu-tick" :style="{ transform: `rotate(${t.deg}deg)` }">
        <div class="m-vu-tick-mark" :style="{ background: t.red ? '#ff6a3a' : 'rgba(255,255,255,.22)' }"></div>
        <div class="m-vu-tick-label" :style="{ transform: `rotate(${-t.deg}deg)` }">{{ t.label }}</div>
      </div>
      <div class="m-vu-needle" :style="{ transform: `rotate(${needle}deg)` }"></div>
      <div class="m-vu-pivot"></div>
      <div class="m-vu-title">{{ title }}</div>
    </div>
    <div v-if="caption" class="m-caption" style="color:#aeb6bd">{{ caption }}</div>
  </div>
</template>

<style scoped>
.m-vu { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.m-vu-face {
  position: relative;
  width: 280px;
  height: 152px;
  overflow: hidden;
  border-radius: 16px 16px 8px 8px;
  background: radial-gradient(120% 150% at 50% 100%, #2a1d16 0%, #17181b 70%);
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .8), 0 0 0 1px rgba(0, 0, 0, .6);
}
.m-vu-arc { position: absolute; left: 20px; right: 20px; top: 24px; height: 240px; border-radius: 50%; border-top: 1px solid rgba(255, 139, 61, .28); }
.m-vu-tick { position: absolute; left: 50%; bottom: 16px; width: 1px; height: 118px; transform-origin: 50% 100%; }
.m-vu-tick-mark { width: 1px; height: 14px; }
.m-vu-tick-label { position: absolute; top: -19px; left: -11px; width: 24px; text-align: center; font: 400 9px/1 var(--m-font-mono); color: #8b8177; }
.m-vu-needle { position: absolute; left: 50%; bottom: 16px; width: 2px; height: 112px; margin-left: -1px; transform-origin: 50% 100%; transition: transform .12s linear; background: linear-gradient(180deg, #ffb98a, #ff5b2e); box-shadow: 0 0 10px rgba(255, 91, 46, .55); }
.m-vu-pivot { position: absolute; left: 50%; bottom: 10px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; background: linear-gradient(160deg, #4a4f57, #22252a); box-shadow: 0 2px 6px rgba(0, 0, 0, .8); }
.m-vu-title { position: absolute; left: 0; right: 0; bottom: 34px; text-align: center; font: 600 10px/1 var(--m-font-ui); letter-spacing: .14em; color: #a2887a; }
</style>
