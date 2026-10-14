<script setup>
/**
 * MODULA HISTORY — a short bar history of a 0–1 reading, oldest left. The
 * newest `recent` bars are lit in the accent; the rest are white at an
 * opacity that follows their height, so the trace fades into the panel.
 */
defineProps({
  /** 0–1 values, oldest first. */
  values: { type: Array, default: () => [] },
  recent: { type: Number, default: 3 },
  height: { type: Number, default: 52 },
  color: { type: String, default: 'var(--m-accent)' },
})
</script>

<template>
  <div class="m-hist" :style="{ height: `${height}px` }" aria-hidden="true">
    <div
      v-for="(v, i) in values" :key="i" class="m-hist-bar"
      :style="{
        height: `${8 + Math.max(0, Math.min(1, v)) * 92}%`,
        background: i >= values.length - recent ? color : `rgba(255,255,255,${(0.08 + Math.max(0, Math.min(1, v)) * 0.16).toFixed(2)})`,
      }"
    ></div>
  </div>
</template>

<style scoped>
.m-hist { display: flex; gap: 6px; align-items: flex-end; padding: 0 2px; }
.m-hist-bar { flex: 1; border-radius: 2px; }
</style>
