<script setup>
/**
 * MODULA PAD — a round 56 px button with a lamp in its face (the kit's MUTE /
 * SOLO / LINK / PHASE). Each pad carries its own lamp colour.
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
  <div class="m-pad" :class="{ 'is-disabled': disabled }">
    <button
      type="button" class="m-pad-btn m-focusable" :aria-pressed="String(modelValue)" :aria-label="label || undefined"
      :disabled="disabled" @click="emit('update:modelValue', !modelValue)"
    >
      <span class="m-pad-lamp" :style="modelValue ? { background: color, boxShadow: `0 0 6px ${color}` } : null"></span>
    </button>
    <span v-if="label" class="m-caption" style="color:#aeb6bd">{{ label }}</span>
  </div>
</template>

<style scoped>
.m-pad { display: flex; flex-direction: column; align-items: center; gap: 10px; transition: opacity .15s ease; }
.m-pad.is-disabled { opacity: .4; }
.m-pad-btn {
  width: 56px;
  height: 56px;
  border: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  background: linear-gradient(160deg, #3c4047, #24272c);
  box-shadow: 0 12px 20px -10px rgba(0, 0, 0, .9), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .65);
}
.m-pad-btn:active:not(:disabled) { transform: translateY(1px); }
.m-pad-btn:disabled { cursor: default; }
.m-pad-lamp { width: 11px; height: 11px; border-radius: 50%; background: #33373d; box-shadow: inset 0 1px 2px rgba(0, 0, 0, .8); }
</style>
