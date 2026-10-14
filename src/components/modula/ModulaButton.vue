<script setup>
/**
 * MODULA BUTTON — 36 px pill, Inter 700 12.5.
 *
 *   primary    cyan, the commit action (Apply)
 *   accent     amber (Render)
 *   secondary  raised outline (Preview)
 *   ghost      a flat outline (Cancel)
 *   toggle     a latching outline with a lamp (Loop) — v-model
 *
 * Disabled is any of them at 40 %.
 */
defineProps({
  variant: { type: String, default: 'secondary' },
  /** For `toggle`. */
  modelValue: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})
const emit = defineEmits(['click', 'update:modelValue'])
</script>

<template>
  <button
    :type="type" class="m-btn m-focusable" :class="[`m-btn--${variant}`, { 'is-on': variant === 'toggle' && modelValue }]"
    :disabled="disabled" :aria-pressed="variant === 'toggle' ? String(modelValue) : undefined"
    @click="variant === 'toggle' ? emit('update:modelValue', !modelValue) : emit('click', $event)"
  >
    <span v-if="variant === 'toggle'" class="m-btn-lamp"></span>
    <slot />
  </button>
</template>

<style scoped>
.m-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 36px;
  box-sizing: border-box;
  padding: 0 16px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  font: 700 12.5px/1 var(--m-font-ui);
  letter-spacing: .02em;
  transition: filter .15s ease, transform .08s ease, opacity .15s ease;
}
.m-btn:hover:not(:disabled) { filter: brightness(1.08); }
.m-btn:active:not(:disabled) { transform: translateY(1px); }
.m-btn:disabled { opacity: .4; cursor: default; }
.m-btn--primary { color: #08161a; background: linear-gradient(180deg, #7fe6ef, #3fd0de); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .45), 0 0 0 1px rgba(0, 0, 0, .55), 0 6px 12px -6px rgba(0, 0, 0, .9); }
.m-btn--accent { color: #1b1408; background: linear-gradient(180deg, #f2ba62, #e8a33d); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .4), 0 0 0 1px rgba(0, 0, 0, .55), 0 6px 12px -6px rgba(0, 0, 0, .9); }
.m-btn--secondary { color: var(--m-ink); background: transparent; box-shadow: var(--m-shadow-raised); }
.m-btn--ghost { color: var(--m-ink-2); background: rgba(255, 255, 255, .04); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); }
.m-btn--toggle { color: var(--m-ink-3); background: rgba(255, 255, 255, .04); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); }
.m-btn--toggle.is-on { color: var(--m-ink); background: transparent; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 0 0 1px rgba(63, 208, 222, .55), 0 6px 12px -6px rgba(0, 0, 0, .9); }
.m-btn-lamp { width: 7px; height: 7px; border-radius: 50%; background: var(--m-lamp-off); box-shadow: inset 0 1px 1px rgba(0, 0, 0, .7); }
.m-btn--toggle.is-on .m-btn-lamp { background: var(--m-second); box-shadow: 0 0 6px var(--m-second); }
</style>
