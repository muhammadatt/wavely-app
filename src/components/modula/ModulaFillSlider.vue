<script setup>
/**
 * MODULA FILL SLIDER — the kit's SLIDERS: a narrow sunken channel that fills
 * with a gradient up to the cap.
 *
 *   vertical    a 38 × 30 cap over a 12 px channel (IN / OUT)
 *   horizontal  a round 26 px cap over a 10 px bar (CROSSOVER), with optional
 *               end labels under it
 */
import { computed } from 'vue'
import { useModulaDrag, DRAG_PROPS } from './useModulaDrag.js'
import ModulaReadout from './ModulaReadout.vue'

const props = defineProps({
  ...DRAG_PROPS,
  orientation: { type: String, default: 'vertical' },
  length: { type: Number, default: 230 },
  label: { type: String, default: '' },
  color: { type: String, default: 'var(--m-accent)' },
  /** `[left, right]` captions under a horizontal slider. */
  ends: { type: Array, default: null },
})
const emit = defineEmits(['update:modelValue'])

const vertical = computed(() => props.orientation !== 'horizontal')
const CAP_V = 30
const { pct, handlers } = useModulaDrag(
  props, v => emit('update:modelValue', v),
  { axis: vertical.value ? 'y' : 'x', travelPx: () => props.length - (vertical.value ? CAP_V : 26) },
)
const deep = computed(() => `color-mix(in oklab, ${props.color} 52%, #1b1d21)`)
const text = computed(() => props.formatValue(props.modelValue))
const aria = computed(() => ({
  role: 'slider',
  tabindex: props.disabled ? -1 : 0,
  'aria-label': props.ariaLabel || props.label || undefined,
  'aria-orientation': vertical.value ? 'vertical' : 'horizontal',
  'aria-valuemin': props.min,
  'aria-valuemax': props.max,
  'aria-valuenow': props.modelValue,
  'aria-valuetext': text.value,
}))
</script>

<template>
  <div v-if="vertical" class="m-fs is-v" :class="{ 'is-disabled': disabled }">
    <div class="m-fs-slot m-focusable" :style="{ height: `${length}px` }" v-bind="aria" v-on="handlers">
      <div class="m-fs-chan"></div>
      <div class="m-fs-fill" :style="{ height: `${pct * 100}%`, background: `linear-gradient(180deg, ${color} 0%, ${deep} 100%)` }"></div>
      <div class="m-fs-cap" :style="{ bottom: `${pct * (length - CAP_V)}px` }"><div class="m-fs-cap-line"></div></div>
    </div>
    <div class="m-note" style="font-size:11px">{{ text }}</div>
    <div v-if="label" class="m-caption">{{ label }}</div>
  </div>

  <div v-else class="m-fs is-h" :class="{ 'is-disabled': disabled }" :style="{ width: `${length}px` }">
    <div v-if="label" class="m-fs-head">
      <span class="m-caption" style="color:#aeb6bd">{{ label }}</span>
      <ModulaReadout :text="text" size="sm" style="background:none;box-shadow:none;padding:0" />
    </div>
    <div class="m-fs-hslot m-focusable" v-bind="aria" v-on="handlers">
      <div class="m-fs-hchan"></div>
      <div class="m-fs-hfill" :style="{ width: `${pct * 100}%`, background: `linear-gradient(90deg, ${deep}, ${color})` }"></div>
      <div class="m-fs-knob" :style="{ left: `calc(${pct} * (100% - 26px))` }"></div>
    </div>
    <div v-if="ends" class="m-fs-ends"><span>{{ ends[0] }}</span><span>{{ ends[1] }}</span></div>
  </div>
</template>

<style scoped>
.m-fs { user-select: none; transition: opacity .15s ease; }
.m-fs.is-disabled { opacity: .4; pointer-events: none; }
.m-fs.is-v { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.m-fs-slot { position: relative; width: 40px; display: grid; place-items: center; cursor: ns-resize; touch-action: none; }
.m-fs-chan { position: absolute; top: 0; bottom: 0; width: 12px; border-radius: 8px; background: linear-gradient(180deg, #15171a, #212429); box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85), inset 0 -1px 0 rgba(255, 255, 255, .05), 0 1px 0 rgba(255, 255, 255, .04); }
.m-fs-fill { position: absolute; left: 14px; width: 12px; bottom: 0; border-radius: 8px; }
.m-fs-cap { position: absolute; left: 1px; width: 38px; height: 30px; border-radius: 8px; background: linear-gradient(180deg, #4a4f57, #2a2d33); box-shadow: 0 10px 16px -6px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .16), 0 0 0 1px rgba(0, 0, 0, .6); }
.m-fs-cap-line { position: absolute; left: 8px; right: 8px; top: 14px; height: 2px; border-radius: 2px; background: rgba(0, 0, 0, .55); box-shadow: 0 1px 0 rgba(255, 255, 255, .09); }

.m-fs.is-h { display: flex; flex-direction: column; gap: 12px; }
.m-fs-head { display: flex; justify-content: space-between; align-items: baseline; }
.m-fs-hslot { position: relative; height: 34px; display: grid; align-items: center; cursor: ew-resize; touch-action: none; }
.m-fs-hchan { position: absolute; left: 0; right: 0; height: 10px; border-radius: 6px; background: linear-gradient(180deg, #15171a, #212429); box-shadow: inset 0 2px 6px rgba(0, 0, 0, .85), 0 1px 0 rgba(255, 255, 255, .04); }
.m-fs-hfill { position: absolute; left: 0; height: 10px; border-radius: 6px; }
.m-fs-knob { position: absolute; width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(160deg, #4c515a, #2a2d33); box-shadow: 0 8px 14px -5px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 1px rgba(0, 0, 0, .6); }
.m-fs-ends { display: flex; justify-content: space-between; font: 500 10px/1 var(--m-font-mono); color: var(--m-ink-4); }
</style>
