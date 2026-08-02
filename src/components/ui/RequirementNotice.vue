<script setup>
/**
 * The amber "you need a selection first" notice.
 *
 * Existed as six near-identical copies across the effect and edit panels, in
 * two flavours: some hid outright, others faded so the Apply button below them
 * didn't jump. `reserveSpace` keeps both behaviours available; fading is the
 * default because the layout shift is the more annoying of the two.
 */
defineProps({
  // Whether the requirement is satisfied. The notice shows when false.
  met: { type: Boolean, required: true },
  message: { type: String, default: 'Make a selection on the waveform first' },
  // Keep the box in flow and fade it out rather than unmounting it.
  reserveSpace: { type: Boolean, default: true },
})
</script>

<template>
  <div
    v-if="reserveSpace || !met"
    class="requirement-notice text-[11px] font-semibold rounded-lg px-3 py-[10px] text-center leading-relaxed"
    :class="reserveSpace ? ['transition-opacity duration-700', met ? 'opacity-0' : 'opacity-100'] : ''"
    :aria-hidden="met"
    role="note"
  >
    {{ message }}
  </div>
</template>

<style scoped>
.requirement-notice {
  color: var(--color-warn);
  background: color-mix(in srgb, var(--color-warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warn) 32%, transparent);
}
</style>
