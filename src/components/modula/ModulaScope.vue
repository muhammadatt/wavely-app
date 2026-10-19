<script setup>
/**
 * MODULA WAVEFORM SCOPE — an envelope of bars with what a process REMOVED
 * drawn in the accent around what is left, a playhead, and a legend. Click
 * or drag to scrub (`update:position`, 0–1).
 *
 * `bars` is `[{ o, p }]`: `o` the original envelope, `p` the processed one,
 * both 0–1. Where `p < o` the difference is drawn as the removed rim.
 */
import { computed, ref } from 'vue'

const props = defineProps({
  bars: { type: Array, default: () => [] },
  /** Playhead, 0–1 (null: none). */
  position: { type: Number, default: null },
  height: { type: Number, default: 150 },
  removedColor: { type: String, default: 'var(--m-accent)' },
  legend: { type: Boolean, default: true },
  removedLabel: { type: String, default: 'REMOVED' },
  playedLabel: { type: String, default: 'PLAYED' },
})
const emit = defineEmits(['update:position'])

const cut = computed(() => (props.position == null ? -1 : props.position * props.bars.length))
const scrubbing = ref(false)
let rect = null
function at(e) {
  if (!rect) return
  emit('update:position', Math.max(0, Math.min(0.9999, (e.clientX - rect.left - 10) / (rect.width - 20))))
}
function down(e) {
  rect = e.currentTarget.getBoundingClientRect()
  scrubbing.value = true
  e.currentTarget.setPointerCapture?.(e.pointerId)
  at(e)
}
function move(e) { if (scrubbing.value) at(e) }
function up(e) {
  scrubbing.value = false
  try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
}
</script>

<template>
  <div class="m-scope" :style="{ height: `${height}px` }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <div class="m-scope-axis"></div>
    <div class="m-scope-bars">
      <div
        v-for="(b, i) in bars" :key="i" class="m-scope-bar"
        :style="{
          height: `${(b.o * 100).toFixed(1)}%`,
          background: b.p < b.o ? (i < cut ? removedColor : `color-mix(in srgb, ${removedColor} 55%, transparent)`) : (i < cut ? '#9aa2ab' : '#4f555e'),
        }"
      >
        <div class="m-scope-inner" :style="{ height: `${(b.o > 0 ? (b.p / b.o) * 100 : 0).toFixed(1)}%`, background: i < cut ? '#9aa2ab' : '#4f555e' }"></div>
      </div>
    </div>
    <div v-if="position != null" class="m-scope-head" :style="{ left: `calc(10px + (100% - 20px) * ${position})` }"><div class="m-scope-flag"></div></div>
    <div v-if="legend" class="m-scope-legend">
      <span><i :style="{ background: removedColor }"></i>{{ removedLabel }}</span>
      <span><i style="background:#9aa2ab"></i>{{ playedLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.m-scope { position: relative; border-radius: 6px; overflow: hidden; cursor: ew-resize; touch-action: none; background: var(--m-ladder); box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px var(--m-ladder-edge), 0 1px 0 rgba(255, 255, 255, .05); }
.m-scope-axis { position: absolute; left: 10px; right: 10px; top: 50%; height: 1px; background: rgba(255, 255, 255, .07); }
.m-scope-bars { position: absolute; left: 10px; right: 10px; top: 12px; bottom: 26px; display: flex; align-items: center; gap: 1px; }
.m-scope-bar { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; border-radius: 1px; }
.m-scope-inner { width: 100%; border-radius: 1px; }
.m-scope-head { position: absolute; top: 0; bottom: 0; width: 1px; pointer-events: none; background: var(--m-ink); box-shadow: 0 0 0 1px rgba(0, 0, 0, .35); }
.m-scope-flag { position: absolute; top: 0; left: -5px; width: 0; height: 0; border-left: 5.5px solid transparent; border-right: 5.5px solid transparent; border-top: 7px solid var(--m-ink); }
.m-scope-legend { position: absolute; left: 12px; bottom: 8px; display: flex; align-items: center; gap: 14px; pointer-events: none; font: 600 9px/1 var(--m-font-ui); letter-spacing: .14em; color: var(--m-ink-3); }
.m-scope-legend span { display: flex; align-items: center; gap: 6px; }
.m-scope-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
</style>
