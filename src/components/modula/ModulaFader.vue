<script setup>
/**
 * MODULA CONSOLE FADER — a long-throw cap with grip ridges in a sunken slot.
 *
 * Vertical (the kit's console strips, the Inflator's EFFECT and CURVE) or
 * horizontal (the MIX strip). The cap's centre line is the reading; it rides
 * a span inset 43 px from each end of the slot, the kit's geometry, so a
 * mark engraved at a value sits exactly under the cap's line at that value.
 *
 * Options: `marks` engraves a scale beside the slot (the scaled strip widens
 * to take it), `unity` puts the two triangles at a value (the default, unless
 * given), and `readout` prints the value in a well above (vertical) or after
 * (horizontal) the slot. Double-click returns to `defaultValue`.
 */
import { computed } from 'vue'
import { useModulaDrag, DRAG_PROPS } from './useModulaDrag.js'
import { clamp01, valueToPct } from '../knobs/knobGeometry.js'
import ModulaReadout from './ModulaReadout.vue'

const props = defineProps({
  ...DRAG_PROPS,
  orientation: { type: String, default: 'vertical' },
  /** Slot length along the travel, px. */
  length: { type: Number, default: 260 },
  /** Slot thickness across it, px (52 for the plain strip, 44 for a compact mix). */
  thickness: { type: Number, default: 52 },
  /** Values to engrave beside a vertical slot: `[{ value, label }]`. */
  marks: { type: Array, default: null },
  /** Draw the unity triangles at this value (null: none). */
  unity: { type: Number, default: null },
  label: { type: String, default: '' },
  /** 'top' | 'end' | 'none' — where the value's well sits. */
  readout: { type: String, default: 'top' },
  readoutMinWidth: { type: Number, default: 64 },
})
const emit = defineEmits(['update:modelValue'])

const vertical = computed(() => props.orientation !== 'horizontal')
// The cap's travel: the slot less 43 px each end (the kit's geometry).
const INSET = 43
const span = computed(() => Math.max(20, props.length - 2 * INSET))
const capLong = computed(() => (props.thickness >= 52 ? 64 : 56))
const capShort = computed(() => (props.thickness >= 52 ? 30 : 28))

const { pct, handlers } = useModulaDrag(
  props, v => emit('update:modelValue', v),
  { axis: vertical.value ? 'y' : 'x', travelPx: () => span.value },
)

const toPct = v => clamp01(props.taper ? props.taper.toPct(v) : valueToPct(v, props.min, props.max, props.scale))
/** Position of a value along the slot, px from the top (vertical) or left. */
const at = v => (vertical.value ? INSET + (1 - toPct(v)) * span.value : INSET + toPct(v) * span.value)
const capPos = computed(() => (vertical.value ? INSET + (1 - pct.value) * span.value : INSET + pct.value * span.value) - capLong.value / 2)

const scaled = computed(() => vertical.value && Array.isArray(props.marks) && props.marks.length > 0)
const gutter = computed(() => (scaled.value ? 26 : 0))
const slotW = computed(() => props.thickness + gutter.value)
const text = computed(() => props.formatValue(props.modelValue))
const unityPos = computed(() => (props.unity == null ? null : at(props.unity)))

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
  <div class="m-fader" :class="[vertical ? 'is-v' : 'is-h', { 'is-disabled': disabled }]">
    <div v-if="label && vertical" class="m-caption">{{ label }}</div>
    <ModulaReadout v-if="vertical && readout === 'top'" :text="text" :min-width="readoutMinWidth" />

    <div
      class="m-slot m-focusable"
      :style="vertical
        ? { width: `${slotW}px`, height: `${length}px` }
        : { width: `${length}px`, height: `${thickness}px` }"
      v-bind="aria" v-on="handlers"
    >
      <template v-if="scaled">
        <template v-for="m in marks" :key="m.value">
          <div class="m-mark-label" :style="{ top: `${at(m.value)}px`, color: m.value === unity ? 'rgba(255,255,255,.65)' : 'rgba(255,255,255,.35)' }">{{ m.label ?? m.value }}</div>
          <div class="m-mark-line" :style="{ top: `${at(m.value)}px`, left: `${gutter + 12}px`, width: `${thickness - 24}px` }"></div>
        </template>
      </template>

      <div
        class="m-track"
        :style="vertical
          ? { left: `${gutter + thickness / 2 - 2}px`, top: '24px', bottom: '24px', width: '4px' }
          : { top: `${thickness / 2 - 2}px`, left: '24px', right: '24px', height: '4px' }"
      ></div>

      <template v-if="unityPos != null && vertical">
        <div class="m-tri m-tri--l" :style="{ left: `${gutter + 4}px`, top: `${unityPos - 4}px` }"></div>
        <div class="m-tri m-tri--r" :style="{ left: `${gutter + thickness - 9}px`, top: `${unityPos - 4}px` }"></div>
      </template>

      <div
        class="m-capv"
        :class="vertical ? '' : 'm-caph'"
        :style="vertical
          ? { left: `${gutter + (thickness - capShort) / 2}px`, width: `${capShort}px`, height: `${capLong}px`, transform: `translate3d(0, ${capPos}px, 0)` }
          : { top: `${(thickness - capShort) / 2}px`, width: `${capLong}px`, height: `${capShort}px`, transform: `translate3d(${capPos}px, 0, 0)` }"
      >
        <div class="m-grip m-grip--a"></div>
        <div class="m-grip m-grip--b"></div>
        <div class="m-line"></div>
      </div>
    </div>

    <ModulaReadout v-if="!vertical && readout === 'end'" :text="text" :min-width="readoutMinWidth" />
  </div>
