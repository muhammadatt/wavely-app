<script setup>
import { computed } from 'vue'
import {
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN,
  RESONANCE_ZONE_RANGES,
  RESONANCE_ZONE_STOCK,
  zoneBounds,
  zoneSettings,
} from '../../audio/resonanceParams.js'
import { setZoneCount, setZoneParam, toggleZone } from '../meters/resonanceZoneEdit.js'
import Knob from '../knobs/Knob.vue'

/**
 * One set of controls, showing whichever zone is selected.
 *
 * NOT ONE STRIP PER ZONE. That was the previous arrangement and it does not
 * scale: three settings across up to six zones is eighteen values competing for
 * a row, which forces each of them into something too small to be a control —
 * the version before this printed them as numbers and had to be explained. A
 * multiband compressor shows one band's controls at a time for the same reason,
 * and the plot above already says which band is which.
 *
 * The count picker lives here rather than on the plot because it is the one
 * zone control that is not about a particular zone.
 */
const props = defineProps({
  zones: { type: Array, required: true },
  selected: { type: Number, default: 0 },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:zones', 'update:selected'])

const zone = computed(() => props.zones[props.selected] ?? props.zones[0] ?? null)
/**
 * The STORED settings, not the effective ones.
 *
 * zoneSettings reports a disabled zone as depth 0, which is what the kernel
 * needs and the wrong thing to show: switching a zone off would make the Depth
 * knob read zero, and switching it back on would look like the panel had
 * invented a value. Only `enabled` comes from there.
 */
const settings = computed(() => {
  const z = zone.value
  const R = RESONANCE_ZONE_RANGES
  const clamp = (v, r) => Math.max(r.min, Math.min(r.max, v))
  return {
    enabled: zoneSettings(z).enabled,
    depth: clamp(z?.depth ?? RESONANCE_ZONE_STOCK.depth, R.depth),
    sharpness: clamp(z?.sharpness ?? RESONANCE_ZONE_STOCK.sharpness, R.sharpness),
    selectivity: clamp(z?.selectivity ?? RESONANCE_ZONE_STOCK.selectivity, R.selectivity),
  }
})
const index = computed(() =>
  Math.max(0, Math.min(props.selected, props.zones.length - 1)))

const span = computed(() => {
  const b = zoneBounds(props.zones, 20, 20000)[index.value]
  if (!b) return ''
  const f = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`)
  return `${f(b.loHz)} – ${f(b.hiHz)}`
})

const counts = Array.from(
  { length: RESONANCE_ZONE_MAX - RESONANCE_ZONE_MIN + 1 },
  (_, i) => RESONANCE_ZONE_MIN + i,
)

let seq = 0
function setCount(n) {
  emit('update:zones', setZoneCount(
    props.zones, n, { w: 600, minHz: 20, maxHz: 20000 }, 20, 20000,
    () => `z${Date.now()}${seq++}`))
  emit('update:selected', Math.min(props.selected, n - 1))
}

function set(name, value) {
  emit('update:zones', setZoneParam(props.zones, index.value, name, value))
}

const percent = v => `${Math.round(v * 100)}`
const oneDp = v => v.toFixed(1)
</script>

<template>
  <div
    class="flex items-center gap-[16px] rounded-[7px] px-[14px] py-[10px]"
    :style="{
      background: 'rgba(0,0,0,.28)',
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 20%, transparent)`,
      opacity: disabled ? 0.4 : 1,
    }"
  >
    <!-- Identity first: these knobs mean nothing without it, because the same
         three knobs show six different sets of values. -->
    <div class="w-[112px] shrink-0">
      <div class="flex items-center gap-[7px]">
        <span
          style="font:700 12px 'JetBrains Mono',monospace;letter-spacing:.08em"
          :style="{ color: settings.enabled
            ? `color-mix(in srgb, ${accent} 60%, #ffffff)` : 'rgba(255,255,255,.35)' }"
        >ZONE {{ index + 1 }}</span>
        <button
          class="rounded-full cursor-pointer disabled:cursor-default"
          :style="{
            width: '10px', height: '10px',
            background: settings.enabled ? accent : 'transparent',
            boxShadow: settings.enabled
              ? `0 0 6px color-mix(in srgb, ${accent} 70%, transparent)`
              : 'inset 0 0 0 1px rgba(255,255,255,.3)',
          }"
          :aria-pressed="String(settings.enabled)"
          :aria-label="`Zone ${index + 1}, ${settings.enabled ? 'on' : 'off'}`"
          title="Switch this zone off — the effect leaves that band alone."
          :disabled="disabled"
          @click="emit('update:zones', toggleZone(zones, index))"
        ></button>
      </div>
      <div style="font:600 9px 'JetBrains Mono',monospace;color:rgba(255,255,255,.4)"
           class="mt-[3px]">{{ span }}</div>
    </div>

    <div class="flex-1 flex justify-center gap-[22px]">
      <div class="w-[72px]">
        <Knob
          :model-value="settings.depth" @update:model-value="set('depth', $event)"
          :min="RESONANCE_ZONE_RANGES.depth.min" :max="RESONANCE_ZONE_RANGES.depth.max"
          :step="0.01" :value-font-px="13"
          label="Depth" :accent="accent" :format-value="percent"
          :disabled="disabled || !settings.enabled"
        />
      </div>
      <div class="w-[72px]">
        <Knob
          :model-value="settings.sharpness" @update:model-value="set('sharpness', $event)"
          :min="RESONANCE_ZONE_RANGES.sharpness.min" :max="RESONANCE_ZONE_RANGES.sharpness.max"
          :step="0.01" :value-font-px="13"
          label="Sharpness" :accent="accent" :format-value="percent"
          :disabled="disabled || !settings.enabled"
        />
      </div>
      <div class="w-[72px]">
        <Knob
          :model-value="settings.selectivity" @update:model-value="set('selectivity', $event)"
          :min="RESONANCE_ZONE_RANGES.selectivity.min" :max="RESONANCE_ZONE_RANGES.selectivity.max"
          :step="0.5" :value-font-px="13"
          label="Selectivity" :accent="accent" :format-value="oneDp"
          :disabled="disabled || !settings.enabled"
        />
      </div>
    </div>

    <!-- Count, not a stepper: the reference this borrows from lists the numbers
         so the one in force is readable at a glance, and going from four zones
         to two is one click rather than two. -->
    <div class="shrink-0 text-right">
      <div style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.1em;color:rgba(255,255,255,.32)"
           class="mb-[4px]">ZONES</div>
      <div class="flex gap-[2px]" role="radiogroup" aria-label="Number of zones">
        <button
          v-for="n in counts"
          :key="n"
          class="cursor-pointer disabled:cursor-default"
          style="width:19px;height:19px;border-radius:4px;font:700 10px 'JetBrains Mono',monospace"
          :style="{
            background: n === zones.length
              ? `color-mix(in srgb, ${accent} 26%, transparent)` : 'rgba(255,255,255,.05)',
            color: n === zones.length
              ? `color-mix(in srgb, ${accent} 55%, #ffffff)` : 'rgba(255,255,255,.42)',
            boxShadow: n === zones.length
              ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 50%, transparent)` : 'none',
          }"
          role="radio"
          :aria-checked="String(n === zones.length)"
          :disabled="disabled"
          @click="setCount(n)"
        >{{ n }}</button>
      </div>
    </div>
  </div>
</template>
