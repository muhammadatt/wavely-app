<script setup>
/**
 * MODULA CHIP — the smallest button in the kit: 22 px, a raised outline, an
 * optional lamp. For per-item controls in a tight row, where a full LED pill
 * would not fit (the EQ's band strips: ON, S, ×).
 *
 * As a toggle (`v-model`) the lamp lights in `color` when on; as a plain
 * button (no model) it emits `click`. `danger` tints the hover red, for a
 * control that removes something.
 */
const props = defineProps({
  modelValue: { type: Boolean, default: null },
  label: { type: String, default: '' },
  /** Show a lamp before the label. */
  lamp: { type: Boolean, default: false },
  color: { type: String, default: 'var(--m-accent)' },
  danger: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'click'])

function press(e) {
  if (props.modelValue !== null) emit('update:modelValue', !props.modelValue)
  emit('click', e)
}
</script>

<template>
  <button
    type="button" class="m-chip m-focusable" :class="{ 'is-on': modelValue === true, 'is-danger': danger }"
    :disabled="disabled" :title="title || undefined" :aria-label="ariaLabel || undefined"
    :aria-pressed="modelValue === null ? undefined : String(modelValue)"
    :style="modelValue === true ? { boxShadow: `inset 0 1px 0 rgba(255,255,255,.1), 0 0 0 1px color-mix(in srgb, ${color} 50%, #000000), 0 4px 8px -4px rgba(0,0,0,.9)` } : null"
    @click="press"
  >
    <span v-if="lamp" class="m-chip-lamp" :style="modelValue ? { background: color, boxShadow: `0 0 5px ${color}` } : null"></span>
    <span v-if="label" class="m-chip-text">{{ label }}</span>
    <slot />
  </button>
</template>

<style scoped>
.m-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 22px;
  min-width: 22px;
  box-sizing: border-box;
  padding: 0 7px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  background: transparent;
  color: var(--m-ink-off);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .07), 0 0 0 1px rgba(0, 0, 0, .6), 0 4px 8px -4px rgba(0, 0, 0, .9);
  transition: color .15s ease, opacity .15s ease, filter .15s ease;
}
.m-chip:hover:not(:disabled) { color: var(--m-ink); filter: brightness(1.1); }
.m-chip.is-danger:hover:not(:disabled) { color: #ff8a7e; }
.m-chip.is-on { color: var(--m-ink); }
.m-chip:disabled { opacity: .35; cursor: default; }
.m-chip-lamp { width: 6px; height: 6px; border-radius: 50%; background: var(--m-lamp-off); box-shadow: inset 0 1px 1px rgba(0, 0, 0, .7); }
.m-chip-text { font: 700 9px/1 var(--m-font-ui); letter-spacing: .1em; white-space: nowrap; }
</style>
