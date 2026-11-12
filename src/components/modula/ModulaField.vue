<script setup>
/**
 * MODULA FIELD — a labelled value well: drag to adjust, click to type, scroll
 * to nudge. DeviceField's behaviour on the kit's tokens (the `--m-well` inset,
 * Inter and JetBrains Mono, the amber accent), with optional selector arrows.
 *
 * For the settings that are read far more often than they are turned — a
 * ceiling, a trim, a frequency — where a knob would spend ~70 px of height on
 * one number. It also stands in for a short list of named choices: let the value
 * be the index and give it a `formatValue` that prints the name and a `parse`
 * that finds one from the first letters typed (the Saturation Bench's curve).
 *
 * DRAG AND TYPE BOTH, and the gesture decides which: a press that moves is a
 * drag, a press that does not focuses the box and selects its contents. Arrows
 * step ONE step, ten with Shift. The `‹ ›` buttons step the same way; with `wrap`
 * they carry on round from one end to the other, which suits a list and not a
 * quantity.
 *
 * `log` moves the value multiplicatively (drag, scroll and arrows through one
 * 0..1 position, a notch being a semitone) — for frequency, where a linear field
 * is not a control at all. The linear path is plain `(v - min) / (max - min)`.
 */
import { computed, ref } from 'vue'

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
  color: { type: String, default: 'var(--m-accent)' },
  disabled: { type: Boolean, default: false },
  /** Pixels of vertical drag for the full range. Matches the knobs' travel. */
  travelPx: { type: Number, default: 150 },
  log: { type: Boolean, default: false },
  /** Show `‹ ›` selector arrows at the ends of the well. */
  arrows: { type: Boolean, default: false },
  /** The arrows continue round from one end to the other. */
  wrap: { type: Boolean, default: false },
  /** Total width in px, arrows included. */
  width: { type: Number, default: 80 },
  /** Double-click returns here; null disables the reset. */
  defaultValue: { type: Number, default: null },
  ariaLabel: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

const inputEl = ref(null)
const editing = ref(false)
const draft = ref('')
/** True once a press has moved far enough to be a drag rather than a click. */
let moved = false
let start = null

const shown = computed(() => (editing.value ? draft.value : props.formatValue(props.modelValue)))

function clamp(v) {
  return Math.max(props.min, Math.min(props.max, v))
}

/** Value to a 0..1 position on the control's travel, and back. */
function toPos(v) {
  return props.log
    ? Math.log(clamp(v) / props.min) / Math.log(props.max / props.min)
    : (clamp(v) - props.min) / (props.max - props.min)
}

function fromPos(t) {
  const p = Math.max(0, Math.min(1, t))
  return props.log
    ? props.min * Math.pow(props.max / props.min, p)
    : props.min + p * (props.max - props.min)
}

/** One notch, in position units: a semitone on a log field, else a step. */
const notch = computed(() => (props.log
  ? (1 / 12) / Math.log2(props.max / props.min)
  : props.step / (props.max - props.min)))

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

const nudge = (dir, mult = 1) => commit(fromPos(toPos(props.modelValue) + dir * notch.value * mult))

/** The arrow buttons: one notch, wrapping at the ends when asked to. */
function stepBy(dir) {
  if (props.disabled) return
  const atEnd = dir > 0 ? props.modelValue >= props.max : props.modelValue <= props.min
  if (atEnd && props.wrap) commit(dir > 0 ? props.min : props.max)
  else nudge(dir)
}

const atMin = computed(() => !props.wrap && props.modelValue <= props.min)
const atMax = computed(() => !props.wrap && props.modelValue >= props.max)

function onWheel(e) {
  if (props.disabled || editing.value) return
  const dir = e.deltaY < 0 ? 1 : -1
  const v = fromPos(toPos(props.modelValue) + dir * notch.value * (e.shiftKey ? 10 : 1))
  if (quantise(v) === props.modelValue) return
  e.preventDefault()
  commit(v)
}

