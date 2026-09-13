<script setup>
/**
 * Segmented selector — the design's CLEAN / VCA / OPTO strip. One lit segment
 * at a time; the lit one carries the colour as a text glow rather than a fill,
 * so a strip of three never reads as three buttons.
 */
import { glow } from './modulaTheme.js'

const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  /** [{ value, label, title? }] */
  options: { type: Array, required: true },
  color: { type: String, default: '#6fd6ff' },
  label: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

function styleFor(opt) {
  const on = opt.value === props.modelValue
  return {
    color: on ? props.color : '#79808a',
    textShadow: on ? `0 0 12px ${glow(props.color)}` : 'none',
    background: on ? 'linear-gradient(180deg,#3c4149,#2a2e34)' : 'transparent',
    boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,.14), 0 6px 12px -6px rgba(0,0,0,.9)' : 'none',
  }
}

function pick(opt) {
  if (props.disabled) return
  emit('update:modelValue', opt.value)
}
</script>

<template>
  <div class="mseg-wrap" :class="{ 'mseg-disabled': disabled }">
    <div v-if="label" class="mseg-label">{{ label }}</div>
    <div class="mseg">
      <div
        v-for="opt in options" :key="String(opt.value)"
        class="mseg-item"
        :style="styleFor(opt)"
        :title="opt.title || ''"
        @click="pick(opt)"
      >{{ opt.label }}</div>
    </div>
  </div>
</template>

<style scoped>
.mseg-wrap { display: flex; flex-direction: column; align-items: center; gap: 9px; }
.mseg-disabled { opacity: .38; }
.mseg-disabled .mseg-item { cursor: default; }
.mseg-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .18em; color: #79808a; }
.mseg {
  display: flex; gap: 8px; padding: 7px; border-radius: 14px;
  background: linear-gradient(180deg, #1a1c20, #22252a); box-shadow: inset 0 2px 8px rgba(0,0,0,.8);
}
.mseg-item {
  padding: 10px 16px; border-radius: 9px; cursor: pointer; user-select: none;
  font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; letter-spacing: .14em; white-space: nowrap;
}
</style>
