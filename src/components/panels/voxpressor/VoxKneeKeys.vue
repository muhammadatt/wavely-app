<script setup>
/**
 * VOXPRESSOR KNEE KEYS — two square keys drawn with their transfer curves,
 * HARD and SOFT (docs/design/voxpressor, "VoxKnee"). The lit key is pressed in
 * and its curve glows in the accent.
 */
const props = defineProps({
  modelValue: { type: String, default: 'hard' },
  /** `[{ value, label?, title, d }]`: d is the 24 × 18 curve; label names the key. */
  options: {
    type: Array,
    default: () => [
      { value: 'hard', title: 'Hard knee', d: 'M3 15 L12 6 L21 4' },
      { value: 'soft', title: 'Soft knee', d: 'M3 15 L8 10 C11 7 14 5.2 21 4' },
    ],
  },
  color: { type: String, default: '#e8a33d' },
  surface: { type: String, default: 'dark' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

function pick(v) {
  if (!props.disabled && v !== props.modelValue) emit('update:modelValue', v)
}
function onKey(e) {
  const i = props.options.findIndex(o => o.value === props.modelValue)
  const n = props.options.length
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); pick(props.options[(i + 1) % n].value) }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); pick(props.options[(i - 1 + n) % n].value) }
}
</script>

<template>
  <div class="vk" :class="{ 'is-light': surface === 'light', 'is-disabled': disabled }" role="radiogroup" :aria-label="ariaLabel || undefined" @keydown="onKey">
    <button
      v-for="o in options" :key="o.value" type="button" role="radio"
      class="vk-key m-focusable" :class="{ 'is-on': o.value === modelValue }"
      :aria-checked="String(o.value === modelValue)" :tabindex="o.value === modelValue ? 0 : -1"
      :title="o.title" :aria-label="o.label || o.title" :disabled="disabled" @click="pick(o.value)"
    >
      <svg viewBox="0 0 24 18" width="24" height="18" fill="none" style="overflow:visible" aria-hidden="true">
        <path
          :d="o.d" :stroke="o.value === modelValue ? color : 'rgba(234,246,248,.45)'" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"
          :style="{ filter: o.value === modelValue ? `drop-shadow(0 0 2px ${color})` : 'none' }"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.vk { display: flex; gap: 8px; user-select: none; transition: opacity .15s ease; }
.vk.is-disabled { opacity: .45; }
.vk-key {
  display: grid; place-items: center; width: 36px; height: 30px; padding: 0; border: none; border-radius: 7px; cursor: pointer;
  transition: transform .08s, box-shadow .12s;
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12), 0 0 0 1px rgba(0, 0, 0, .65), 0 6px 10px -5px rgba(0, 0, 0, .9);
}
.vk-key:hover:not(:disabled) { filter: brightness(1.08); }
.vk-key:disabled { cursor: default; }
.vk-key.is-on {
  transform: translateY(1px);
  background: linear-gradient(180deg, #262d36, #323b48);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .75), 0 0 0 1px rgba(0, 0, 0, .7);
}
.vk.is-light .vk-key { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2), 0 1px 1px rgba(40, 30, 20, .35), 0 5px 9px -4px rgba(40, 30, 20, .4); }
.vk.is-light .vk-key.is-on { box-shadow: inset 0 2px 5px rgba(0, 0, 0, .7), 0 1px 0 rgba(255, 255, 255, .55); }
</style>