function onPointerDown(e) {
  if (props.disabled || editing.value || e.button > 0) return
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
  commit(fromPos(toPos(start.value) + dy / props.travelPx))
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

function reset() {
  if (props.disabled || props.defaultValue == null) return
  commit(props.defaultValue)
}

function onKeyDown(e) {
  // Up and down adjust whether or not the field is being typed into: a text
  // input has no use for them, and someone who has just clicked into the box is
  // the most likely person to want to nudge it. Left and right are the cursor's
  // while typing, so they only step when the box is not being edited.
  const mult = e.shiftKey ? 10 : 1
  if (e.key === 'ArrowUp' || (!editing.value && e.key === 'ArrowRight')) nudge(1, mult)
  else if (e.key === 'ArrowDown' || (!editing.value && e.key === 'ArrowLeft')) nudge(-1, mult)
  else if (e.key === 'Enter') endEdit(true)
  else if (e.key === 'Escape') endEdit(false)
  else return
  e.preventDefault()
}
</script>

<template>
  <div class="m-field" :class="{ 'is-disabled': disabled }" :style="{ width: `${width}px` }">
    <div class="m-field-well" :class="{ 'is-editing': editing }" :style="{ '--m-field-color': color }">
      <button
        v-if="arrows" type="button" class="m-field-arrow m-focusable" tabindex="-1"
        aria-label="Previous" title="Previous" :disabled="disabled || atMin"
        @click="stepBy(-1)"
      >‹</button>
      <div
        class="m-field-grab" :class="editing ? 'is-text' : 'is-drag'"
        @wheel="onWheel" @dblclick="reset"
        @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
      >
        <input
          ref="inputEl" class="m-field-input m-focusable" :value="shown" :readonly="!editing" :disabled="disabled"
          :style="{ pointerEvents: editing ? 'auto' : 'none' }"
          role="spinbutton" :aria-label="ariaLabel || label || undefined"
          :aria-valuenow="modelValue" :aria-valuemin="min" :aria-valuemax="max"
          :aria-valuetext="formatValue(modelValue)"
          @input="draft = $event.target.value" @keydown="onKeyDown" @blur="endEdit(true)"
        />
      </div>
      <button
        v-if="arrows" type="button" class="m-field-arrow m-focusable" tabindex="-1"
        aria-label="Next" title="Next" :disabled="disabled || atMax"
        @click="stepBy(1)"
      >›</button>
    </div>
    <span v-if="label" class="m-caption m-field-label">{{ label }}</span>
  </div>
</template>

<style scoped>
.m-field { display: flex; flex-direction: column; align-items: center; gap: 6px; user-select: none; transition: opacity .15s ease; }
.m-field.is-disabled { opacity: .4; }
.m-field-well {
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: center;
  border-radius: 5px;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
  transition: box-shadow .15s ease;
}
.m-field-well.is-editing {
  box-shadow: var(--m-shadow-well), 0 0 0 1px color-mix(in srgb, var(--m-field-color) 65%, transparent);
}
.m-field-grab { flex: 1; min-width: 0; padding: 5px 2px; touch-action: none; }
.m-field-grab.is-drag { cursor: ns-resize; }
.m-field-grab.is-text { cursor: text; }
.m-field.is-disabled .m-field-grab { cursor: default; }
.m-field-input {
  width: 100%;
  padding: 0;
  border: none;
  outline: none;
  text-align: center;
  background: transparent;
  font: 500 11px/1 var(--m-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--m-ink);
}
.m-field-arrow {
  flex: none;
  width: 18px;
  align-self: stretch;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  font: 700 13px/1 var(--m-font-ui);
  color: var(--m-ink-off);
  border-radius: 5px;
  transition: color .15s ease, background-color .15s ease;
}
.m-field-arrow:hover:not(:disabled) { color: var(--m-ink); background: rgba(255, 255, 255, .06); }
.m-field-arrow:disabled { cursor: default; opacity: .35; }
.m-field-label { text-align: center; }
</style>
