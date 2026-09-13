<script setup>
/**
 * Vertical fader with a lit fill, a value readout and a label. `tag` puts a
 * small pill beside the value — the design's use is an AUTO badge on a fader
 * the plugin is currently driving.
 */
import { computed } from 'vue'
import { glow, deep } from './modulaTheme.js'
import { dragFraction, quantize } from './useModulaDrag.js'

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0 },
  color: { type: String, default: '#ff8b3d' },
  label: { type: String, default: '' },
  formatValue: { type: Function, default: null },
  tag: { type: String, default: '' },
  title: { type: String, default: '' },
  height: { type: Number, default: 180 },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const CAP_H = 28
const frac = computed(() => {
  const span = props.max - props.min
  return span > 0 ? Math.max(0, Math.min(1, (props.modelValue - props.min) / span)) : 0
})
const valueText = computed(() => props.formatValue ? props.formatValue(props.modelValue) : String(props.modelValue))

const down = dragFraction('y', props.height - 10, () => frac.value, (f) => {
  emit('update:modelValue', quantize(props.min + f * (props.max - props.min), props.step))
}, () => !props.disabled)

const fill = computed(() => ({
  height: `${(frac.value * 100).toFixed(1)}%`,
  background: `linear-gradient(180deg,${props.color} 0%,${deep(props.color)} 100%)`,
  boxShadow: `0 0 14px ${glow(props.color)}`,
}))
const cap = computed(() => ({ bottom: `${(frac.value * (props.height - CAP_H)).toFixed(1)}px` }))
const tagStyle = computed(() => ({
  background: `color-mix(in srgb, ${props.color} 20%, transparent)`,
  border: `1px solid color-mix(in srgb, ${props.color} 40%, transparent)`,
  color: `color-mix(in srgb, ${props.color} 65%, #ffffff)`,
}))
</script>

<template>
  <div class="mf" :class="{ 'mf-disabled': disabled }" :title="title">
    <div class="mf-slot" :style="{ height: height + 'px' }" @pointerdown="down">
      <div class="mf-track"></div>
      <div class="mf-fill" :style="fill"></div>
      <div class="mf-cap" :style="cap"><div class="mf-cap-line"></div></div>
    </div>
    <div class="mf-value">
      {{ valueText }}
      <span v-if="tag" class="mf-tag" :style="tagStyle">{{ tag }}</span>
    </div>
    <div v-if="label" class="mf-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.mf { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.mf-disabled { opacity: .38; }
.mf-disabled .mf-slot { cursor: default; }
.mf-slot { position: relative; width: 40px; display: grid; place-items: center; cursor: ns-resize; touch-action: none; }
.mf-track { position: absolute; top: 0; bottom: 0; width: 12px; border-radius: 8px; background: linear-gradient(180deg, #15171a, #212429); box-shadow: inset 0 2px 6px rgba(0,0,0,.85); }
.mf-fill { position: absolute; left: 14px; width: 12px; bottom: 0; border-radius: 8px; }
.mf-cap {
  position: absolute; left: 1px; width: 38px; height: 28px; border-radius: 8px;
  background: linear-gradient(180deg, #4a4f57, #2a2d33);
  box-shadow: 0 10px 16px -6px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.16);
}
.mf-cap-line { position: absolute; left: 8px; right: 8px; top: 13px; height: 2px; border-radius: 2px; background: rgba(0,0,0,.55); box-shadow: 0 1px 0 rgba(255,255,255,.09); }
.mf-value { display: flex; align-items: center; gap: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #e8edf3; white-space: nowrap; font-variant-numeric: tabular-nums; }
.mf-tag { padding: 2px 6px; border-radius: 999px; font: 700 7px/1 'JetBrains Mono', monospace; letter-spacing: .09em; }
.mf-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .2em; color: #79808a; }
</style>