</template>

<style scoped>
.m-fader { display: flex; align-items: center; gap: 10px; user-select: none; transition: opacity .15s ease; }
.m-fader.is-v { flex-direction: column; }
.m-fader.is-h { flex-direction: row; gap: 14px; }
.m-fader.is-disabled { opacity: .4; }
.m-fader.is-disabled .m-slot { cursor: default; }

.m-slot {
  position: relative;
  flex: none;
  border-radius: 12px;
  touch-action: none;
  background: linear-gradient(180deg, #26292e, #1f2125);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, .7), inset 0 -1px 0 rgba(255, 255, 255, .04), 0 1px 0 rgba(255, 255, 255, .04);
}
.is-v .m-slot { cursor: ns-resize; }
.is-h .m-slot { cursor: ew-resize; border-radius: 10px; }

.m-track {
  position: absolute;
  border-radius: 2px;
  background: var(--m-track);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, .9), 0 1px 0 rgba(255, 255, 255, .06);
}
.m-mark-label {
  position: absolute;
  left: 0;
  width: 26px;
  text-align: right;
  transform: translateY(-50%);
  font: 500 9px/1 var(--m-font-mono);
}
.m-mark-line { position: absolute; height: 1px; background: rgba(255, 255, 255, .09); }
.m-tri { position: absolute; width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; }
.m-tri--l { border-left: 5px solid #7a818b; }
.m-tri--r { border-right: 5px solid #7a818b; }

.m-capv {
  position: absolute;
  top: 0;
  border-radius: 6px;
  will-change: transform;
  backface-visibility: hidden;
  background: linear-gradient(180deg, #5a5f68 0%, #3d4148 20%, #2a2d33 50%, #3d4148 80%, #23262b 100%);
  box-shadow: var(--m-shadow-cap);
}
.m-caph {
  left: 0;
  background: linear-gradient(90deg, #5a5f68 0%, #3d4148 20%, #2a2d33 50%, #3d4148 80%, #23262b 100%);
  box-shadow: 0 10px 16px -8px rgba(0, 0, 0, .95), 0 4px 6px rgba(0, 0, 0, .5), inset 1px 0 0 rgba(255, 255, 255, .22), inset -1px 0 0 rgba(0, 0, 0, .6), 0 0 0 1px rgba(0, 0, 0, .65);
}
.m-grip { position: absolute; background: repeating-linear-gradient(180deg, rgba(0, 0, 0, .5) 0 1px, rgba(255, 255, 255, .1) 1px 2px, transparent 2px 5px); }
.is-v .m-grip { left: 6px; right: 6px; height: 16px; }
.is-v .m-grip--a { top: 8px; }
.is-v .m-grip--b { bottom: 8px; }
.is-h .m-grip { top: 6px; bottom: 6px; width: 14px; background: repeating-linear-gradient(90deg, rgba(0, 0, 0, .5) 0 1px, rgba(255, 255, 255, .1) 1px 2px, transparent 2px 5px); }
.is-h .m-grip--a { left: 7px; }
.is-h .m-grip--b { right: 7px; }
.m-line { position: absolute; background: #8e9297; border-radius: 1px; }
.is-v .m-line { left: 3px; right: 3px; top: calc(50% - 1px); height: 2px; }
.is-h .m-line { top: 3px; bottom: 3px; left: calc(50% - 1px); width: 2px; }
</style>
