<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 100 },
  step: { type: Number, default: 1 },
  label: { type: String, default: '' },
  accent: { type: String, default: '#f5a623' },
  formatValue: { type: Function, default: (v) => String(Math.round(v)) },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const R = 42
const CIRCUMFERENCE = 2 * Math.PI * R
const ARC = 0.75 * CIRCUMFERENCE
const N_TICKS = 13

const pct = computed(() => {
  const raw = (props.modelValue - props.min) / (props.max - props.min)
  return Math.max(0, Math.min(1, raw))
})

const trackDash = `${ARC.toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`
const valDash = computed(() => `${(pct.value * ARC).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`)
const indicatorDeg = computed(() => (225 + pct.value * 270).toFixed(1))

const ticks = computed(() => {
  const out = []
  for (let i = 0; i < N_TICKS; i++) {
    const t = i / (N_TICKS - 1)
    const ang = (135 + t * 270) * Math.PI / 180
    const rr1 = 48, rr2 = 44
    const on = t <= pct.value + 0.0001
    out.push({
      x1: (50 + rr1 * Math.cos(ang)).toFixed(2),
      y1: (50 + rr1 * Math.sin(ang)).toFixed(2),
      x2: (50 + rr2 * Math.cos(ang)).toFixed(2),
      y2: (50 + rr2 * Math.sin(ang)).toFixed(2),
      col: on ? props.accent : 'rgba(255,255,255,0.16)',
    })
  }
  return out
})

const valColor = computed(() => `color-mix(in srgb, ${props.accent} 60%, #ffffff)`)

// Drag-to-adjust: vertical drag, 150px traverses the full range
const DRAG_RANGE_PX = 150
const dragging = ref(false)
let dragStartY = 0
let dragStartValue = 0

function quantize(v) {
  const stepped = Math.round((v - props.min) / props.step) * props.step + props.min
  return Math.max(props.min, Math.min(props.max, stepped))
}

function onPointerDown(e) {
  if (props.disabled) return
  dragging.value = true
  dragStartY = e.clientY
  dragStartValue = props.modelValue
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onPointerMove(e) {
  if (!dragging.value) return
  const deltaY = dragStartY - e.clientY
  const deltaValue = (deltaY / DRAG_RANGE_PX) * (props.max - props.min)
  emit('update:modelValue', quantize(dragStartValue + deltaValue))
}

function onPointerUp(e) {
  dragging.value = false
  e.currentTarget.releasePointerCapture(e.pointerId)
}

function onWheel(e) {
  if (props.disabled) return
  e.preventDefault()
  const delta = e.deltaY < 0 ? props.step : -props.step
  emit('update:modelValue', quantize(props.modelValue + delta))
}
</script>

<template>
  <div class="flex flex-col items-center gap-[7px] w-full select-none transition-opacity"
       :style="{ fontFamily: `'Inter',system-ui,sans-serif`, opacity: disabled ? 0.4 : 1 }">
    <div
      class="relative w-full touch-none"
      :class="disabled ? 'cursor-default' : 'cursor-ns-resize'"
      style="aspect-ratio:1"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @wheel="onWheel"
    >
      <svg viewBox="0 0 100 100" class="absolute inset-0 w-full h-full overflow-visible">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="2.4"
                stroke-linecap="round" :stroke-dasharray="trackDash" transform="rotate(135 50 50)" />
        <circle cx="50" cy="50" r="42" fill="none" :stroke="accent" stroke-width="2.4"
                stroke-linecap="round" :stroke-dasharray="valDash" transform="rotate(135 50 50)"
                :style="{ filter: `drop-shadow(0 0 4px ${accent})` }" />
        <line v-for="(t, i) in ticks" :key="i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
              :stroke="t.col" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <div class="absolute left-[16%] top-[16%] w-[68%] h-[68%] rounded-full"
           style="background:radial-gradient(circle at 50% 38%,#2b323c 74%,#6b727c 89%,#7a818b 94%,#3a424c 100%);box-shadow:inset 0 1.5px 1px rgba(255,255,255,.16), inset 0 -3px 6px rgba(0,0,0,.6), 0 8px 18px rgba(0,0,0,.55)">
        <div class="absolute inset-[9%] rounded-full overflow-hidden"
             style="background:linear-gradient(160deg,#1f252d,#1b212a);box-shadow:inset 0 0 0 1px rgba(0,0,0,.32)">
        </div>
        <div class="absolute inset-0" :style="{ transform: `rotate(${indicatorDeg}deg)` }">
          <div class="absolute top-[15%] left-1/2 -translate-x-1/2 w-[6%] h-[6%] rounded-full"
               style="background: #000000;"></div>
        </div>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span class="tracking-[0.01em]" style="font:500 19px/1 'Inter',system-ui" :style="{ color: valColor }">{{ formatValue(modelValue) }}</span>
        </div>
      </div>
    </div>
    <span class="uppercase" style="font:600 10px/1 'Inter',system-ui;letter-spacing:0.14em;color:rgba(255,255,255,0.55)">{{ label }}</span>
  </div>
</template>
