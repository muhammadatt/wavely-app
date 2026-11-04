<script setup>
/**
 * VOXPRESSOR IN / OUT — two compact horizontal ladders in a dark well, under
 * the output ceiling (docs/design/voxpressor, layout B "Output"). The amber
 * mark on OUT is the ceiling: the output peak lands on it. −24 … 0 dBFS.
 *
 * The figure on the right is the PEAK, held 1 s and then falling 20 dB/s, the
 * number a user aiming at a ceiling needs. The bar is the live peak.
 */
import { computed, ref, watch } from 'vue'

const props = defineProps({
  /** `[{ rmsDb, peakDb }]` per channel (snapshotLevels). */
  inLevels: { type: Array, default: () => [] },
  outLevels: { type: Array, default: () => [] },
  /** Where the output peak lands, dBFS; null hides the mark. */
  ceilingDb: { type: Number, default: null },
})

const FLOOR_DB = -24
const HOLD_MS = 1000
const FALL_DB_PER_S = 20

const pos = db => Math.max(0, Math.min(100, (1 - db / FLOOR_DB) * 100))
const peakOf = ls => ls.reduce((m, c) => Math.max(m, Number.isFinite(c?.peakDb) ? c.peakDb : -Infinity), -Infinity)

function holder(source) {
  const held = ref(-Infinity)
  let at = 0
  let t = 0
  watch(source, (ls) => {
    const now = performance.now()
    const p = peakOf(ls)
    const dt = t ? (now - t) / 1000 : 0
    t = now
    if (p >= held.value) { held.value = p; at = now; return }
    if (now - at > HOLD_MS) held.value = Math.max(p, held.value - FALL_DB_PER_S * dt)
  })
  return held
}
const inHeld = holder(() => props.inLevels)
const outHeld = holder(() => props.outLevels)

const fmt = db => (db > -90 ? db.toFixed(1) : '−∞')
const rows = computed(() => [
  { id: 'in', label: 'IN', fill: pos(peakOf(props.inLevels)), text: fmt(inHeld.value), mark: null },
  {
    id: 'out', label: 'OUT', fill: pos(peakOf(props.outLevels)), text: fmt(outHeld.value),
    mark: Number.isFinite(props.ceilingDb) ? pos(props.ceilingDb) : null,
  },
])
</script>

<template>
  <div class="vio">
    <div v-for="r in rows" :key="r.id" class="vio-row">
      <span class="vio-label">{{ r.label }}</span>
      <div class="vio-bar" role="meter" :aria-label="`${r.label} peak`" aria-valuemin="-24" aria-valuemax="0" :aria-valuetext="`${r.text} dBFS`">
        <div class="vio-ladder" :style="{ '--fill': `${r.fill}%` }"></div>
        <div v-if="r.mark !== null" class="vio-mark" :style="{ left: `${r.mark}%` }" title="Output ceiling"></div>
      </div>
      <span class="vio-read">{{ r.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.vio {
  display: flex; flex-direction: column; gap: 9px; padding: 9px 10px; border-radius: 9px; background: #1a1c20;
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .8), 0 1px 0 rgba(255, 255, 255, .05);
}
.vio-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) 30px; align-items: center; gap: 6px; }
.vio-label { font: 500 9px/1 var(--m-font-mono); letter-spacing: .1em; color: #a0a8b0; }
.vio-read { text-align: right; font: 500 9px/1 var(--m-font-mono); color: #c9d0d6; font-variant-numeric: tabular-nums; }
.vio-bar { position: relative; height: 7px; }
.vio-ladder {
  position: absolute; inset: 0; border-radius: 2px;
  background:
    repeating-linear-gradient(90deg, transparent 0 3px, #1a1c20 3px 5px),
    linear-gradient(90deg, #8fd48a 0 var(--fill), #2a313b var(--fill) 75%, #3d3a28 75% 88%, #3d2328 88%);
}
.vio-mark {
  position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px;
  background: #e8a33d; box-shadow: 0 0 5px #e8a33d; transition: left .16s ease-out;
}
</style>
