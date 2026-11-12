<script setup>
/**
 * MODULA STEPPED / DETENT BAR — N cells lit up to the chosen one, for a
 * control whose positions are few and ordered (a ratio, an oversampling
 * factor). Click a cell to choose it; the arrow keys walk the steps.
 */
const props = defineProps({
  modelValue: { type: Number, default: 0 },
  count: { type: Number, default: 8 },
  color: { type: String, default: 'var(--m-accent)' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
  /** Optional per-step names for assistive tech and tooltips. */
  labels: { type: Array, default: null },
})
const emit = defineEmits(['update:modelValue'])

function set(i) {
  if (props.disabled) return
  const v = Math.max(0, Math.min(props.count - 1, i))
  if (v !== props.modelValue) emit('update:modelValue', v)
}
function onKey(e) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); set(props.modelValue + 1) }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); set(props.modelValue - 1) }
}
</script>

<template>
  <div
    class="m-steps m-focusable" :class="{ 'is-disabled': disabled }" role="slider" tabindex="0"
    :aria-label="ariaLabel || undefined" :aria-valuemin="0" :aria-valuemax="count - 1" :aria-valuenow="modelValue"
    :aria-valuetext="labels?.[modelValue]"
    @keydown="onKey"
  >
    <div
      v-for="i in count" :key="i" class="m-step" :title="labels?.[i - 1]"
      :style="i - 1 <= modelValue
        ? { background: `linear-gradient(180deg, color-mix(in srgb, ${color} 70%, #ffffff), ${color})`, boxShadow: `0 0 6px ${color}, inset 0 1px 0 rgba(255,255,255,.3)` }
        : null"
      @click="set(i - 1)"
    ></div>
  </div>
</template>

<style scoped>
.m-steps { display: flex; gap: 8px; border-radius: 8px; transition: opacity .15s ease; }
.m-steps.is-disabled { opacity: .4; pointer-events: none; }
.m-step {
  flex: 1;
  height: 40px;
  border-radius: 8px;
  cursor: pointer;
  background: linear-gradient(180deg, #34383f, #23262b);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .07), 0 4px 8px -4px rgba(0, 0, 0, .8);
}
</style>
