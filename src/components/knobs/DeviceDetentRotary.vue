<script setup>
/**
 * 1d — Detent rotary. Five or more positions in the width of two.
 *
 * The value lives in the mono readout instead of in five labels, which is what
 * buys the width back: a bank has to print every option all the time, and a
 * rotary prints the one you are on.
 *
 * Three ways in, because a dial affords all three: turn it, click a detent to
 * go straight there, or click the cap to advance one position.
 *
 * ⚠ IT IMPLIES AN ORDER OF ARRANGEMENT, NOT OF DEGREE, which is exactly why it
 * suits a ratio switch whose last position is a mode rather than a bigger
 * number: positions sit around a dial in a fixed sequence without the dial
 * claiming the last is "more" than the one before. `DeviceTravelSlide` makes the
 * stronger claim and should be used where it is true.
 *
 * ⚠ THE DETENTS ARE 12 px HIT TARGETS DRAWN AS 4 px DOTS. The dot is the design;
 * a 4 px button is not something anyone can reliably hit, and the two do not
 * have to be the same element.
 *
 * ⚠ THE TURN IS VERTICAL, NOT ANGULAR, and that is a house convention rather
 * than a preference. `Knob.vue` drags vertically, so every knob in the app is
 * turned the same way; an angular gesture here would also duplicate what
 * clicking a detent already does better — pointing straight at the position you
 * want.
 *
 * ⚠ CLICKING A DETENT WAS DEAD FOR A REVISION — the buttons were built, styled,
 * given radio semantics and never given a `@click`, so `pick()` was reachable
 * only from the cap and the keyboard. Nothing catches that: `pick` is declared
 * and is called elsewhere, so the binding check sees nothing missing, and a
 * screenshot shows a perfectly normal dial. Reported from use.
 */
import { computed, nextTick, ref } from 'vue'
import { litText } from './switchChrome.js'
import {
  detentIndexFromDrag, DETENT_DRAG_THRESHOLD_PX,
} from './detentRotaryGeometry.js'

const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  /** [{ value, label, title? }], in dial order. */
  options: { type: Array, required: true },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  /** Names the control for assistive tech, and engraves it under the readout. */
  label: { type: String, default: '' },
  /**
   * Draw the engraving. Off where the panel already prints the name beside the
   * dial — the accessible name is still wanted there, so the two cannot be the
   * same switch.
   */
  showLabel: { type: Boolean, default: true },
})

const emit = defineEmits(['update:modelValue'])

const SWEEP = 270
const START = -135
const ticks = ref([])
const dialEl = ref(null)
const dragging = ref(false)

let anchorY = 0
let anchorIndex = 0
let armed = false
// Set for the instant between a turn's pointerup and the click it synthesises,
// so releasing a turn over a detent does not also select that detent.
let justTurned = false

const index = computed(() =>
  props.options.findIndex(o => String(o.value) === String(props.modelValue)))
const safeIndex = computed(() => Math.max(index.value, 0))

/** A single position has nowhere to sweep to, so it parks at the top. */
function angleAt(i) {
  const n = props.options.length
  return n < 2 ? 0 : START + i * (SWEEP / (n - 1))
}

const pointer = computed(() => ({
  position: 'absolute',
  left: '50%',
  top: '6px',
  width: '2px',
  height: '13px',
  marginLeft: '-1px',
  borderRadius: '999px',
  background: props.accent,
  boxShadow: `0 0 5px ${props.accent}`,
  transformOrigin: '50% 14px',
  transform: `rotate(${angleAt(safeIndex.value)}deg)`,
  // ⚠ NO EASING WHILE TURNING, for the reason the travel slide's thumb drops
  // its own: a 150 ms ease restarted on every step of a drag makes the pointer
  // trail the hand instead of following it.
  transition: dragging.value ? 'none' : 'transform .15s ease',
  opacity: index.value < 0 ? 0 : 1,
}))

const readout = computed(() => ({
  font: "700 11px 'JetBrains Mono',monospace",
  letterSpacing: '.1em',
  fontVariantNumeric: 'tabular-nums',
  color: litText(props.accent),
}))

function tick(i) {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: '12px',
    height: '12px',
    marginLeft: '-6px',
    marginTop: '-6px',
    padding: '0',
    border: 'none',
    background: 'none',
    borderRadius: '999px',
    transform: `rotate(${angleAt(i)}deg) translateY(-26px)`,
    transformOrigin: '50% 50%',
  }
}

