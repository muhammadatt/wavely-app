<script setup>
/**
 * MODULA SLIDE SWITCH — a round puck in a sunken 88 × 40 track, its lamp
 * beside it (the kit's SIDECHAIN / OVERSAMPLE).
 */
defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  color: { type: String, default: 'var(--m-accent)' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="m-switch" :class="{ 'is-disabled': disabled }">
    <span class="m-switch-lamp" :style="modelValue ? { background: color, boxShadow: `0 0 6px ${color}` } : null"></span>
    <button
      type="button" class="m-switch-track m-focusable" role="switch" :aria-checked="String(modelValue)"
      :aria-label="label || undefined" :disabled="disabled" @click="emit('update:modelValue', !modelValue)"
    >
      <span class="m-switch-puck" :style="{ left: modelValue ? '51px' : '3px' }"></span>
    </button>
    <span v-if="label" class="m-caption" style="color:#aeb6bd">{{ label }}</span>
  </div>
</template>

<style scoped>
.m-switch { display: flex; align-items: center; gap: 14px; transition: opacity .15s ease; }
.m-switch.is-disabled { opacity: .4; }
.m-switch-lamp { width: 9px; height: 9px; border-radius: 50%; background: var(--m-lamp-off); box-shadow: inset 0 1px 1px rgba(0, 0, 0, .7); }
.m-switch-track {
  position: relative;
  width: 88px;
  height: 40px;
  border: none;
  border-radius: 22px;
  cursor: pointer;
  background: linear-gradient(180deg, #15171a, #23262b);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85), 0 1px 0 rgba(255, 255, 255, .05);
}
.m-switch-track:disabled { cursor: default; }
.m-switch-puck {
  position: absolute;
  top: 3px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  transition: left .18s cubic-bezier(.4, 1.4, .5, 1);
  background: linear-gradient(160deg, #50555e, #2b2e34);
  box-shadow: 0 8px 14px -5px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 1px rgba(0, 0, 0, .6);
}
</style>
