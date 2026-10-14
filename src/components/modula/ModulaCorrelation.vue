<script setup>
/**
 * MODULA CORRELATION — a stereo phase-correlation bar, −1 … +1, with a centre
 * line at 0 and a lit marker at the reading.
 */
import { computed } from 'vue'

const props = defineProps({
  /** −1 … +1. */
  value: { type: Number, default: 0 },
  label: { type: String, default: 'CORRELATION' },
  color: { type: String, default: 'var(--m-second)' },
})
const v = computed(() => Math.max(-1, Math.min(1, Number(props.value) || 0)))
</script>

<template>
  <div class="m-corr">
    <div class="m-corr-head">
      <span class="m-caption" style="color:#aeb6bd">{{ label }}</span>
      <span class="m-corr-num">{{ v.toFixed(2) }}</span>
    </div>
    <div class="m-corr-bar" role="meter" :aria-label="label" aria-valuemin="-1" aria-valuemax="1" :aria-valuenow="Number(v.toFixed(2))">
      <div class="m-corr-mark" :style="{ left: `calc(${((v + 1) / 2) * 100}% - ${((v + 1) / 2) * 6}px)`, background: color, boxShadow: `0 0 6px ${color}` }"></div>
      <div class="m-corr-zero"></div>
    </div>
  </div>
</template>

<style scoped>
.m-corr { display: flex; flex-direction: column; gap: 12px; }
.m-corr-head { display: flex; justify-content: space-between; align-items: baseline; }
.m-corr-num { font: 500 10px/1 var(--m-font-mono); letter-spacing: .18em; color: var(--m-ink); }
.m-corr-bar { position: relative; height: 14px; border-radius: 7px; background: linear-gradient(180deg, #15171a, #212429); box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85); }
.m-corr-mark { position: absolute; top: 0; bottom: 0; width: 6px; border-radius: 4px; transition: left .12s linear; }
.m-corr-zero { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: rgba(255, 255, 255, .12); }
</style>
