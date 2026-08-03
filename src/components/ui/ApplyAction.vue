<script setup>
import BaseButton from './BaseButton.vue'
import Icon from './Icon.vue'

/**
 * The bottom of every operation panel: either the action row, or the reason you
 * can't use it yet — never both.
 *
 * Showing a dimmed button *and* a notice explaining why it's dimmed says the
 * same thing twice, and fading the notice out on selection left a hole where it
 * had been. These are two states of one control, so they swap in place. Both
 * states are locked to the same height so the swap doesn't shift the panel —
 * which only holds while messages fit on one line (roughly 38 characters at the
 * 280px rail width).
 *
 * On effect faceplates the row also carries Preview. That button is present on
 * every effect, enabled only where the effect can run live in the playback
 * chain — a disabled control with a tooltip teaches that real-time tuning
 * exists, where simply omitting it teaches nothing. Someone who meets a
 * server-rendered effect first would otherwise never discover that the
 * compressors respond to knob movement while the audio plays.
 */
defineProps({
  // Whether the operation's precondition is satisfied.
  met: { type: Boolean, required: true },
  // Shown in place of the row while `met` is false.
  message: { type: String, default: 'Make a selection to apply' },
  label: { type: String, required: true },
  icon: { type: String, default: 'check' },
  // A second gate applied only once `met` is true — e.g. a gain of 0 dB is a
  // no-op. The button stays visible but inert, because there is no missing
  // precondition to explain.
  disabled: { type: Boolean, default: false },
  // Tooltip for that inert state, since it has no on-screen explanation.
  disabledHint: { type: String, default: '' },
  size: { type: String, default: 'lg' }, // 'md' | 'lg'
  // Effect faceplates pass their own accent so Apply belongs to the plugin
  // rather than to the app. Null keeps the default cyan used in the rail.
  accent: { type: String, default: null },
  textColor: { type: String, default: null },

  // ── Preview ──────────────────────────────────────────────────────────────
  // Effects opt in; the rail's edit panels have nothing to audition.
  showPreview: { type: Boolean, default: false },
  // False for effects that can only be rendered (server-side, or otherwise not
  // expressible as a live worklet). The control still renders — disabled.
  previewable: { type: Boolean, default: true },
  previewing: { type: Boolean, default: false },
  previewHint: {
    type: String,
    default: 'Real-time preview isn’t available for this effect — apply to hear the result (Ctrl+Z undoes it)',
  },
})

defineEmits(['apply', 'toggle-preview'])
</script>

<template>
  <div class="apply-action" :class="`apply-action--${size}`">
    <Transition name="apply-swap" mode="out-in">
      <div v-if="!met" key="notice" class="apply-notice" role="note">
        {{ message }}
      </div>

      <div v-else key="row" class="flex items-stretch gap-2">
        <BaseButton
          v-if="showPreview"
          :size="size"
          color="ghost"
          class="shrink-0"
          :disabled="!previewable"
          :title="previewable
            ? (previewing ? 'Stop preview' : 'Play the selection through this effect')
            : previewHint"
          :aria-label="previewing ? 'Stop preview' : 'Preview'"
          @click="$emit('toggle-preview')"
        >
          <Icon :name="previewing ? 'stop' : 'play'" :size="13" />
          {{ previewing ? 'Stop' : 'Preview' }}
        </BaseButton>

        <BaseButton
          class="flex-1"
          :size="size"
          block
          :color="accent ? 'accent' : 'primary'"
          :accent="accent"
          :text-color="textColor"
          :disabled="disabled"
          :title="disabled ? disabledHint : ''"
          @click="$emit('apply')"
        >
          <Icon :name="icon" :size="13" :stroke-width="2.5" />
          {{ label }}
        </BaseButton>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* Heights match BaseButton's own padding + text metrics at each size, so the
   notice is a drop-in stand-in for the row rather than an approximation. */
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
