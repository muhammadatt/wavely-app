<script setup>
/**
 * MODULA MINI LADDER — a short fixed-cell LED ladder for a secondary reading
 * (the Inflator's LIFT). One or two columns; the top fifth burns at full
 * colour and the rest at a deepened shade, so it reads as one quantity
 * rather than as a level meter with zones.
 *
 * Values are 0–1 per column; the ladder holds a peak cell that falls back.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps({
  /** One 0–1 value per column. */
  values: { type: Array, default: () => [0] },
  rows: { type: Number, default: 14 },
  color: { type: String, default: 'var(--m-accent)' },
  reading: { type: String, default: '' },
  label: { type: String, default: '' },
  /** Fall of the displayed level and of the peak cell, fraction per second. */
  releasePerS: { type: Number, default: 1.6 },
  peakFallPerS: { type: Number, default: 0.4 },
})

const shown = ref([])
const peaks = ref([])
let raf = null
let last = 0
function tick(now) {
  const dt = last ? (now - last) / 1000 : 0
  last = now
  const src = props.values.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
  shown.value = src.map((v, i) => Math.max(v, (shown.value[i] ?? 0) - props.releasePerS * dt))
  peaks.value = src.map((v, i) => Math.max(shown.value[i], (peaks.value[i] ?? 0) - props.peakFallPerS * dt))
  raf = requestAnimationFrame(tick)
}
onMounted(() => { raf = requestAnimationFrame(tick) })
onUnmounted(() => { if (raf) cancelAnimationFrame(raf) })

const cells = computed(() => {
  const N = props.rows
  const lit = shown.value.map(v => Math.round(v * N))
  const pk = peaks.value.map(v => Math.round(v * N) - 1)
  return Array.from({ length: N }, (_, j) => {
    const fromBottom = N - 1 - j
    const t = 1 - j / (N - 1)
    const c = t > 0.8 ? props.color : `color-mix(in srgb, ${props.color} 70%, #3a2a10)`
    const cols = (props.values.length ? props.values : [0]).map((_, i) => {
      const on = fromBottom < (lit[i] ?? 0)
      const isPeak = fromBottom === pk[i] && pk[i] >= 0
      return on || isPeak ? { o: on ? 1 : 0.8, g: `0 0 6px ${c}` } : { o: 0.09, g: 'none' }
    })
    return { c, cols }
  })
})
</script>

<template>
  <div class="m-mini">
    <div class="m-mini-housing" role="meter" :aria-label="label || undefined" :aria-valuetext="reading || undefined">
      <div v-for="(r, j) in cells" :key="j" class="m-mini-row">
        <div v-for="(c, i) in r.cols" :key="i" class="m-mini-cell" :style="{ background: r.c, opacity: c.o, boxShadow: c.g }"></div>
      </div>
    </div>
    <div v-if="reading" class="m-mini-reading">{{ reading }}</div>
    <div v-if="label" class="m-mini-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.m-mini { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.m-mini-housing { display: flex; flex-direction: column; gap: 3px; padding: 5px; border-radius: 5px; background: var(--m-ladder); border: 1px solid var(--m-ladder-edge); }
.m-mini-row { display: flex; gap: 2px; }
.m-mini-cell { width: 8px; height: 6px; border-radius: 1px; }
.m-mini-reading { white-space: nowrap; font: 600 11px/1 var(--m-font-mono); color: var(--m-ink); }
.m-mini-label { font: 600 9px/1 var(--m-font-ui); letter-spacing: .14em; color: var(--m-ink-4); }
</style>
