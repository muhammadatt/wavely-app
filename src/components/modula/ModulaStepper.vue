<script setup>
/**
 * The header's sunk stepper pill — ‹ NAME › — for walking a list.
 */
defineProps({
  text: { type: String, required: true },
  prevTitle: { type: String, default: 'Previous' },
  nextTitle: { type: String, default: 'Next' },
})
const emit = defineEmits(['prev', 'next'])
</script>

<template>
  <div class="mstp">
    <div class="mstp-arrow" :title="prevTitle" @click="emit('prev')">&#8249;</div>
    <div class="mstp-text">{{ text }}</div>
    <div class="mstp-arrow" :title="nextTitle" @click="emit('next')">&#8250;</div>
  </div>
</template>

<style scoped>
.mstp {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 18px; border-radius: 999px;
  background: linear-gradient(180deg, #24272c, #1c1e22);
  box-shadow: inset 0 2px 6px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.55);
}
.mstp-arrow { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #7e868f; cursor: pointer; padding: 0 6px; user-select: none; }
.mstp-text { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: .18em; color: #cfd5dd; min-width: 170px; text-align: center; white-space: nowrap; }
</style>
