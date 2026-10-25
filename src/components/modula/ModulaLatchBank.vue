<script setup>
/**
 * MODULA LATCHING KEY BANK — push-down keys that pop each other out, like a
 * tape deck's transport keys (layout study 2b). The pressed key sits lower in
 * its tray and its lamp comes on; the others stand proud and dark.
 *
 * One of N, so it behaves as a radio group: a click latches a key, the arrow
 * keys move the latch. The lamp takes the ACCENT by default — the key is the
 * parameter's value, as on the reference — pass `color` for a mode.
 */
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: null },
  /** `[{ value, label, title? }]`, left to right. */
  options: { type: Array, required: true },
  label: { type: String, default: '' },
  color: { type: String, default: 'var(--m-accent)' },
  keyWidth: { type: Number, default: 58 },
  keyHeight: { type: Number, default: 82 },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const tabStop = computed(() => {
  const i = props.options.findIndex(o => o.value === props.modelValue)
  return i < 0 ? 0 : i
})

function pick(v) {
  if (!props.disabled && v !== props.modelValue) emit('update:modelValue', v)
}

function onKey(e, i) {
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  e.preventDefault()
  const n = props.options.length
  const j = (i + d + n) % n
  pick(props.options[j].value)
  e.currentTarget.parentElement?.children[j]?.focus()
}
</script>

<template>
  <div class="m-latch" :class="{ 'is-disabled': disabled }" :style="{ '--m-latch-lamp': color }">
    <div class="m-latch-tray" role="radiogroup" :aria-label="ariaLabel || label || undefined">
      <button
        v-for="(o, i) in options" :key="String(o.value)" type="button"
        class="m-latch-key m-focusable" :class="{ 'is-on': o.value === modelValue }"
        role="radio" :aria-checked="String(o.value === modelValue)"
        :tabindex="i === tabStop ? 0 : -1" :disabled="disabled" :title="o.title"
        :style="{ width: `${keyWidth}px`, height: `${keyHeight}px` }"
        @click="pick(o.value)" @keydown="onKey($event, i)"
      >
        <span class="m-latch-lamp"></span>
        <span class="m-latch-label">{{ o.label }}</span>
      </button>
    </div>
    <div v-if="label" class="m-caption" style="font-size:8px">{{ label }}</div>
  </div>
</template>

<style scoped>
.m-latch { display: flex; flex-direction: column; align-items: center; gap: 12px; user-select: none; transition: opacity .15s ease; }
.m-latch.is-disabled { opacity: .4; }
.m-latch-tray { display: flex; gap: 4px; padding: 6px 6px 10px; border-radius: 10px; background: var(--m-well); box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85); }
.m-latch-key {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding: 9px 0 0;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  background: linear-gradient(180deg, #4a4f57, #33373e);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 4px 0 #1d1f23, 0 8px 12px -4px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .65);
  transition: transform .08s, box-shadow .08s;
}
.m-latch-key:disabled { cursor: default; }
.m-latch-key.is-on {
  transform: translateY(4px);
  background: linear-gradient(180deg, #2a2e34, #33373e);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .75), 0 0 0 1px rgba(0, 0, 0, .7);
}
.m-latch-key:not(.is-on):not(:disabled):active { transform: translateY(2px); }
.m-latch-lamp {
  width: 22px;
  height: 4px;
  border-radius: 2px;
  background: #2c3036;
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, .6);
}
.is-on .m-latch-lamp { background: var(--m-latch-lamp); box-shadow: 0 0 6px var(--m-latch-lamp); }
.m-latch-label { font: 700 15px/1 var(--m-font-mono); color: var(--m-ink-3); }
.is-on .m-latch-label { color: var(--m-ink); }
</style>
