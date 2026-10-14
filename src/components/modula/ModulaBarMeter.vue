<script setup>
/**
 * MODULA BAR METER — a horizontal slotted bar with a peak tick and a scale
 * under it: PHAT*SS's SATURATION. The GAIN REDUCTION bar is the same housing
 * and stays `meters/GainReductionBar.vue`, which owns the VU ballistics a GR
 * reading needs.
 *
 * The caller passes a value already damped, 0–1 of the bar; this component
 * holds the peak tick (a fixed fall per second) and nothing else. The fill
 * runs light accent → accent → hot, and the reading turns hot past `hotAt`.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  /** 0–1 of the bar. */
  value: { type: Number, default: 0 },
  title: { type: String, default: '' },
  /** The big reading beside the title (the caller formats it). */
  reading: { type: String, default: '' },
  /** Scale under the bar: `[{ at: 0–1, label }]`. */
  marks: { type: Array, default: () => [0, 20, 40, 60, 80, 100].map(p => ({ at: p / 100, label: String(p) })) },
  color: { type: String, default: 'var(--m-accent)' },
  hotAt: { type: Number, default: 0.8 },
  active: { type: Boolean, default: true },
  /** Bar height, px. */
  height: { type: Number, default: 24 },
  /** The peak tick falls this much of the bar per second. */
  peakFallPerS: { type: Number, default: 0.2 },
})

const peak = ref(0)
let raf = null
let last = 0
function tick(now) {
  const dt = last ? (now - last) / 1000 : 0
  last = now
  const v = props.active ? Math.max(0, Math.min(1, props.value)) : 0
  peak.value = Math.max(v, peak.value - props.peakFallPerS * dt)
  raf = requestAnimationFrame(tick)
}
onMounted(() => { raf = requestAnimationFrame(tick) })
onUnmounted(() => { if (raf) cancelAnimationFrame(raf) })
watch(() => props.active, (on) => { if (!on) peak.value = 0 })

const fill = computed(() => (props.active ? Math.max(0, Math.min(1, props.value)) : 0))
const hot = computed(() => fill.value > props.hotAt)
const readingColor = computed(() => (hot.value ? '#ff8a7e' : `color-mix(in srgb, ${props.color} 65%, #ffffff)`))
const readingGlow = computed(() => (hot.value ? 'rgba(255,90,78,.5)' : `color-mix(in srgb, ${props.color} 55%, transparent)`))
const shift = at => (at <= 0 ? 'none' : at >= 1 ? 'translateX(-100%)' : 'translateX(-50%)')
</script>

<template>
  <div class="m-bar-meter" role="meter" :aria-label="title || undefined" :aria-valuemin="0" :aria-valuemax="1" :aria-valuenow="Number(fill.toFixed(3))" :aria-valuetext="reading || undefined">
    <div v-if="title || reading" class="m-bar-head">
      <span class="m-bar-title">{{ title }}</span>
      <span class="m-bar-reading" :style="{ color: readingColor, textShadow: `0 0 8px ${readingGlow}` }">{{ reading }}</span>
    </div>
    <div class="m-bar-housing">
      <div class="m-bar-slot" :style="{ height: `${height}px` }">
        <div
          class="m-bar-fill"
          :style="{
            clipPath: `inset(0 ${(100 - fill * 100).toFixed(1)}% 0 0 round 9px)`,
            background: `linear-gradient(90deg, color-mix(in srgb, ${color} 35%, #ffffff), ${color} 75%, var(--m-hot))`,
            boxShadow: `0 0 10px color-mix(in srgb, ${color} 60%, transparent)`,
          }"
        ></div>
        <div class="m-bar-slots"></div>
        <div v-if="peak > 0.01" class="m-bar-peak" :style="{ left: `calc(${(peak * 100).toFixed(1)}% - 1px)` }"></div>
      </div>
    </div>
    <div class="m-bar-scale">
      <span v-for="m in marks" :key="m.label" :style="{ left: `${m.at * 100}%`, transform: shift(m.at) }">{{ m.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.m-bar-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.m-bar-title { font: 700 10px/1 var(--m-font-ui); letter-spacing: .14em; color: var(--m-ink-2); }
.m-bar-reading { white-space: nowrap; font: 700 20px/1 var(--m-font-mono); font-variant-numeric: tabular-nums; }
.m-bar-housing { padding: 3px; border-radius: 12px; background: #0a0806; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05); }
.m-bar-slot { position: relative; border-radius: 9px; background: rgba(0, 0, 0, .5); box-shadow: inset 0 1px 4px rgba(0, 0, 0, .8); }
.m-bar-fill { position: absolute; inset: 0; border-radius: 9px; transition: clip-path .1s linear; }
.m-bar-slots { position: absolute; inset: 0; border-radius: 9px; background: repeating-linear-gradient(90deg, #0000 0 9px, rgba(10, 8, 6, .85) 9px 11px); }
.m-bar-peak { position: absolute; pointer-events: none; top: 1px; bottom: 1px; width: 2px; border-radius: 1px; background: rgba(255, 255, 255, .6); }
.m-bar-scale { position: relative; height: 10px; margin: 5px 3px 0; font: 600 8px/1 var(--m-font-mono); color: var(--m-ink-4); }
.m-bar-scale span { position: absolute; top: 0; }
</style>
