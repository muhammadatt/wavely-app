<script setup>
/**
 * The Hi-Freq Limiter's amber value LCD (redesign 3b, VoxPressor's readout
 * style): a knob's value printed in a small dark well. Click it to type an
 * exact value — Enter commits, Escape cancels — since the knob's own
 * double-click is the reset.
 */
import { nextTick, ref } from 'vue'

const props = defineProps({
  text: { type: String, required: true },
  /**
   * What the editor opens with: the EXACT value, not the rounded display
   * (Freq reads "10.1k Hz" at 10140 Hz). Defaults to the display text.
   */
  editText: { type: String, default: null },
  /** Parse a typed entry; default: the leading number in it. */
  parse: { type: Function, default: null },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: 'value' },
})
const emit = defineEmits(['commit'])

const editing = ref(false)
const draft = ref('')
let seeded = ''
const inputEl = ref(null)

async function begin() {
  if (props.disabled) return
  seeded = props.editText ?? props.text.replace(/[^\d.+\-−k]/gi, '').replace('−', '-')
  draft.value = seeded
  editing.value = true
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  // Opened and left untouched: commit nothing, so a look never moves the value.
  if (String(draft.value).trim() === seeded) return
  const raw = String(draft.value).replace('−', '-')
  const v = props.parse ? props.parse(raw) : parseFloat(raw)
  if (Number.isFinite(v)) emit('commit', v)
}

function cancel() { editing.value = false }
</script>

<template>
  <input
    v-if="editing" ref="inputEl" v-model="draft" class="hl-lcd hl-lcd--input"
    :aria-label="`${ariaLabel}, type a value`"
    @keydown.enter.prevent="commit" @keydown.esc.prevent.stop="cancel" @blur="commit"
  >
  <button
    v-else type="button" class="hl-lcd" :disabled="disabled"
    :aria-label="`${ariaLabel}: ${text}. Click to type a value`" title="Click to type a value"
    @click="begin"
  >{{ text }}</button>
</template>

<style scoped>
.hl-lcd {
  padding: 3px 6px;
  border: none;
  border-radius: 3px;
  background: #0b0c0e;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .9), 0 1px 0 rgba(255, 255, 255, .06);
  font: 600 9px/1 var(--m-font-mono, 'JetBrains Mono', monospace);
  letter-spacing: .06em;
  color: #e0a65c;
  text-shadow: 0 0 4px rgba(255, 140, 40, .3);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  cursor: text;
}
.hl-lcd:disabled { cursor: default; opacity: .55; }
.hl-lcd--input {
  width: 72px;
  outline: none;
  text-align: center;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .9), 0 0 0 1px rgba(232, 163, 61, .55);
}
</style>
