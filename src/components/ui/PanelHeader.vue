<script setup>
/**
 * The title block at the top of a rail panel.
 *
 * `back` turns the title into the second level of the rail's list -> detail
 * navigation: the chevron returns to the category list, and `backLabel` names
 * where it returns to.
 */
defineProps({
  title: { type: String, required: true },
  desc: { type: String, default: '' },
  // When set, a back chevron is shown and 'back' is emitted on click.
  back: { type: Boolean, default: false },
  backLabel: { type: String, default: '' },
})

defineEmits(['back'])
</script>

<template>
  <div class="px-5 pt-5 pb-[14px] border-b border-border-1">
    <button
      v-if="back"
      class="panel-back flex items-center gap-[5px] mb-[7px] -ml-1 pl-1 pr-2 py-[3px] rounded-md bg-transparent border-none cursor-pointer text-[11px] font-semibold"
      @click="$emit('back')"
    >
      <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current shrink-0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {{ backLabel }}
    </button>

    <div class="text-[15px] font-bold text-text">{{ title }}</div>
    <div v-if="desc" class="mt-[4px] text-[11.5px] leading-[1.4] text-text-muted">{{ desc }}</div>
  </div>
</template>

<style scoped>
.panel-back {
  color: var(--color-text-faint);
  transition: color 0.15s ease, background-color 0.15s ease;
}
.panel-back:hover {
  color: var(--color-accent-bright);
  background: var(--color-surface-1);
}
.panel-back:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 2px;
}
</style>
