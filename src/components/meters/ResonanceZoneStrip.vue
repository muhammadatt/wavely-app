<script setup>
import { computed } from 'vue'
import { RESONANCE_ZONE_SENS_MAX_DB, zoneBounds, zoneSettings } from '../../audio/resonanceParams.js'
import { setDepth, setSensitivity, toggleZone } from './resonanceZoneEdit.js'

/**
 * One cell per zone, all on screen at once — the parametric EQ's band strips,
 * for zones.
 *
 * The plot is where a zone's PLACE is edited: its boundaries are horizontal
 * extents and the axis is horizontal, so dragging them there is direct. This is
 * where its SETTINGS are edited, for the opposite reason — sensitivity, depth
 * and on/off are three values with no natural position on a frequency axis, and
 * stacking three more editable marks into a 30 px lane would make the lane the
 * hard part of the panel.
 *
 * Cells are the same width whatever span they cover. A cell sized to its
 * octaves would make the low zone unreadably narrow on a log axis, and the
 * mapping to the plot is already carried by the frequency printed in the cell
 * and by selection lighting both.
 */
const props = defineProps({
  zones: { type: Array, required: true },
  selected: { type: Number, default: 0 },
  freqFloorHz: { type: Number, default: 40 },
  freqCeilHz: { type: Number, default: 20000 },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:zones', 'update:selected'])

const bounds = computed(() => zoneBounds(props.zones, props.freqFloorHz, props.freqCeilHz))

function hz(v) {
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`
  return String(Math.round(v))
}

function commit(zones) {
  if (zones !== props.zones) emit('update:zones', zones)
}

/**
 * Drag-to-adjust on a printed value.
 *
 * A knob per value would be six to twelve knobs in a row; a number that responds
 * to a vertical drag is the same gesture in a tenth of the width, and the value
 * is legible at rest rather than only while being read off a pointer angle.
 */
function startDrag(e, index, field) {
  if (props.disabled) return
  emit('update:selected', index)
  const startY = e.clientY
  const stored = props.zones[index]
  const from = field === 'sens' ? (stored.sensitivityDb ?? 0) : (stored.depth ?? 1)
  const perPx = field === 'sens' ? 0.12 : 0.008
  const move = (ev) => {
    const v = from + (startY - ev.clientY) * perPx
    commit(field === 'sens'
      ? setSensitivity(props.zones, index, v)
      : setDepth(props.zones, index, v))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  e.preventDefault()
}

function nudge(e, index, field, step) {
  const zone = props.zones[index]
  commit(field === 'sens'
    ? setSensitivity(props.zones, index, (zone.sensitivityDb ?? 0) + step)
    : setDepth(props.zones, index, (zone.depth ?? 1) + step / 100))
  e.preventDefault()
}

function onKey(e, index, field) {
  const fine = e.shiftKey
  if (e.key === 'ArrowUp') nudge(e, index, field, field === 'sens' ? (fine ? 0.5 : 2) : (fine ? 1 : 5))
  else if (e.key === 'ArrowDown') nudge(e, index, field, field === 'sens' ? (fine ? -0.5 : -2) : (fine ? -1 : -5))
}

const info = computed(() => props.zones.map((z, i) => {
  const s = zoneSettings(z)
  // The STORED depth, not the effective one. zoneSettings reports a disabled
  // zone as depth 0, which is what the kernel needs and the wrong thing to
  // print: switching a zone off would make the number the user set read as 0,
  // and switching it back on would look like the panel had invented a value.
  const depth = Math.max(0, Math.min(1, z.depth ?? 1))
  return {
    ...s,
    depth,
    index: i,
    label: `Z${i + 1}`,
    range: `${hz(bounds.value[i].loHz)}–${hz(bounds.value[i].hiHz)}`,
    sensText: `${(z.sensitivityDb ?? 0) > 0 ? '+' : ''}${(z.sensitivityDb ?? 0).toFixed(1)}`,
    depthText: `${Math.round(depth * 100)}`,
  }
}))
</script>

<template>
  <div class="flex gap-[6px]" :style="{ opacity: disabled ? 0.4 : 1 }">
    <div
      v-for="z in info"
      :key="z.index"
      class="flex-1 rounded-[5px] px-[7px] py-[5px] cursor-pointer transition-colors"
      :style="{
        background: z.index === selected
          ? `color-mix(in srgb, ${accent} 13%, rgba(0,0,0,.34))`
          : 'rgba(0,0,0,.34)',
        boxShadow: z.index === selected
          ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 45%, transparent)`
          : 'inset 0 0 0 1px rgba(255,255,255,.05)',
      }"
      @click="emit('update:selected', z.index)"
    >
      <div class="flex items-baseline justify-between">
        <span
          style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.1em"
          :style="{ color: z.enabled
            ? `color-mix(in srgb, ${accent} 60%, #ffffff)`
            : 'rgba(255,255,255,.3)' }"
        >{{ z.label }}</span>
        <!-- The bypass is per zone, not a global one repeated: a suppressor
             that must leave the low end alone and work hard at 4 kHz is the
             normal case, and switching a span off is the most direct way to
             say it. -->
        <button
          class="rounded-full cursor-pointer"
          :style="{
            width: '9px', height: '9px',
            background: z.enabled ? accent : 'transparent',
            boxShadow: z.enabled
              ? `0 0 5px color-mix(in srgb, ${accent} 70%, transparent)`
              : 'inset 0 0 0 1px rgba(255,255,255,.28)',
          }"
          :aria-pressed="String(z.enabled)"
          :aria-label="`Zone ${z.index + 1} ${z.range} hertz, ${z.enabled ? 'on' : 'off'}`"
          :disabled="disabled"
          @click.stop="commit(toggleZone(zones, z.index))"
        ></button>
      </div>

      <div style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.36)"
           class="mt-[2px] truncate">{{ z.range }} Hz</div>

      <div class="flex items-baseline justify-between mt-[4px] gap-[4px]">
        <span
          class="cursor-ns-resize select-none"
          style="font:600 7.5px 'JetBrains Mono',monospace;letter-spacing:.06em;color:rgba(255,255,255,.3)"
        >SENS</span>
        <span
          class="cursor-ns-resize select-none tabular-nums"
          role="slider"
          tabindex="0"
          :aria-label="`Zone ${z.index + 1} sensitivity`"
          :aria-valuenow="z.sensitivityDb"
          :aria-valuemin="-RESONANCE_ZONE_SENS_MAX_DB"
          :aria-valuemax="RESONANCE_ZONE_SENS_MAX_DB"
          :style="{ font: `600 11px 'JetBrains Mono',monospace`, color: z.enabled
            ? `color-mix(in srgb, ${accent} 55%, #ffffff)` : 'rgba(255,255,255,.3)' }"
          @pointerdown="startDrag($event, z.index, 'sens')"
          @keydown="onKey($event, z.index, 'sens')"
        >{{ z.sensText }}</span>
      </div>

      <div class="flex items-baseline justify-between gap-[4px]">
        <span style="font:600 7.5px 'JetBrains Mono',monospace;letter-spacing:.06em;color:rgba(255,255,255,.3)">DEPTH</span>
        <span
          class="cursor-ns-resize select-none tabular-nums"
          role="slider"
          tabindex="0"
          :aria-label="`Zone ${z.index + 1} depth, percent`"
          :aria-valuenow="Math.round(z.depth * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          :style="{ font: `600 11px 'JetBrains Mono',monospace`, color: z.enabled
            ? 'rgba(255,255,255,.62)' : 'rgba(255,255,255,.3)' }"
          @pointerdown="startDrag($event, z.index, 'depth')"
          @keydown="onKey($event, z.index, 'depth')"
        >{{ z.depthText }}</span>
      </div>
    </div>
  </div>
</template>
