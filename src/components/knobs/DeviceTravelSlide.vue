<script setup>
/**
 * 1e — Travel slide. An ordered range you scan, read left to right.
 *
 * A lit thumb rides one recessed slot and the labels are bare text under it
 * rather than buttons in a bank, so the housing that used to grow with the
 * label count is gone: four positions cost the same 30 px as two.
 *
 * ⚠ THE TRAVEL IS A CLAIM ABOUT THE VALUES — that they are a progression, and
 * that the far end is more of whatever the near end is. Use it only where that
 * is true (frequencies, times, resolutions). Positions that are different KINDS
 * of thing want `DeviceChoiceRocker` (two of them) or `DeviceDetentRotary`
 * (more), which imply an order of arrangement rather than of degree.
 *
 * ⚠ THE THUMB DRAGS, and a slider that could only be clicked was the reported
 * fault. Dragging is the gesture the shape promises — a thumb in a slot is an
 * object you expect to push — and it is also what lets someone sweep the range
 * by ear in one gesture instead of aiming at each label in turn. Pressing
 * anywhere on the track works too: the thumb is nearly a whole slot wide so it
 * is easy to hit, but refusing to move until it is hit exactly would read as a
 * dead control.
 */
import { computed, nextTick, ref } from 'vue'
import { litCap, litText, DIM_TEXT } from './switchChrome.js'
import { stopIndexFromRatio } from './travelSlideGeometry.js'

const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  /** [{ value, label, title? }], in order. */
  options: { type: Array, required: true },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  width: { type: Number, default: 148 },
  caption: { type: String, default: '' },
  label: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

const btns = ref([])
const trackEl = ref(null)
const dragging = ref(false)
const index = computed(() =>
  props.options.findIndex(o => String(o.value) === String(props.modelValue)))

const track = computed(() => ({
  position: 'relative',
  height: '12px',
  borderRadius: '999px',
  background: 'linear-gradient(180deg,#080a0d,#101419)',
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06), inset 0 2px 6px rgba(0,0,0,.75)',
  opacity: props.disabled ? 0.45 : 1,
  // Without this a touch drag scrolls the panel instead of moving the thumb.
  touchAction: 'none',
  cursor: props.disabled ? 'default' : (dragging.value ? 'grabbing' : 'pointer'),
}))

// One slot per position; the thumb is inset 3 px inside its own slot so it
// never touches the ends of the track.
const thumb = computed(() => {
  const n = Math.max(props.options.length, 1)
  const slot = 100 / n
  return {
    position: 'absolute',
    top: '-1px',
    height: '14px',
    width: `calc(${slot}% - 6px)`,
    left: `calc(${slot * Math.max(index.value, 0)}% + 3px)`,
    borderRadius: '999px',
    // ⚠ NO EASING WHILE DRAGGING. The 150 ms ease is right when a stop is
    // clicked and wrong under the pointer: every step of a drag would start its
    // own animation, so the thumb trails the finger and the control feels
    // rubbery rather than direct.
    transition: dragging.value ? 'none' : 'left .15s ease',
    opacity: index.value < 0 ? 0 : 1,
    cursor: props.disabled ? 'default' : (dragging.value ? 'grabbing' : 'grab'),
    ...litCap(props.accent, 90),
  }
})

function stop(i) {
  return {
    flex: '1',
    padding: '0',
    background: 'none',
    border: 'none',
    font: `700 8.5px 'JetBrains Mono',monospace`,
    letterSpacing: '.1em',
    textAlign: 'center',
    transition: 'color .15s ease',
    color: index.value === i ? litText(props.accent) : DIM_TEXT,
    opacity: props.disabled ? 0.45 : 1,
  }
}

function pick(i) {
  const opt = props.options[i]
  if (opt && String(opt.value) !== String(props.modelValue)) {
    emit('update:modelValue', opt.value)
  }
}

function pickFromPointer(e) {
  const el = trackEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (!(r.width > 0)) return
  pick(stopIndexFromRatio((e.clientX - r.left) / r.width, props.options.length))
}

function onPointerDown(e) {
  if (props.disabled || !props.options.length) return
  if (e.button) return // left button only; a right-click is not a drag
  // Capture so the gesture survives leaving the 12 px track — which it will,
  // since the pointer only has to stray a few pixels vertically.
  trackEl.value?.setPointerCapture?.(e.pointerId)
  dragging.value = true
  e.preventDefault()
  pickFromPointer(e)
}

function onPointerMove(e) {
  if (dragging.value) pickFromPointer(e)
}

function endDrag(e) {
  if (!dragging.value) return
  dragging.value = false
  trackEl.value?.releasePointerCapture?.(e.pointerId)
}

async function onKeyDown(e) {
  if (props.disabled) return
  const n = props.options.length
  if (!n) return
  const cur = Math.max(index.value, 0)
  let next = null
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (cur - 1 + n) % n
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (cur + 1) % n
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  if (next === null) return
  e.preventDefault()
  pick(next)
  await nextTick()
  btns.value[next]?.focus()
}
</script>

<template>
  <div class="flex flex-col gap-[6px]" :style="{ width: width + 'px' }">
    <div role="radiogroup" :aria-label="label || caption" @keydown="onKeyDown">
      <div
        ref="trackEl"
        :style="track"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <span :style="thumb" />
      </div>
      <div class="flex mt-[6px]">
        <button
          v-for="(opt, i) in options" :key="String(opt.value)"
          ref="btns"
          type="button"
          role="radio"
          :aria-checked="index === i"
          :tabindex="index === i || (index < 0 && i === 0) ? 0 : -1"
          :title="opt.title"
          :disabled="disabled"
          class="cursor-pointer disabled:cursor-default"
          :style="stop(i)"
          @click="pick(i)"
        >{{ opt.label }}</button>
      </div>
    </div>
    <span
      v-if="caption"
      class="text-center"
      style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;color:rgba(255,255,255,.35)"
    >{{ caption }}</span>
  </div>
</template>
