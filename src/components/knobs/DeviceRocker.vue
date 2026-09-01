<script setup>
/**
 * 1b — Rocker. On and off, where the physical metaphor is worth its 24 px.
 *
 * The cap travels and the engraved `I`/`O` stay put, so the exposed side is the
 * one you would press next — which is how a real rocker reads and why the cap
 * deliberately COVERS the engraving of the side currently selected.
 *
 * ⚠ THIS IS THE ON/OFF ROCKER. Two named modes are `DeviceChoiceRocker`, which
 * is the same moulding (`ROCKER_BODY`) with the engraving replaced by the two
 * labels — see the note there about why a lit/unlit cap cannot express a choice
 * between peers.
 */
import { computed } from 'vue'
import { ROCKER_BODY, litCap, DARK_CAP } from './switchChrome.js'

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  /** Engraving under the switch. What the switch controls, not its state. */
  label: { type: String, default: '' },
  /** Plain-English state beside the switch, e.g. "in circuit" / "bypassed". */
  readout: { type: String, default: '' },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

const body = computed(() => ({
  ...ROCKER_BODY,
  width: '46px',
  opacity: props.disabled ? 0.45 : 1,
}))

// Left when on, right when off — so the lit cap sits over the `I`.
const cap = computed(() => ({
  position: 'absolute',
  top: '2px',
  bottom: '2px',
  width: '20px',
  left: props.modelValue ? '2px' : '24px',
  borderRadius: '6px',
  transition: 'left .15s ease',
  ...(props.modelValue ? litCap(props.accent, 80) : DARK_CAP),
}))

const ENGRAVE = "position:absolute;top:0;bottom:0;display:flex;align-items:center;"
  + "font:700 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.28);pointer-events:none"
</script>

<template>
  <div class="inline-flex items-center gap-[20px]">
    <div class="flex flex-col items-center gap-[7px]">
      <button
        type="button"
        role="switch"
        :aria-checked="modelValue"
        :aria-label="label || title || 'Toggle'"
        :title="title"
        :disabled="disabled"
        class="cursor-pointer disabled:cursor-default"
        :style="body"
        @click="emit('update:modelValue', !modelValue)"
      >
        <span :style="`${ENGRAVE};left:5px`">I</span>
        <span :style="`${ENGRAVE};right:5px`">O</span>
        <span :style="cap" />
      </button>
      <span
        v-if="label"
        style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.14em;color:var(--color-text-faint)"
      >{{ label }}</span>
    </div>
    <span
      v-if="readout"
      style="font:500 11px 'JetBrains Mono',monospace;color:var(--color-text-dim)"
    >{{ readout }}</span>
  </div>
</template>
