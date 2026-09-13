<script setup>
/**
 * Horizontal slide. A header row carries the label and the value; an optional
 * footer carries end-stop captions. Continuous by default; `options` snaps it
 * between named stops (the design's SC HPF slide).
 */
import { computed } from 'vue'
import { glow, deep } from './modulaTheme.js'
import { dragFraction, quantize } from './useModulaDrag.js'

const props = defineProps({
  modelValue: { type: [Number, String], required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0 },
  /** [{ value, label }] — snaps the slide between these, evenly spaced. */
  options: { type: Array, default: null },
  color: { type: String, default: '#ff8b3d' },
  label: { type: String, default: '' },
  formatValue: { type: Function, default: null },
  footLeft: { type: String, default: '' },
  footRight: { type: String, default: '' },
  /** Put the value in the footer centre instead of the header (design's SC HPF). */
  valueInFoot: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const detented = computed(() => Array.isArray(props.options) && props.options.length > 1)
const index = computed(() => detented.value
  ? Math.max(0, props.options.findIndex(o => o.value === props.modelValue))
  : -1)
const frac = computed(() => {
  if (detented.value) return index.value / (props.options.length - 1)
  const span = props.max - props.min
  return span > 0 ? Math.max(0, Math.min(1, (Number(props.modelValue) - props.min) / span)) : 0
})
const valueText = computed(() => {
  if (props.formatValue) return props.formatValue(props.modelValue)
  if (detented.value) return props.options[index.value]?.label ?? ''
  return String(props.modelValue)
})

const down = dragFraction('x', 220, () => frac.value, (f) => {
  if (detented.value) {
    emit('update:modelValue', props.options[Math.round(f * (props.options.length - 1))].value)
  } else {
    emit('update:modelValue', quantize(props.min + f * (props.max - props.min), props.step))
  }
}, () => !props.disabled)

const fill = computed(() => ({
  width: `${(frac.value * 100).toFixed(1)}%`,
  background: `linear-gradient(90deg,${deep(props.color)},${props.color})`,
  boxShadow: `0 0 14px ${glow(props.color)}`,
}))
// The cap is 22 px on a track it should not overhang, hence 94 % of travel.
const cap = computed(() => ({ left: `${(frac.value * 94).toFixed(1)}%` }))
</script>

<template>
  <div class="msl" :class="{ 'msl-disabled': disabled }">
    <div v-if="label || !valueInFoot" class="msl-head">
      <div>{{ label }}</div>
      <div v-if="!valueInFoot" class="msl-head-value">{{ valueText }}</div>
    </div>
    <div class="msl-track-wrap" @pointerdown="down">
      <div class="msl-track"></div>
      <div class="msl-fill" :style="fill"></div>
      <div class="msl-cap" :style="cap"></div>
    </div>
    <div v-if="footLeft || footRight || valueInFoot" class="msl-foot">
      <div>{{ footLeft }}</div>
      <div v-if="valueInFoot" class="msl-foot-value">{{ valueText }}</div>
      <div>{{ footRight }}</div>
    </div>
  </div>
</template>

<style scoped>
.msl { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.msl-disabled { opacity: .38; }
.msl-disabled .msl-track-wrap { cursor: default; }
.msl-head { display: flex; justify-content: space-between; font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .2em; color: #79808a; }
.msl-head-value { color: #d5dbe2; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.msl-track-wrap { position: relative; height: 30px; display: grid; align-items: center; cursor: ew-resize; touch-action: none; }
.msl-track { position: absolute; left: 0; right: 0; height: 9px; border-radius: 6px; background: linear-gradient(180deg, #15171a, #212429); box-shadow: inset 0 2px 6px rgba(0,0,0,.85); }
.msl-fill { position: absolute; left: 0; height: 9px; border-radius: 6px; }
.msl-cap {
  position: absolute; width: 22px; height: 22px; border-radius: 50%;
  background: linear-gradient(160deg, #4c515a, #2a2d33);
  box-shadow: 0 8px 14px -5px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.18);
}
.msl-foot { display: flex; justify-content: space-between; font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #565d66; }
.msl-foot-value { color: #aeb5be; font-variant-numeric: tabular-nums; }
</style>
