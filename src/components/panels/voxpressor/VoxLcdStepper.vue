<script setup>
/**
 * VOXPRESSOR LCD STEPPER — a small amber LCD with up / down keys
 * (docs/design/voxpressor, "VoxLcd"; adapted from the OS-2A pre-gain LCD).
 * One of N, wrapping: up steps forward, down back; arrow keys on the LCD do
 * the same. Used for the Peaks timing and the output ceiling.
 */
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: null },
  /** `[{ value, label, title? }]` */
  options: { type: Array, required: true },
  surface: { type: String, default: 'dark' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const index = computed(() => Math.max(0, props.options.findIndex(o => o.value === props.modelValue)))
const current = computed(() => props.options[index.value])

function step(d) {
  if (props.disabled) return
  const n = props.options.length
  const o = props.options[(index.value + d + n) % n]
  if (o && o.value !== props.modelValue) emit('update:modelValue', o.value)
}
function onKey(e) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
}
</script>

<template>
  <div class="vl" :class="{ 'is-light': surface === 'light', 'is-disabled': disabled }">
    <div
      class="vl-well m-focusable" role="spinbutton" :tabindex="disabled ? -1 : 0"
      :aria-label="ariaLabel || undefined" :aria-valuetext="current?.label"
      :aria-disabled="disabled ? 'true' : undefined"
      :title="current?.title" @keydown="onKey"
    >
      <div class="vl-sheen"></div>
      <span class="vl-text">{{ current?.label }}</span>
    </div>
    <div class="vl-keys">
      <button type="button" class="vl-key" :disabled="disabled" :aria-label="`${ariaLabel} next`" @click="step(1)">
        <span class="vl-up"></span>
      </button>
      <button type="button" class="vl-key" :disabled="disabled" :aria-label="`${ariaLabel} previous`" @click="step(-1)">
        <span class="vl-down"></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.vl { display: flex; align-items: flex-start; gap: 3px; user-select: none; transition: opacity .15s ease; }
.vl.is-disabled { opacity: .45; }
.vl-well {
  position: relative; width: 64px; height: 26px; box-sizing: border-box; border: 1px solid #000; border-radius: 2px; overflow: hidden;
  background: linear-gradient(180deg, #07080a 0%, #0d0f12 55%, #060708 100%);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, .95), 0 1px 0 rgba(255, 255, 255, .06);
}
.vl.is-light .vl-well { box-shadow: inset 0 2px 4px rgba(0, 0, 0, .95), 0 1px 0 rgba(255, 255, 255, .6); }
.vl-sheen {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(255, 255, 255, .1) 0%, rgba(255, 255, 255, 0) 42%), radial-gradient(90% 70% at 50% 120%, rgba(255, 164, 53, .07), rgba(0, 0, 0, 0) 70%);
}
.vl-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: 500 10px/1 var(--m-font-mono); letter-spacing: .06em; color: #c09055; text-shadow: 0 0 4px rgba(255, 140, 40, .25); white-space: nowrap;
}
.vl-keys { display: flex; flex-direction: column; gap: 2px; }
.vl-key {
  width: 13px; height: 12px; padding: 0; border: none; border-radius: 2px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(180deg, #54585f 0%, #3a3e44 42%, #25282d 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), inset 0 -1px 2px rgba(0, 0, 0, .6), 0 1px 2px rgba(0, 0, 0, .5);
}
.vl-key:active:not(:disabled) { transform: translateY(1px); }
.vl-key:disabled { cursor: default; }
.vl-key:focus-visible { outline: 2px solid #7fe9f6; outline-offset: 1px; }
.vl-up { width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; border-bottom: 4px solid #f4f7f8; }
.vl-down { width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; border-top: 4px solid #f4f7f8; }
</style>
