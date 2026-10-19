<script setup>
/**
 * MODULA LED PILL — a latching button with its own lamp (the kit's TOGGLE,
 * the Inflator's BAND SPLIT / CLIP, every plugin's ON / BYPASS).
 *
 * Off is a raised outline with a dark lamp; on lights the lamp and rings the
 * pill in the same colour at 55 %. `onLabel` / `offLabel` swap the text where
 * the state has a name of its own (ON / BYPASS).
 */
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  onLabel: { type: String, default: '' },
  offLabel: { type: String, default: '' },
  color: { type: String, default: 'var(--m-accent)' },
  /** 'md' (the face's toggles) | 'sm' (30 px, the header). */
  size: { type: String, default: 'md' },
  /** Ring the pill in the lamp's colour when on. */
  ring: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const text = computed(() => (props.modelValue ? props.onLabel || props.label : props.offLabel || props.label))
</script>

<template>
  <button
    type="button" class="m-pill m-focusable" :class="[`m-pill--${size}`, { 'is-on': modelValue }]"
    :disabled="disabled" :aria-pressed="String(modelValue)" :title="title || undefined"
    :style="modelValue && ring ? { boxShadow: `inset 0 1px 0 rgba(255,255,255,.1), 0 0 0 1px color-mix(in srgb, ${color} 55%, #000000), 0 6px 12px -6px rgba(0,0,0,.9)` } : null"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="m-pill-lamp" :style="modelValue ? { background: color, boxShadow: `0 0 6px ${color}` } : null"></span>
    <span class="m-pill-text">{{ text }}</span>
  </button>
</template>

<style scoped>
.m-pill {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 999px;
  padding: 9px 16px;
  box-shadow: var(--m-shadow-raised);
  transition: opacity .15s ease, filter .15s ease;
}
.m-pill--sm { gap: 8px; height: 30px; padding: 0 13px; box-sizing: border-box; }
.m-pill:hover:not(:disabled) { filter: brightness(1.08); }
.m-pill:disabled { opacity: .4; cursor: default; }
.m-pill-lamp {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--m-lamp-off);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, .7);
  transition: background-color .15s ease, box-shadow .15s ease;
}
.m-pill-text {
  font: 700 10px/1 var(--m-font-ui);
  letter-spacing: .14em;
  white-space: nowrap;
  color: var(--m-ink-off);
}
.m-pill.is-on .m-pill-text { color: var(--m-ink); }
</style>
