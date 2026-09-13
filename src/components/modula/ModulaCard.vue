<script setup>
/**
 * A raised card on the Modula chassis. `inset` gives the sunk variant the
 * design uses for the meter bay.
 */
defineProps({
  inset: { type: Boolean, default: false },
  /** A small caption in the top-left, for a card that groups a sub-section. */
  title: { type: String, default: '' },
  /** 16 px padding instead of 22. */
  compact: { type: Boolean, default: false },
})
</script>

<template>
  <div class="mcard" :class="{ 'mcard-inset': inset, 'mcard-compact': compact }">
    <div v-if="title" class="mcard-title">{{ title }}</div>
    <slot />
  </div>
</template>

<style scoped>
.mcard {
  min-width: 0;
  padding: 22px;
  border-radius: 22px;
  background: linear-gradient(180deg, #2b2e34, #212429);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 1px rgba(0,0,0,.5);
  box-sizing: border-box;
}
.mcard-inset {
  background: linear-gradient(180deg, #24272c, #1b1d21);
  box-shadow: inset 0 2px 10px rgba(0,0,0,.8), 0 0 0 1px rgba(0,0,0,.5);
}
.mcard-compact { padding: 16px; border-radius: 18px; }
.mcard-title {
  margin-bottom: 16px;
  font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .22em; color: #79808a;
}
</style>