function dot(i) {
  const on = index.value === i
  return {
    display: 'block',
    width: '4px',
    height: '4px',
    margin: '4px',
    borderRadius: '999px',
    background: on ? props.accent : 'rgba(255,255,255,.22)',
    boxShadow: on ? `0 0 5px ${props.accent}` : 'none',
    transition: 'background-color .15s ease',
  }
}

function pick(i) {
  const opt = props.options[i]
  if (opt && String(opt.value) !== String(props.modelValue)) {
    emit('update:modelValue', opt.value)
  }
}

function pickFromDetent(i) {
  if (props.disabled || justTurned) return
  pick(i)
}

function advance() {
  const n = props.options.length
  if (props.disabled || justTurned || !n) return
  pick((safeIndex.value + 1) % n)
}

/**
 * ⚠ CAPTURE IS TAKEN ONLY ONCE THE PRESS BECOMES A TURN, not on pointerdown.
 * Capturing immediately would retarget the click that follows onto the dial, so
 * the detents and the cap — which both work by click — would stop responding to
 * an ordinary press. Below the threshold this handler does nothing at all and
 * the native click runs as usual.
 */
function onPointerDown(e) {
  if (props.disabled || !props.options.length) return
  if (e.button) return
  anchorY = e.clientY
  anchorIndex = safeIndex.value
  armed = true
}

function onPointerMove(e) {
  if (!armed) return
  const deltaY = anchorY - e.clientY
  if (!dragging.value) {
    if (Math.abs(deltaY) < DETENT_DRAG_THRESHOLD_PX) return
    dragging.value = true
    dialEl.value?.setPointerCapture?.(e.pointerId)
  }
  pick(detentIndexFromDrag(anchorIndex, deltaY, props.options.length))
}

function endTurn(e) {
  armed = false
  if (!dragging.value) return
  dragging.value = false
  justTurned = true
  try { dialEl.value?.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
  // Cleared after the click this release synthesises has been and gone.
  setTimeout(() => { justTurned = false }, 0)
}

function onWheel(e) {
  if (props.disabled) return
  const n = props.options.length
  if (!n) return
  e.preventDefault()
  pick(Math.min(n - 1, Math.max(0, safeIndex.value + (e.deltaY < 0 ? 1 : -1))))
}

async function onKeyDown(e) {
  if (props.disabled) return
  const n = props.options.length
  if (!n) return
  let next = null
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (safeIndex.value - 1 + n) % n
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (safeIndex.value + 1) % n
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = n - 1
  if (next === null) return
  e.preventDefault()
  pick(next)
  await nextTick()
  ticks.value[next]?.focus()
}
</script>

<template>
  <div class="flex flex-col items-center gap-[8px]" :style="{ opacity: disabled ? 0.45 : 1 }">
    <div
      ref="dialEl"
      role="radiogroup"
      :aria-label="label"
      class="relative w-[54px] h-[54px]"
      :style="{
        touchAction: 'none',
        cursor: disabled ? 'default' : (dragging ? 'grabbing' : 'grab'),
      }"
      @keydown="onKeyDown"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endTurn"
      @pointercancel="endTurn"
      @wheel="onWheel"
    >
      <button
        v-for="(opt, i) in options" :key="String(opt.value)"
        ref="ticks"
        type="button"
        role="radio"
        :aria-checked="index === i"
        :aria-label="opt.label"
        :tabindex="index === i || (index < 0 && i === 0) ? 0 : -1"
        :title="opt.title || opt.label"
        :disabled="disabled"
        class="cursor-pointer disabled:cursor-default"
        :style="tick(i)"
        @click="pickFromDetent(i)"
      ><span :style="dot(i)" /></button>
      <!-- The cap advances the dial, which the detents can already do — so it is
           a surface rather than a control, hidden from assistive tech instead of
           offering a second, unlabelled way to do the same thing. -->
      <div
        aria-hidden="true"
        style="position:absolute;left:7px;top:7px;width:40px;height:40px;
               border:1px solid rgba(255,255,255,.12);border-radius:999px;
               background:linear-gradient(180deg,#2a3038,#14181e 62%);
               box-shadow:inset 0 1px 0 rgba(255,255,255,.14), 0 3px 8px rgba(0,0,0,.55)"
        @click="advance"
      >
        <span :style="pointer" />
      </div>
    </div>
    <span :style="readout">{{ options[safeIndex]?.label ?? '' }}</span>
    <span
      v-if="label && showLabel"
      style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;color:var(--color-text-faint)"
    >{{ label }}</span>
  </div>
</template>
