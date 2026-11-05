<script setup>
/**
 * VOXPRESSOR SLIDE SWITCH — two labelled positions either side of a sunken
 * track with a round puck (docs/design/voxpressor, VoxSelect "slide"). Click
 * a label to go to it, the track to toggle. The lit label takes the accent
 * (darker on the light panel, where a glow would smear).
 */
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  /** Exactly two: `[{ value, label, title? }]`, left then right. */
  options: { type: Array, required: true },
  color: { type: String, default: '#e8a33d' },
  surface: { type: String, default: 'dark' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const light = computed(() => props.surface === 'light')
const right = computed(() => props.modelValue === props.options[1]?.value)
const onInk = computed(() => (light.value ? '#bf782a' : props.color))
const offInk = computed(() => (light.value ? 'rgba(0,0,0,.3)' : 'rgba(255,255,255,.35)'))

function pick(i) {
  const v = props.options[i]?.value
  if (!props.disabled && v !== undefined && v !== props.modelValue) emit('update:modelValue', v)
}
</script>

<template>
  <div class="vs" :class="{ 'is-light': light, 'is-disabled': disabled }">
    <button
      type="button" class="vs-label" :disabled="disabled" :title="options[0].title"
      :style="{ color: right ? offInk : onInk, textShadow: !right && !light ? `0 0 6px ${color}` : 'none' }"
      @click="pick(0)"
    >{{ options[0].label }}</button>
    <button
      type="button" class="vs-track m-focusable" role="switch" :aria-checked="String(right)"
      :aria-label="ariaLabel ? `${ariaLabel}: ${right ? options[1].label : options[0].label}` : undefined"
      :disabled="disabled" @click="pick(right ? 0 : 1)"
    >
      <span class="vs-puck" :style="{ left: right ? '37px' : '3px' }"></span>
    </button>
    <button
      type="button" class="vs-label" :disabled="disabled" :title="options[1].title"
      :style="{ color: right ? onInk : offInk, textShadow: right && !light ? `0 0 6px ${color}` : 'none' }"
      @click="pick(1)"
    >{{ options[1].label }}</button>
  </div>
</template>

<style scoped>
.vs { display: flex; align-items: center; justify-content: center; gap: 10px; transition: opacity .15s ease; }
.vs.is-disabled { opacity: .45; }
.vs-label {
  border: none; background: none; padding: 2px; cursor: pointer; white-space: nowrap;
  font: 700 9px/1 var(--m-font-mono); letter-spacing: .12em; transition: color .15s ease;
}
.vs-label:disabled, .vs-track:disabled { cursor: default; }
.vs-track {
  position: relative; flex: none; width: 64px; height: 30px; padding: 0; border: none; border-radius: 16px; cursor: pointer;
  background: linear-gradient(180deg, #15171a, #23262b);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85), 0 1px 0 rgba(255, 255, 255, .05);
}
.vs.is-light .vs-track {
  background: linear-gradient(180deg, #b9b3a8, #cfc9bf);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .35), inset 0 0 0 1px rgba(0, 0, 0, .12), 0 1px 0 rgba(255, 255, 255, .6);
}
.vs-puck {
  position: absolute; top: 3px; width: 24px; height: 24px; border-radius: 50%;
  transition: left .18s cubic-bezier(.4, 1.4, .5, 1);
  background: linear-gradient(160deg, #56627a, #2b323d);
  box-shadow: 0 8px 14px -5px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 1px rgba(0, 0, 0, .6);
}
.vs.is-light .vs-puck { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2), 0 1px 1px rgba(40, 30, 20, .35), 0 6px 10px -4px rgba(40, 30, 20, .4); }
</style>
