<script setup>
/**
 * MODULA DRUM COUNTER — one of N on a number drum seen through a window, like
 * a tape counter. The selected value sits lit between two amber hairlines and
 * its neighbours show dimmed either side; the arrows step, a click on a
 * neighbour goes to it, the arrow keys step.
 *
 *   horizontal  a pill window with the arrows outside it (PHAT*SS's TAPE
 *               SPEED under the reel, layout 5a)
 *   vertical    a tall window with the arrows stacked beside it and the
 *               caption between them (layout study 2c)
 *
 * Options run first → last: left to right, or top to bottom. A value not in
 * `options` shows nothing lit and either arrow lands on an end.
 */
import { computed, ref, watch } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: null },
  /** `[{ value, label, title? }]`, first → last. */
  options: { type: Array, required: true },
  orientation: { type: String, default: 'horizontal', validator: v => ['horizontal', 'vertical'].includes(v) },
  label: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const index = computed(() => props.options.findIndex(o => o.value === props.modelValue))
const current = computed(() => props.options[index.value] ?? null)
const prev = computed(() => (index.value > 0 ? props.options[index.value - 1] : null))
const next = computed(() => (index.value >= 0 && index.value < props.options.length - 1 ? props.options[index.value + 1] : null))
const canPrev = computed(() => !props.disabled && index.value !== 0)
const canNext = computed(() => !props.disabled && index.value !== props.options.length - 1)
const vertical = computed(() => props.orientation === 'vertical')

// Which way the drum rolled, for the transition: forward brings the next value
// in from the far side, backward from the near side.
const dir = ref('fwd')
watch(index, (i, was) => { dir.value = i < was ? 'back' : 'fwd' })

function step(d) {
  if (props.disabled || !props.options.length) return
  const from = index.value < 0 ? (d > 0 ? -1 : props.options.length) : index.value
  const o = props.options[Math.max(0, Math.min(props.options.length - 1, from + d))]
  if (o && o.value !== props.modelValue) emit('update:modelValue', o.value)
}

function onKey(e) {
  const fwd = vertical.value ? 'ArrowDown' : 'ArrowRight'
  const back = vertical.value ? 'ArrowUp' : 'ArrowLeft'
  if (e.key === fwd || e.key === 'PageDown') { e.preventDefault(); step(1) }
  else if (e.key === back || e.key === 'PageUp') { e.preventDefault(); step(-1) }
  else if (e.key === 'Home') { e.preventDefault(); step(-props.options.length) }
  else if (e.key === 'End') { e.preventDefault(); step(props.options.length) }
}
</script>

<template>
  <div class="m-drum" :class="[`m-drum--${orientation}`, { 'is-disabled': disabled }]">
    <div class="m-drum-row">
      <button
        v-if="!vertical" type="button" class="m-drum-arrow m-focusable" tabindex="-1"
        :disabled="!canPrev" :aria-label="prev ? `Previous: ${prev.label}` : 'Previous'" @click="step(-1)"
      ><span class="m-drum-tri m-drum-tri--left"></span></button>

      <div
        class="m-drum-window m-focusable" role="spinbutton" :tabindex="disabled ? -1 : 0"
        :aria-label="ariaLabel || label || undefined" :aria-valuetext="current?.label"
        :aria-valuenow="index < 0 ? undefined : index" :aria-valuemin="0" :aria-valuemax="options.length - 1"
        :aria-disabled="disabled || undefined" :title="current?.title"
        @keydown="onKey"
      >
        <button type="button" class="m-drum-side" tabindex="-1" :disabled="!prev || disabled" :title="prev?.title" @click="step(-1)">{{ prev?.label ?? '' }}</button>
        <div class="m-drum-cur">
          <Transition :name="`m-drum-${vertical ? 'v' : 'h'}-${dir}`">
            <span :key="String(current?.value ?? '')" class="m-drum-val">{{ current?.label ?? '' }}</span>
          </Transition>
        </div>
        <button type="button" class="m-drum-side" tabindex="-1" :disabled="!next || disabled" :title="next?.title" @click="step(1)">{{ next?.label ?? '' }}</button>
        <div class="m-drum-glass"></div>
      </div>

      <button
        v-if="!vertical" type="button" class="m-drum-arrow m-focusable" tabindex="-1"
        :disabled="!canNext" :aria-label="next ? `Next: ${next.label}` : 'Next'" @click="step(1)"
      ><span class="m-drum-tri m-drum-tri--right"></span></button>

      <div v-if="vertical" class="m-drum-stack">
        <button
          type="button" class="m-drum-arrow m-focusable" tabindex="-1"
          :disabled="!canPrev" :aria-label="prev ? `Previous: ${prev.label}` : 'Previous'" @click="step(-1)"
        ><span class="m-drum-tri m-drum-tri--up"></span></button>
        <div v-if="label" class="m-caption m-drum-cap">{{ label }}</div>
        <button
          type="button" class="m-drum-arrow m-focusable" tabindex="-1"
          :disabled="!canNext" :aria-label="next ? `Next: ${next.label}` : 'Next'" @click="step(1)"
        ><span class="m-drum-tri m-drum-tri--down"></span></button>
      </div>
    </div>
    <div v-if="label && !vertical" class="m-caption m-drum-cap">{{ label }}</div>
  </div>
