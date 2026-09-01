<script setup>
/**
 * 1a — Lamp pill. A named engage, for a setting that is genuinely on or off.
 *
 * THE LABEL NEVER CHANGES, and that is the whole idea. A two-button bank spends
 * its width saying ON and OFF next to each other and makes you read which one is
 * lit; this says what the thing IS once, and the lamp and the wash carry the
 * state. One row at 22 px, so it sits inline beside a knob instead of setting
 * the height of the row it is in.
 *
 * ⚠ IT NEEDS SOMETHING TO BE READ AGAINST, and this is a reported failure
 * rather than a worry. ResoTame's harmonic protection shipped as a lit pill and
 * came back as unreadable: alone on a row it says "there is a button here", not
 * "the thing this controls is on". A lamp bead states it better than the bare
 * accent wash that was reported, but not well enough to stand by itself. Use it
 * where a sibling pill sits beside it, or where a caption underneath names the
 * current state in words — as both of Inflator's do. Otherwise reach for
 * `DeviceChoiceRocker`, which draws both positions at all times.
 *
 * ⚠ USE IT ONLY WHERE OFF IS GENUINELY THE ABSENCE OF THE THING. Two named modes
 * with no dominant one — COMP/LIMIT, THICK/PRESENCE — are `DeviceChoiceRocker`:
 * there is no "off" in a choice between peers, and a lit/unlit pill would invent
 * one.
 */
import { computed } from 'vue'
import { lampStyle } from './switchChrome.js'

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  /** The engraving. A noun for the thing engaged, not a state. */
  label: { type: String, required: true },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

/**
 * ⚠ THE LAMP FOLLOWS THE VALUE EVEN WHILE DISABLED, and gating it on `disabled`
 * was a bug caught by rendering the panel: an engaged control with its preview
 * off drew an unlit lamp, i.e. it reported the opposite of its own state. The
 * pill dims as a whole to say "you cannot change this right now"; what it is set
 * to is a separate fact and stays legible.
 */
const lamp = computed(() => lampStyle(props.modelValue, props.accent))

const pill = computed(() => {
  const on = props.modelValue
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    height: '22px',
    padding: '0 10px',
    borderRadius: '999px',
    border: on
      ? `1px solid color-mix(in srgb, ${props.accent} 50%, transparent)`
      : '1px solid rgba(255,255,255,.09)',
    background: on
      ? `color-mix(in srgb, ${props.accent} 12%, transparent)`
      : 'rgba(255,255,255,.04)',
    color: on
      ? `color-mix(in srgb, ${props.accent} 70%, #ffffff)`
      : 'rgba(255,255,255,.42)',
    opacity: props.disabled ? 0.45 : 1,
    transition: 'all .15s ease',
  }
})
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :title="title"
    :disabled="disabled"
    class="cursor-pointer disabled:cursor-default"
    :style="pill"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span :style="lamp" />
    <span style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.14em">{{ label }}</span>
  </button>
</template>
