<script setup>
/**
 * Segmented level ladder — 16 LEDs, cool through warm to red at the top.
 *
 * Takes the same `levels` array the LevelMeter does (`{ rmsDb, peakDb }` per
 * channel) and shows the loudest channel's RMS: a stereo pair on a 20 px
 * ladder is one bar, not two. Empty `levels` means the graph is not running
 * and every segment is dark.
 */
import { computed } from 'vue'
import { glow, OFF_SEG } from './modulaTheme.js'

const props = defineProps({
  levels: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  cool: { type: String, default: '#6fd6ff' },
  warm: { type: String, default: '#ff8b3d' },
  hot: { type: String, default: '#ff4d3d' },
  floorDb: { type: Number, default: -60 },
  segments: { type: Number, default: 16 },
})

const level = computed(() => {
  let rms = -Infinity
  for (const l of props.levels) if (l.rmsDb > rms) rms = l.rmsDb
  if (!Number.isFinite(rms)) return 0
  return Math.max(0, Math.min(1, (rms - props.floorDb) / -props.floorDb))
})

const segs = computed(() => Array.from({ length: props.segments }, (_, i) => {
  const f = i / (props.segments - 1)
  const on = props.levels.length > 0 && f <= level.value
  const col = f < 0.62 ? props.cool : f < 0.88 ? props.warm : props.hot
  return {
    background: on ? col : OFF_SEG,
    boxShadow: on ? `0 0 9px ${glow(col)}` : 'inset 0 1px 1px rgba(0,0,0,.6)',
  }
}))
</script>

<template>
  <div class="mld">
    <div class="mld-ladder">
      <div v-for="(s, i) in segs" :key="i" class="mld-seg" :style="s"></div>
    </div>
    <div v-if="label" class="mld-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.mld { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.mld-ladder {
  display: flex; flex-direction: column-reverse; gap: 3px; padding: 9px 8px; border-radius: 12px;
  background: linear-gradient(180deg, #191b1f, #212429); box-shadow: inset 0 2px 8px rgba(0,0,0,.85);
}
.mld-seg { width: 20px; height: 7px; border-radius: 2px; }
.mld-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .2em; color: #79808a; }
</style>
