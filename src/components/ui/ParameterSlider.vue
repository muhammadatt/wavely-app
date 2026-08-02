<script setup>
import { computed } from 'vue'

/**
 * Label + value readout + range input — the parameter row every processor UI
 * is built from.
 *
 * This markup previously existed as fourteen hand-copied blocks in
 * EffectsPanel alone, which is why adding a processor meant pasting rather
 * than composing.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  label: { type: String, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0.01 },
  // Trailing unit appended to the default readout, e.g. 'dBFS', 'Hz', '%'.
  unit: { type: String, default: '' },
  // Fixed decimal places for the default readout. Defaults to 2 for
  // fractional steps and 0 for integer ones, which covers every current use.
  precision: { type: Number, default: null },
  // Full control of the readout when a number isn't the right answer —
  // e.g. Noise Reduction shows Low/Medium/High rather than 0-100.
  formatValue: { type: Function, default: null },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const decimals = computed(() => {
  if (props.precision !== null) return props.precision
  return Number.isInteger(props.step) ? 0 : 2
})

const readout = computed(() => {
  if (props.formatValue) return props.formatValue(props.modelValue)
  const n = props.modelValue.toFixed(decimals.value)
  return props.unit ? `${n} ${props.unit}` : n
})
</script>

<template>
  <div :class="disabled ? 'opacity-45' : ''">
    <div class="flex justify-between items-center mb-[6px]">
      <span class="text-[11px] font-semibold text-text-dim">{{ label }}</span>
      <span class="font-mono text-[11px] font-semibold text-text-muted tabular-nums">{{ readout }}</span>
    </div>
    <input
      type="range"
      class="param-range w-full h-1.5 rounded-full appearance-none cursor-pointer"
      :min="min" :max="max" :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @input="emit('update:modelValue', Number($event.target.value))"
    />
  </div>
</template>

<style scoped>
.param-range {
  background: var(--color-surface-3);
  accent-color: var(--color-accent);
}
.param-range:disabled {
  cursor: default;
}
.param-range:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 3px;
}
</style>
