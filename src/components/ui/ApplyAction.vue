<script setup>
import BaseButton from './BaseButton.vue'
import Icon from './Icon.vue'

/**
 * The bottom of every operation panel: either the Apply button, or the reason
 * you can't press it yet — never both.
 *
 * Showing a dimmed button *and* a notice explaining why it's dimmed says the
 * same thing twice, and fading the notice out on selection left a hole where it
 * had been. These are two states of one control, so they swap in place.
 *
 * Both states are locked to the same height, so the swap doesn't shift the
 * panel. That only holds while messages fit on one line — keep them short
 * (roughly 38 characters at the 280px rail width).
 */
defineProps({
  // Whether the operation's precondition is satisfied.
  met: { type: Boolean, required: true },
  // Shown in place of the button while `met` is false.
  message: { type: String, default: 'Make a selection to apply' },
  label: { type: String, required: true },
  icon: { type: String, default: 'check' },
  // A second gate applied only once `met` is true — e.g. a gain of 0 dB is a
  // no-op. The button stays visible but inert, because there is no missing
  // precondition to explain.
  disabled: { type: Boolean, default: false },
  size: { type: String, default: 'lg' }, // 'md' | 'lg'
  // Effect faceplates pass their own accent so Apply belongs to the plugin
  // rather than to the app. Null keeps the default cyan used in the rail.
  accent: { type: String, default: null },
  textColor: { type: String, default: null },
})

defineEmits(['apply'])
</script>

<template>
  <div class="apply-action" :class="`apply-action--${size}`">
    <Transition name="apply-swap" mode="out-in">
      <div v-if="!met" key="notice" class="apply-notice" role="note">
        {{ message }}
      </div>

      <BaseButton
        v-else
        key="apply"
        :size="size"
        block
        :color="accent ? 'accent' : 'primary'"
        :accent="accent"
        :text-color="textColor"
        :disabled="disabled"
        @click="$emit('apply')"
      >
        <Icon :name="icon" :size="13" :stroke-width="2.5" />
        {{ label }}
      </BaseButton>
    </Transition>
  </div>
</template>

<style scoped>
/* Heights match BaseButton's own padding + text metrics at each size, so the
   notice is a drop-in stand-in for the button rather than an approximation. */
.apply-action--md { --apply-h: 36px; }
.apply-action--lg { --apply-h: 44px; }

.apply-action :deep(.base-btn) {
  min-height: var(--apply-h);
}

.apply-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-height: var(--apply-h);
  padding: 6px 14px;
  /* Pill, matching BaseButton's default radius so the silhouette is unchanged
     across the swap. */
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--color-warn);
  background: color-mix(in srgb, var(--color-warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warn) 32%, transparent);
}

/* out-in: the outgoing state finishes leaving before the incoming one arrives,
   so the two never overlap and the box never doubles in height. */
.apply-swap-enter-active,
.apply-swap-leave-active {
  transition: opacity 0.16s ease;
}
.apply-swap-enter-from,
.apply-swap-leave-to {
  opacity: 0;
}
</style>
