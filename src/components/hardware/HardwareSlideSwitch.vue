<script setup>
import { computed } from 'vue'

/**
 * A detented slide switch from the Classic 76 face: printed positions above a
 * recessed track, and a chrome thumb that snaps between them.
 *
 * Click a printed position to go straight to it, or click the track to step
 * to the next one (wrapping), the way a real slide switch is flicked along.
 * Arrow keys move between positions. It is a radio group for assistive tech,
 * because each position is a named choice rather than a point on a scale.
 */
const props = defineProps({
  modelValue: { type: [Number, String], required: true },
  /** [{ value, label, title? }], left to right. */
  options: { type: Array, required: true },
  /** Distance between detents, px. */
  pitch: { type: Number, default: 24 },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const THUMB_W = 22
const EDGE = 3
const width = computed(() => EDGE * 2 + THUMB_W + props.pitch * (props.options.length - 1))
const index = computed(() => Math.max(0, props.options.findIndex(o => o.value === props.modelValue)))
const thumbLeft = computed(() => `${EDGE + index.value * props.pitch}px`)
const labelLeft = (i) => `${EDGE + THUMB_W / 2 + i * props.pitch}px`

function select(i) {
  if (props.disabled) return
  const o = props.options[i]
  if (o && o.value !== props.modelValue) emit('update:modelValue', o.value)
}
function cycle() {
  select((index.value + 1) % props.options.length)
}
function onKeyDown(e) {
  if (props.disabled) return
  const last = props.options.length - 1
  const to = {
    ArrowRight: Math.min(last, index.value + 1), ArrowUp: Math.min(last, index.value + 1),
    ArrowLeft: Math.max(0, index.value - 1), ArrowDown: Math.max(0, index.value - 1),
    Home: 0, End: last,
  }[e.key]
  if (to === undefined) return
  e.preventDefault()
  select(to)
}
</script>

<template>
  <div
    class="hs"
    :class="{ 'is-disabled': disabled }"
    :style="{ width: width + 'px' }"
    role="radiogroup"
    :aria-label="label"
    :aria-disabled="disabled || undefined"
    :tabindex="disabled ? -1 : 0"
    @keydown="onKeyDown"
  >
    <div class="hs-legend">
      <button
        v-for="(o, i) in options" :key="String(o.value)"
        type="button"
        class="hs-pos"
        :class="{ 'is-on': i === index }"
        :style="{ left: labelLeft(i) }"
        role="radio"
        :aria-checked="i === index"
        :title="o.title || o.label"
        tabindex="-1"
        :disabled="disabled"
        @click="select(i)"
      >{{ o.label }}</button>
    </div>
    <div class="hs-track" @click="cycle">
      <div class="hs-slot" />
      <div class="hs-thumb" :style="{ left: thumbLeft, width: THUMB_W + 'px' }"><div class="hs-thumb-line" /></div>
    </div>
  </div>
</template>

<style scoped>
.hs { display: flex; flex-direction: column; gap: 5px; outline: none; user-select: none; }
.hs:focus-visible .hs-track { box-shadow: 0 0 0 1.5px rgba(255,164,53,.55), inset 0 2px 4px rgba(0,0,0,.95); }
.hs-legend { position: relative; height: 9px; }
.hs-pos {
  position: absolute; top: 0; transform: translateX(-50%); padding: 0; border: 0; background: none;
  cursor: pointer; white-space: nowrap; text-transform: uppercase;
  font: 400 9px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .1em;
  color: #9c9993; text-shadow: 0 1px 0 rgba(0,0,0,.9); transition: color .15s ease;
}
.hs-pos.is-on { color: #ffffff; }
.hs-pos:disabled { cursor: default; }
.hs-track {
  position: relative; height: 18px; border-radius: 3px; cursor: pointer;
  background: linear-gradient(180deg,#050506 0%,#111214 70%,#1a1b1d 100%);
  box-shadow: inset 0 2px 4px rgba(0,0,0,.95), inset 0 -1px 0 rgba(255,255,255,.1), 0 1px 0 rgba(255,255,255,.06);
}
.is-disabled .hs-track { cursor: default; }
.hs-slot { position: absolute; left: 6px; right: 6px; top: 8px; height: 2px; border-radius: 1px; background: #000; box-shadow: 0 1px 0 rgba(255,255,255,.05); }
.hs-thumb {
  position: absolute; top: 2px; height: 14px; border-radius: 2px;
  transition: left 110ms cubic-bezier(.3,1.4,.5,1), opacity .15s ease;
  background: linear-gradient(90deg,#9ea1a5 0%,#cfd1d3 24%,#f6f6f5 46%,#dcdddf 62%,#a9acb0 100%);
  box-shadow: inset 1px 0 0 rgba(255,255,255,.9), inset -1px 0 0 rgba(0,0,0,.35), 0 2px 3px rgba(0,0,0,.8), 0 0 0 .5px rgba(0,0,0,.6);
}
.is-disabled .hs-thumb { opacity: .5; }
.hs-thumb-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: #0c0d0e; box-shadow: 1px 0 0 rgba(255,255,255,.5); }
</style>
