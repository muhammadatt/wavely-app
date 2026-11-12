<script setup>
/**
 * MODULA DETENT SELECTOR — a small knob that snaps between named positions
 * engraved around it (PHAT*SS's TAPE SPEED). Options are given left to right;
 * they spread evenly over ±`spreadDeg`. Drag up turns clockwise, a click on a
 * name goes straight there, the arrow keys step.
 */
import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: null },
  /** `[{ value, label, title? }]`, left to right. */
  options: { type: Array, required: true },
  label: { type: String, default: '' },
  color: { type: String, default: 'var(--m-second)' },
  spreadDeg: { type: Number, default: 50 },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const W = 96
const KNOB = 40
const index = computed(() => Math.max(0, props.options.findIndex(o => o.value === props.modelValue)))
const angleOf = i => (props.options.length < 2 ? 0 : -props.spreadDeg + (2 * props.spreadDeg * i) / (props.options.length - 1))
const deg = computed(() => angleOf(index.value))
const labels = computed(() => props.options.map((o, i) => {
  const a = angleOf(i) * Math.PI / 180
  return { ...o, x: 48 + 40 * Math.sin(a), y: 44 - 37 * Math.cos(a), on: i === index.value }
}))

function setIndex(i) {
  if (props.disabled) return
  const o = props.options[Math.max(0, Math.min(props.options.length - 1, i))]
  if (o && o.value !== props.modelValue) emit('update:modelValue', o.value)
}

const dragging = ref(false)
let startY = 0
let startI = 0
function down(e) {
  if (props.disabled) return
  e.preventDefault()
  dragging.value = true
  startY = e.clientY
  startI = index.value
  e.currentTarget.focus?.({ preventScroll: true })
  e.currentTarget.setPointerCapture?.(e.pointerId)
}
function move(e) {
  if (dragging.value) setIndex(Math.round(startI + (startY - e.clientY) / 30))
}
function up(e) {
  dragging.value = false
  try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
}
function key(e) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setIndex(index.value + 1) }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setIndex(index.value - 1) }
}
</script>

<template>
  <div class="m-detent" :class="{ 'is-disabled': disabled }">
    <div class="m-detent-box" :style="{ width: `${W}px`, height: '68px' }">
      <button
        v-for="(l, i) in labels" :key="String(l.value)" type="button" class="m-detent-label"
        :title="l.title" :disabled="disabled" :tabindex="-1"
        :style="{ left: `${l.x}px`, top: `${l.y}px`, color: l.on ? color : 'rgba(255,255,255,.35)' }"
        @click="setIndex(i)"
      >{{ l.label }}</button>
      <div
        class="m-detent-knob m-focusable" role="slider" :tabindex="disabled ? -1 : 0"
        :aria-label="label || undefined" :aria-valuemin="0" :aria-valuemax="options.length - 1" :aria-valuenow="index"
        :aria-valuetext="options[index]?.label"
        :style="{ left: `${(W - KNOB) / 2}px`, top: '24px', width: `${KNOB}px`, height: `${KNOB}px` }"
        @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key"
      >
        <div class="m-detent-rot" :style="{ transform: `rotate(${deg}deg)` }">
          <div class="m-detent-mark"></div>
        </div>
      </div>
    </div>
    <div v-if="label" class="m-caption" style="font-size:8px">{{ label }}</div>
  </div>
</template>

<style scoped>
.m-detent { display: flex; flex-direction: column; align-items: center; gap: 4px; transition: opacity .15s ease; user-select: none; }
.m-detent.is-disabled { opacity: .4; }
.m-detent-box { position: relative; }
.m-detent-label {
  position: absolute;
  transform: translate(-50%, -50%);
  border: none;
  background: transparent;
  padding: 2px;
  cursor: pointer;
  white-space: nowrap;
  font: 700 9px/1 var(--m-font-mono);
}
.m-detent-label:disabled { cursor: default; }
.m-detent-knob {
  position: absolute;
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  background: linear-gradient(160deg, #3e4249 0%, #282b30 55%, #1d1f23 100%);
  box-shadow: 0 8px 14px -8px rgba(0, 0, 0, .95), inset 0 1px 1px rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .65);
}
.is-disabled .m-detent-knob { cursor: default; }
.m-detent-rot { position: absolute; inset: 0; transition: transform .12s cubic-bezier(.3, 1.5, .5, 1); }
.m-detent-mark { position: absolute; left: 50%; top: 4px; width: 2px; height: 10px; margin-left: -1px; border-radius: 1px; background: var(--m-ink); }
</style>
