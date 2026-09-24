<script setup>
import { computed, nextTick, ref } from 'vue'
import LcdSpinner from './LcdSpinner.vue'
import LampButton from './LampButton.vue'
import { formatSignedDb } from './hardwareDial.js'

/**
 * A secondary setting folded away on the faceplate and opened in place: an
 * LCD stepper, with an optional AUTO lamp.
 *
 * Collapsed, it is one engraved line — `PRE-GAIN −3.6 dB`, `LOOKAHEAD OFF` —
 * so the face stays clean for the users who never need it. Clicking the line
 * opens the stepper in the same slot; the ✕ (or Escape) folds it back. The
 * slot keeps one height in both states, so nothing on the face moves.
 *
 * With `auto` (true/false rather than null) it carries the take-over contract
 * of Pre-Gain, the input alignment: AUTO measures it, stepping takes over.
 *
 * ⚠ FOR PRE-GAIN THE COLLAPSED LINE IS NOT DECORATION. The offset is a
 * property of the FILE, and a user who cannot see it fixes a mis-measured file
 * with the drive knob instead — right for this file, and then carried into
 * every preset they save. So the number stays visible, and a hand-set value is
 * loud about being one: amber, and labelled MANUAL, because a forgotten
 * override is the real cost of folding the control away.
 */
const props = defineProps({
  /** The offset in effect, dB. */
  modelValue: { type: Number, required: true },
  /**
   * Whether the value is the automatic measurement. Null (the default) means
   * the control has no AUTO at all, and no lamp is drawn.
   */
  auto: { type: Boolean, default: null },
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  step: { type: Number, default: 0.5 },
  disabled: { type: Boolean, default: false },
  name: { type: String, required: true },
  format: { type: Function, default: formatSignedDb },
})
const emit = defineEmits(['update:modelValue', 'update:auto'])

const open = ref(false)
const readout = ref(null)
const closeBtn = ref(null)

const hasAuto = computed(() => props.auto !== null)
const manual = computed(() => props.auto === false)
const text = computed(() => `${props.name.toUpperCase()} ${props.format(props.modelValue)}${manual.value ? ' · MANUAL' : ''}`)
const title = computed(() => {
  if (!hasAuto.value) return `${props.name}. Click to adjust.`
  return props.auto
    ? `${props.name}, measured from this file. Click to adjust.`
    : `${props.name}, set by hand for this file. Click to adjust or return to auto.`
})

async function expand() {
  open.value = true
  await nextTick()
  closeBtn.value?.focus({ preventScroll: true })
}
async function collapse() {
  open.value = false
  await nextTick()
  readout.value?.focus({ preventScroll: true })
}
function onKeyDown(e) {
  if (e.key === 'Escape' && open.value) {
    // Folds the control; the plugin window's own Escape must not fire too.
    e.stopPropagation()
    collapse()
  }
}
</script>

<template>
  <div class="pg" @keydown="onKeyDown">
    <button
      v-if="!open"
      ref="readout"
      type="button"
      class="pg-readout"
      :class="{ 'is-manual': manual }"
      :title="title"
      :aria-expanded="false"
      @click="expand"
    >{{ text }}</button>

    <div v-else class="pg-open" role="group" :aria-label="name">
      <div class="pg-gutter">
        <button ref="closeBtn" type="button" class="pg-close" :aria-label="`Hide ${name}`" title="Hide" @click="collapse">
          <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="pg-lcd">
        <LcdSpinner
          :model-value="modelValue"
          @update:model-value="v => emit('update:modelValue', v)"
          :min="min" :max="max" :step="step"
          :dim="auto === true"
          :disabled="disabled"
          :label="name"
          :format="format"
        />
        <div class="pg-title pg-title--lcd">{{ name }}</div>
      </div>
      <div class="pg-auto">
        <LampButton
          v-if="hasAuto"
          :on="auto"
          :size="22"
          :disabled="disabled"
          :title="auto ? 'Measured from the file. Click to set it by hand.' : 'Set by hand. Click to measure it from the file.'"
          @click="emit('update:auto', !auto)"
        />
        <div v-if="hasAuto" class="pg-title">Auto</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* One height open or closed: LCD 26 + gap 5 + label 9. */
.pg { height: 40px; display: flex; align-items: center; justify-content: center; }
.pg-readout {
  padding: 3px 6px; border: 0; border-radius: 3px; background: none; cursor: pointer; outline: none;
  font: 400 9px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .11em; white-space: nowrap;
  color: var(--hw-dim, #8f8b84); transition: color .15s ease, background-color .15s ease;
}
.pg-readout:hover { color: var(--hw-dim-hover, #c9c5be); background: var(--hw-hover-bg, rgba(255,255,255,.05)); }
.pg-readout:focus-visible { box-shadow: 0 0 0 1.5px rgba(255,164,53,.55); }
.pg-readout.is-manual { color: var(--hw-manual, #d9a060); text-shadow: var(--hw-manual-glow, 0 0 4px rgba(255,140,40,.25)); }
.pg-readout.is-manual:hover { color: var(--hw-manual-hover, #f0b876); }

.pg-open { height: 40px; display: flex; align-items: flex-start; justify-content: center; gap: 6px; }
.pg-gutter { width: 33px; flex: 0 0 auto; display: flex; justify-content: flex-end; padding-top: 6px; }
.pg-close {
  width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px; cursor: pointer; outline: none;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--hw-dim, #8f8b84); transition: background-color .15s ease, color .15s ease;
}
.pg-close:hover { background: var(--hw-hover-bg, rgba(255,255,255,.08)); color: var(--hw-ink, #f2f0ec); }
.pg-close:focus-visible { box-shadow: 0 0 0 1.5px rgba(255,164,53,.6); }
.pg-lcd { width: 96px; flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 5px; }
.pg-auto { width: 33px; flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 5px; }
.pg-title {
  font: 400 9px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .16em; text-transform: uppercase;
  color: var(--hw-ink, #f2f0ec); text-shadow: var(--hw-ink-shadow, 0 1px 0 rgba(0,0,0,.9)); white-space: nowrap;
}
.pg-title--lcd { letter-spacing: .18em; transform: translateX(-8px); }
</style>
