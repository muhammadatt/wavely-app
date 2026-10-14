<script setup>
/**
 * MODULA SEGMENTED SWITCH — one of N, lit cap on a sunken tray.
 *
 *   inline  the compact tray under a knob (PHAT*SS's CLEAN / PHAT)
 *   tile    the kit's big tiles (GRID / WAVE / SPEC / CLIP)
 *
 * The lit option takes the SECOND hue: a segmented switch states a mode, not
 * the value of a parameter.
 */
const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  /** `[{ value, label, title? }]` */
  options: { type: Array, required: true },
  variant: { type: String, default: 'inline' },
  color: { type: String, default: 'var(--m-second)' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

function pick(v) {
  if (!props.disabled && v !== props.modelValue) emit('update:modelValue', v)
}

function onKey(e, i) {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const n = props.options.length
  const next = props.options[(i + d + n) % n]
  pick(next.value)
  e.currentTarget.parentElement?.children[(i + d + n) % n]?.focus()
}
</script>

<template>
  <div
    class="m-seg" :class="[`m-seg--${variant}`, { 'is-disabled': disabled }]"
    role="radiogroup" :aria-label="ariaLabel || undefined"
  >
    <button
      v-for="(o, i) in options" :key="String(o.value)" type="button"
      class="m-seg-opt m-focusable" :class="{ 'is-on': o.value === modelValue }"
      role="radio" :aria-checked="String(o.value === modelValue)"
      :tabindex="o.value === modelValue ? 0 : -1"
      :disabled="disabled" :title="o.title"
      :style="o.value === modelValue ? { color } : null"
      @click="pick(o.value)" @keydown="onKey($event, i)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped>
.m-seg { display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: linear-gradient(180deg, #1a1c20, #22252a); box-shadow: inset 0 2px 6px rgba(0, 0, 0, .8); transition: opacity .15s ease; }
.m-seg.is-disabled { opacity: .4; }
.m-seg-opt {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 5px 10px;
  border-radius: 6px;
  font: 700 9px/1.2 var(--m-font-ui);
  letter-spacing: .14em;
  color: var(--m-ink-off);
  white-space: nowrap;
}
.m-seg-opt:disabled { cursor: default; }
.m-seg-opt:not(.is-on):not(:disabled):hover { color: rgba(255, 255, 255, .7); }
.m-seg-opt.is-on {
  background: linear-gradient(180deg, #3c4149, #2a2e34);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 6px 12px -6px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6);
}
.m-seg--tile { gap: 10px; padding: 10px; border-radius: 16px; box-shadow: inset 0 2px 8px rgba(0, 0, 0, .8); }
.m-seg--tile .m-seg-opt {
  flex: 1;
  height: 70px;
  border-radius: 12px;
  font-size: 11px;
  background: linear-gradient(180deg, #2c3036, #23262b);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .6);
}
.m-seg--tile .m-seg-opt.is-on {
  background: linear-gradient(180deg, #3c4149, #2a2e34);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 8px 16px -8px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6);
}
</style>