</template>

<style scoped>
.m-drum { display: flex; flex-direction: column; align-items: center; gap: 6px; user-select: none; transition: opacity .15s ease; }
.m-drum.is-disabled { opacity: .4; }
.m-drum-row { display: flex; align-items: center; gap: 6px; }
.m-drum--vertical .m-drum-row { gap: 12px; }
.m-drum-cap { font-size: 8px; }

.m-drum-window {
  position: relative;
  display: flex;
  align-items: center;
  overflow: hidden;
  background: linear-gradient(180deg, #0b0c0e, #1d1f23 50%, #0b0c0e);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6), 0 1px 0 1px rgba(255, 255, 255, .05);
}
.m-drum--horizontal .m-drum-window { gap: 4px; height: 40px; padding: 0 10px; border-radius: 20px; }
.m-drum--vertical .m-drum-window { flex-direction: column; justify-content: space-between; width: 86px; height: 118px; padding: 2px 0; border-radius: 10px; }

.m-drum-side {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  text-align: center;
  font: 600 11px/1 var(--m-font-mono);
  color: rgba(255, 255, 255, .2);
}
.m-drum-side:disabled { cursor: default; }
.m-drum-side:not(:disabled):hover { color: rgba(255, 255, 255, .38); }
.m-drum--horizontal .m-drum-side { width: 26px; transform: scaleX(.75); }
.m-drum--vertical .m-drum-side { width: 100%; height: 30px; font-size: 15px; transform: scaleY(.7); color: rgba(255, 255, 255, .18); }

.m-drum-cur {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-color: rgba(232, 163, 61, .35);
  border-style: solid;
  border-width: 0;
}
.m-drum--horizontal .m-drum-cur { width: 36px; height: 27px; border-left-width: 1px; border-right-width: 1px; }
.m-drum--vertical .m-drum-cur { width: 100%; height: 40px; border-top-width: 1px; border-bottom-width: 1px; }
.m-drum-val {
  grid-area: 1 / 1;
  white-space: nowrap;
  font: 700 15px/1 var(--m-font-mono);
  color: color-mix(in srgb, var(--m-accent) 65%, #fff);
  text-shadow: 0 0 8px color-mix(in srgb, var(--m-accent) 55%, transparent);
}
.m-drum--vertical .m-drum-val { font-size: 28px; text-shadow: 0 0 10px color-mix(in srgb, var(--m-accent) 55%, transparent); }

/* Curved glass: darker toward the ends of the drum, a sheen on top. */
.m-drum-glass { position: absolute; inset: 0; pointer-events: none; }
.m-drum--horizontal .m-drum-glass {
  background: linear-gradient(90deg, rgba(0, 0, 0, .55), transparent 28%, transparent 72%, rgba(0, 0, 0, .55)), linear-gradient(180deg, rgba(255, 255, 255, .06), transparent 40%);
}
.m-drum--vertical .m-drum-glass { background: linear-gradient(180deg, rgba(255, 255, 255, .07), transparent 30%, transparent 70%, rgba(255, 255, 255, .03)); }

.m-drum-stack { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.m-drum-arrow {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  background: transparent;
  box-shadow: 0 6px 12px -6px rgba(0, 0, 0, .9), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .65);
}
.m-drum--vertical .m-drum-arrow { width: 30px; height: 30px; }
.m-drum-arrow:disabled { cursor: default; opacity: .3; }
.m-drum-arrow:not(:disabled):hover { background: rgba(255, 255, 255, .04); }
.m-drum-tri { width: 0; height: 0; border: 4px solid transparent; }
.m-drum-tri--left { border-right: 5px solid var(--m-ink-2); border-left-width: 0; }
.m-drum-tri--right { border-left: 5px solid var(--m-ink-2); border-right-width: 0; }
.m-drum-tri--up { border-width: 0 5px 6px; border-bottom-color: var(--m-ink-2); }
.m-drum-tri--down { border-width: 6px 5px 0; border-top-color: var(--m-ink-2); }

/* The roll: the new value comes in from the side the drum turned from. */
.m-drum-h-fwd-enter-active, .m-drum-h-fwd-leave-active, .m-drum-h-back-enter-active, .m-drum-h-back-leave-active,
.m-drum-v-fwd-enter-active, .m-drum-v-fwd-leave-active, .m-drum-v-back-enter-active, .m-drum-v-back-leave-active {
  transition: transform .16s ease-out, opacity .16s ease-out;
}
.m-drum-h-fwd-enter-from, .m-drum-h-back-leave-to { transform: translateX(100%); opacity: 0; }
.m-drum-h-fwd-leave-to, .m-drum-h-back-enter-from { transform: translateX(-100%); opacity: 0; }
.m-drum-v-fwd-enter-from, .m-drum-v-back-leave-to { transform: translateY(100%); opacity: 0; }
.m-drum-v-fwd-leave-to, .m-drum-v-back-enter-from { transform: translateY(-100%); opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .m-drum-val { transition: none !important; }
}
</style>
