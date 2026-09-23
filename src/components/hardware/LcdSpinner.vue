<script setup>
import { onBeforeUnmount } from 'vue'

/**
 * A small amber LCD with up/down steppers, for a value that wants exact
 * numbers more than it wants a knob. Hold a stepper to repeat; the wheel
 * works over the display.
 *
 * `dim` greys the digits (the value is being driven by something else, e.g.
 * an AUTO measurement) without disabling the steppers: pressing one takes
 * over, the same contract a knob under AUTO has.
 */
const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  step: { type: Number, default: 0.5 },
  dim: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  label: { type: String, default: '' },
  format: { type: Function, default: (v) => v.toFixed(1) },
})
const emit = defineEmits(['update:modelValue'])

function nudge(dir) {
  const next = Math.max(props.min, Math.min(props.max, props.modelValue + dir * props.step))
  const q = Number((Math.round(next / props.step) * props.step).toFixed(6))
  if (q !== props.modelValue || props.dim) emit('update:modelValue', q)
}

const REPEAT_DELAY_MS = 380
const REPEAT_EVERY_MS = 70
let delayId = null
let repeatId = null

function stop() {
  clearTimeout(delayId); clearInterval(repeatId)
  delayId = repeatId = null
}

function press(dir, e) {
  if (props.disabled) return
  e.preventDefault()
  nudge(dir)
  stop()
  delayId = setTimeout(() => { repeatId = setInterval(() => nudge(dir), REPEAT_EVERY_MS) }, REPEAT_DELAY_MS)
}

function onWheel(e) {
  if (props.disabled) return
  e.preventDefault()
  nudge(e.deltaY < 0 ? 1 : -1)
}

function onKeyDown(dir, e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nudge(dir) }
}

onBeforeUnmount(stop)
</script>

<template>
  <div class="lcd-spin" :class="{ 'is-disabled': disabled }">
    <div class="lcd" :class="{ 'is-dim': dim }" :title="label" @wheel="onWheel">
      <div class="lcd-glass" />
      <div class="lcd-text">{{ format(modelValue) }}</div>
    </div>
    <div class="spin-col">
      <button
        type="button" class="spin" :disabled="disabled" :aria-label="`${label} up`"
        @pointerdown="press(1, $event)" @pointerup="stop" @pointerleave="stop" @pointercancel="stop"
        @keydown="onKeyDown(1, $event)"
      ><span class="arrow up" /></button>
      <button
        type="button" class="spin" :disabled="disabled" :aria-label="`${label} down`"
        @pointerdown="press(-1, $event)" @pointerup="stop" @pointerleave="stop" @pointercancel="stop"
        @keydown="onKeyDown(-1, $event)"
      ><span class="arrow down" /></button>
    </div>
  </div>
</template>

<style scoped>
.lcd-spin { display: flex; align-items: flex-start; gap: 3px; }
.lcd {
  position: relative; width: 50px; height: 26px; box-sizing: border-box; border: 1px solid #000; border-radius: 2px; overflow: hidden;
  background: linear-gradient(180deg,#07080a 0%,#0d0f12 55%,#060708 100%);
  box-shadow: inset 0 2px 4px rgba(0,0,0,.95), inset 0 -1px 0 rgba(255,255,255,.07), 0 1px 0 rgba(255,255,255,.09);
}
.lcd-glass { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg,rgba(255,255,255,.1) 0%,rgba(255,255,255,0) 42%), radial-gradient(90% 70% at 50% 120%,rgba(255,164,53,.07),rgba(0,0,0,0) 70%); }
.lcd-text {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: 400 11px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .04em;
  color: #c09055; text-shadow: 0 0 4px rgba(255,140,40,.25);
  transition: color 160ms ease, text-shadow 160ms ease;
}
.lcd.is-dim .lcd-text { color: #6f5a3e; text-shadow: none; }
.spin-col { display: flex; flex-direction: column; gap: 2px; }
.spin {
  position: relative; width: 13px; height: 12px; padding: 0; border: 0; border-radius: 2px;
  display: flex; align-items: center; justify-content: center; cursor: pointer; outline: none;
  -webkit-tap-highlight-color: transparent;
  background: linear-gradient(180deg,#54585f 0%,#3a3e44 42%,#25282d 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 2px rgba(0,0,0,.6), 0 1px 2px rgba(0,0,0,.7);
}
.spin:not(:disabled):active { background: linear-gradient(180deg,#2c2f34 0%,#3a3e44 100%); }
.spin:focus-visible { box-shadow: 0 0 0 1.5px rgba(255,164,53,.6); }
.spin:disabled { cursor: default; }
.arrow { width: 0; height: 0; border-left: 3px solid transparent; border-right: 3px solid transparent; }
.arrow.up { border-bottom: 4px solid #9b9894; filter: drop-shadow(0 1px 0 rgba(0,0,0,.8)); }
.arrow.down { border-top: 4px solid #9b9894; filter: drop-shadow(0 -1px 0 rgba(0,0,0,.8)); }
</style>
