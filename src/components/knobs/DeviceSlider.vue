<script setup>
import { computed } from 'vue'

/**
 * Horizontal fader for the effect faceplates — the knob's sibling.
 *
 * Knobs win for anything you dial by feel, but they're a poor fit for wide
 * ranges you read numerically (crossover frequencies, multipliers), where a
 * linear track shows position-within-range at a glance. Same label typography,
 * same accent-tinted readout and same machined cap as Knob, so a panel mixing
 * the two still reads as one instrument.
 *
 * Built on input[type=range] so keyboard control and screen-reader semantics
 * come for free rather than being reimplemented on a div.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  label: { type: String, default: '' },
  accent: { type: String, default: '#f5a623' },
  formatValue: { type: Function, default: v => String(Math.round(v)) },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const pct = computed(() => {
  const raw = (props.modelValue - props.min) / (props.max - props.min)
  return Math.max(0, Math.min(1, raw)) * 100
})

const valColor = computed(() => `color-mix(in srgb, ${props.accent} 60%, #ffffff)`)
</script>

<template>
  <div
    class="dev-slider w-full select-none"
    :style="{
      '--accent': accent,
      '--pct': pct + '%',
      opacity: disabled ? 0.4 : 1,
    }"
  >
    <div class="flex items-baseline justify-between gap-2 mb-[7px]">
      <span class="dev-slider__label uppercase">{{ label }}</span>
      <span class="dev-slider__value tabular-nums" :style="{ color: valColor }">
        {{ formatValue(modelValue) }}
      </span>
    </div>

    <input
      type="range"
      class="dev-slider__input"
      :min="min" :max="max" :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      @input="emit('update:modelValue', Number($event.target.value))"
    />
  </div>
</template>

<style scoped>
.dev-slider__label {
  font: 600 10px/1 'Inter', system-ui, sans-serif;
  letter-spacing: 0.14em;
  color: rgba(255, 255, 255, 0.55);
}

.dev-slider__value {
  font: 500 13px/1 'JetBrains Mono', monospace;
}

.dev-slider__input {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 20px;
  background: transparent;
  cursor: ew-resize;
}
.dev-slider__input:disabled {
  cursor: default;
}

/* Groove: recessed channel, filled to the current value and glowing like the
   knob's arc does. */
.dev-slider__input::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background:
    linear-gradient(90deg,
      var(--accent) 0%,
      var(--accent) var(--pct),
      rgba(255, 255, 255, 0.07) var(--pct),
      rgba(255, 255, 255, 0.07) 100%);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.65),
    inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}
.dev-slider__input::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.65);
}
.dev-slider__input::-moz-range-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
}

/* Cap: the same brushed-metal treatment as the knob's centre. */
.dev-slider__input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 17px;
  height: 17px;
  margin-top: -5.5px;
  border-radius: 999px;
  background: radial-gradient(circle at 50% 34%, #78808b 0%, #454d57 55%, #262c34 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    inset 0 -2px 3px rgba(0, 0, 0, 0.55),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
.dev-slider__input::-moz-range-thumb {
  width: 17px;
  height: 17px;
  border: none;
  border-radius: 999px;
  background: radial-gradient(circle at 50% 34%, #78808b 0%, #454d57 55%, #262c34 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    0 3px 7px rgba(0, 0, 0, 0.6);
}

.dev-slider__input:focus-visible {
  outline: none;
}
.dev-slider__input:focus-visible::-webkit-slider-thumb {
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
.dev-slider__input:focus-visible::-moz-range-thumb {
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
</style>
