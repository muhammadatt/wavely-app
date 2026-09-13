<script setup>
/**
 * Pill toggle with an indicator LED to its left and a label to its right.
 */
import { computed } from 'vue'
import { glow, OFF_LED, OFF_LED_SHADOW } from './modulaTheme.js'

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  label: { type: String, default: '' },
  color: { type: String, default: '#ff8b3d' },
  title: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  /** 'normal' (74 x 34) | 'small' (46 x 22) — for a switch that belongs to one knob. */
  size: { type: String, default: 'normal' },
})
const emit = defineEmits(['update:modelValue'])

const led = computed(() => props.modelValue
  ? { background: props.color, boxShadow: `0 0 10px ${glow(props.color)}` }
  : { background: OFF_LED, boxShadow: OFF_LED_SHADOW })

function toggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <div class="msw" :class="{ 'msw-disabled': disabled, 'msw-small': size === 'small' }" :title="title">
    <div class="msw-led" :style="led"></div>
    <div class="msw-track" @click="toggle">
      <div class="msw-thumb" :style="{ left: modelValue ? (size === 'small' ? '26px' : '43px') : (size === 'small' ? '2px' : '3px') }"></div>
    </div>
    <div v-if="label" class="msw-label">{{ label }}</div>
  </div>
</template>

<style scoped>
.msw { display: flex; align-items: center; gap: 12px; }
.msw-disabled { opacity: .38; }
.msw-disabled .msw-track { cursor: default; }
.msw-led { width: 8px; height: 8px; border-radius: 50%; }
.msw-track {
  position: relative; width: 74px; height: 34px; border-radius: 20px; cursor: pointer;
  background: linear-gradient(180deg, #15171a, #23262b); box-shadow: inset 0 2px 6px rgba(0,0,0,.85);
}
.msw-thumb {
  position: absolute; top: 3px; width: 28px; height: 28px; border-radius: 50%;
  transition: left .18s cubic-bezier(.4,1.4,.5,1);
  background: linear-gradient(160deg, #50555e, #2b2e34);
  box-shadow: 0 8px 14px -5px rgba(0,0,0,.95), inset 0 1px 0 rgba(255,255,255,.18);
}
.msw-small { gap: 8px; }
.msw-small .msw-led { width: 6px; height: 6px; }
.msw-small .msw-track { width: 46px; height: 22px; border-radius: 12px; }
.msw-small .msw-thumb { top: 2px; width: 18px; height: 18px; }
.msw-small .msw-label { font-size: 9px; }
.msw-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .18em; color: #79808a; white-space: nowrap; }
</style>
