<script setup>
import { computed, ref } from 'vue'

/**
 * A labelled value box — drag to adjust, click to type.
 *
 * The compact alternative to a knob, for the settings that are read far more
 * often than they are turned. A knob costs about 70 px of height to express one
 * number; this costs 30, and on a ceiling like Max Cut or an output Trim the
 * dial adds nothing — nobody sweeps a ceiling looking for a sound, they set it
 * once and want to see where it is. Soothe puts its own max cut and wet trim in
 * exactly this shape for the same reason.
 *
 * DRAG AND TYPE BOTH, and the gesture decides which. A press that moves is a
 * drag; a press that does not is a click, which focuses the field and selects
 * its contents. That way the box is a knob for someone tuning by ear and a
 * number for someone entering a spec, without a modifier or a second control.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  label: { type: String, default: '' },
  /** Value → the text in the box. Its inverse is `parse`. */
  formatValue: { type: Function, default: v => String(Math.round(v)) },
  /** Text → value, or NaN to reject. Kept beside formatValue so they match. */
  parse: { type: Function, default: t => parseFloat(t) },
  unit: { type: String, default: '' },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
  /** Pixels of vertical drag for the full range. Matches Knob's own travel. */
  travelPx: { type: Number, default: 150 },
  width: { type: Number, default: 62 },
})

const emit = defineEmits(['update:modelValue'])

const inputEl = ref(null)
const editing = ref(false)
const draft = ref('')
/** True once a press has moved far enough to be a drag rather than a click. */
let moved = false
let start = null

const shown = computed(() =>
  (editing.value ? draft.value : props.formatValue(props.modelValue)))

function clamp(v) {
  return Math.max(props.min, Math.min(props.max, v))
}

function quantise(v) {
  const stepped = Math.round((v - props.min) / props.step) * props.step + props.min
  // Steps like 0.5 leave float dust that shows up in the readout; round to the
  // decimals the step implies rather than printing 3.0000000000000004.
  const decimals = Math.max(0, -Math.floor(Math.log10(props.step)))
  return clamp(parseFloat(stepped.toFixed(decimals)))
}

function commit(v) {
  const next = quantise(v)
  if (next !== props.modelValue) emit('update:modelValue', next)
}

function onPointerDown(e) {
  if (props.disabled || editing.value) return
  moved = false
  start = { y: e.clientY, value: props.modelValue }
  e.currentTarget.setPointerCapture?.(e.pointerId)
  // Not preventDefault yet: a press that turns out to be a click still has to
  // be able to focus the input.
}

function onPointerMove(e) {
  if (!start) return
  const dy = start.y - e.clientY
  if (!moved && Math.abs(dy) < 3) return
  moved = true
  commit(start.value + (dy / props.travelPx) * (props.max - props.min))
  e.preventDefault()
}

function onPointerUp(e) {
  if (!start) return
  const wasDrag = moved
  start = null
  moved = false
  e.currentTarget.releasePointerCapture?.(e.pointerId)
  if (!wasDrag) beginEdit()
}

function beginEdit() {
  if (props.disabled) return
  editing.value = true
  draft.value = props.formatValue(props.modelValue)
  requestAnimationFrame(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

function endEdit(accept) {
  if (!editing.value) return
  if (accept) {
    const parsed = props.parse(draft.value)
    if (Number.isFinite(parsed)) commit(parsed)
  }
  editing.value = false
  inputEl.value?.blur()
}

function onKeyDown(e) {
  // Arrows adjust whether or not the field is being typed into: a text input
  // has no use for up and down, and someone who has just clicked into the box
  // is the most likely person to want to nudge it. ONE STEP, ten with Shift —
  // the other way round jumped a 0.5 dB trim by 5 dB on the first press, which
  // reads as the field having ignored the key and done something else.
  const mult = e.shiftKey ? 10 : 1
  if (e.key === 'ArrowUp') {
    commit(props.modelValue + props.step * mult)
  } else if (e.key === 'ArrowDown') {
    commit(props.modelValue - props.step * mult)
  } else if (e.key === 'Enter') {
    endEdit(true)
  } else if (e.key === 'Escape') {
    endEdit(false)
  } else {
    return
  }
  e.preventDefault()
}
</script>

<template>
  <div
    class="flex flex-col items-center gap-[5px] select-none"
    :style="{ width: `${width}px`, opacity: disabled ? 0.4 : 1 }"
  >
    <div
      class="w-full rounded-[5px] text-center"
      :class="disabled ? 'cursor-default' : (editing ? 'cursor-text' : 'cursor-ns-resize')"
      :style="{
        padding: '5px 4px',
        background: 'rgba(0,0,0,.34)',
        boxShadow: editing
          ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 60%, transparent)`
          : 'inset 0 0 0 1px rgba(255,255,255,.09)',
      }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <input
        ref="inputEl"
        class="w-full bg-transparent text-center outline-none"
        :style="{
          font: `600 12px 'JetBrains Mono',monospace`,
          color: `color-mix(in srgb, ${accent} 45%, #ffffff)`,
          pointerEvents: editing ? 'auto' : 'none',
        }"
        :value="shown"
        :readonly="!editing"
        :disabled="disabled"
        :aria-label="label"
        role="spinbutton"
        :aria-valuenow="modelValue"
        :aria-valuemin="min"
        :aria-valuemax="max"
        :title="`Drag to adjust, click to type${unit ? ` (${unit})` : ''}`"
        @input="draft = $event.target.value"
        @keydown="onKeyDown"
        @blur="endEdit(true)"
      />
    </div>
    <span
      v-if="label"
      class="uppercase"
      style="font:600 9px/1 'Inter',system-ui;letter-spacing:.12em;color:rgba(255,255,255,.5)"
    >{{ label }}</span>
  </div>
</template>
