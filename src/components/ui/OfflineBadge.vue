<script setup>
/**
 * The RENDER tag on a registry row whose operation is an offline process
 * (registry `offline`): a filled orange chip with a clock icon. It names what
 * the plugin does — renders the selection once — rather than what it lacks;
 * an earlier "OFFLINE" label read as "unavailable".
 */
import Icon from './Icon.vue'

defineProps({ show: { type: Boolean, default: false } })
</script>

<template>
  <span
    v-if="show"
    class="offline-badge shrink-0 inline-flex items-center gap-[3px] font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[5px] py-[2px] rounded-[4px]"
    title="Renders the selection — not real-time. Nothing is heard until it is applied; Undo reverts it"
  >
    <Icon name="offline" :size="9" :stroke-width="2.5" />
    RENDER
  </span>
</template>

<style scoped>
.offline-badge {
  color: #5e2b02;
  background: #e78040
}
</style>
