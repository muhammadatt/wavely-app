<script setup>
/**
 * The OFFLINE tag on a registry row whose operation is an offline process
 * (registry `offline`). Outlined rather than filled, so it reads as a kind of
 * plugin and never competes with the PRO tag, which is about the user's plan.
 */
import Icon from './Icon.vue'

defineProps({ show: { type: Boolean, default: false } })
</script>

<template>
  <span
    v-if="show"
    class="offline-badge shrink-0 inline-flex items-center gap-[3px] font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[5px] py-[2px] rounded-[4px]"
    title="Offline process — not real-time. Settings are heard only after you process the selection; Undo reverts it"
  >
    <Icon name="offline" :size="9" :stroke-width="2.5" />
    OFFLINE
  </span>
</template>

<style scoped>
.offline-badge {
  color: #9fc4e8;
  box-shadow: inset 0 0 0 1px rgba(159, 196, 232, 0.45);
}
</style>
