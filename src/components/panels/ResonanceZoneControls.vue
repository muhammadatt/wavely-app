<script setup>
import { computed, ref, watch } from 'vue'
import {
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN,
  RESONANCE_ZONE_RANGES,
  RESONANCE_ZONE_STOCK,
  zoneBounds,
  zoneSettings,
} from '../../audio/resonanceParams.js'
import {
  removeBoundary, setZoneParam, splitZone, toggleZone, toggleZoneProtect,
} from '../meters/resonanceZoneEdit.js'
import DeviceField from '../knobs/DeviceField.vue'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'

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
  /** Index of the soloed zone, or -1. Monitoring state, not a parameter. */
  solo: { type: Number, default: -1 },
  /**
   * The pitch range the protection mask looks for. GLOBAL — one tracker, one
   * signal, one pitch, however many zones read the answer — but it lives in
   * this component because it is half of one decision with the per-zone
   * protection toggle, and the two were a room apart on the faceplate.
   */
  pitchRange: { type: String, default: 'voice' },
  pitchRangeOptions: { type: Array, default: () => [] },
  pitchRangeCaption: { type: String, default: '' },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:zones', 'update:selected', 'solo', 'update:pitchRange'])

/**
 * The harmonics decision hides behind a door, and swaps places with the zone's
 * identity rather than opening beside it.
 *
 * Two reasons for the door. The protection toggle and the pitch range are ONE
 * decision — what counts as a harmonic here, and what pitch to look for — and
 * they were on opposite sides of the faceplate, one per zone and one global,
 * with nothing saying they were related. And the panel has no room for a third
 * cluster: everything added to this row so far has come out of the display.
 *
 * Swapping in place rather than expanding keeps the row height fixed, so
 * opening it never moves the knobs beside it. It closes on Escape and on
 * selecting a different zone — the settings inside are per zone, and a panel
 * left open on zone 2's harmonics while zone 4 is selected would be showing one
 * zone's identity and another's settings.
 */
const harmonicsOpen = ref(false)

watch(() => props.selected, () => { harmonicsOpen.value = false })

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
    maxCut: clamp(z?.maxCut ?? RESONANCE_ZONE_STOCK.maxCut, R.maxCut),
    protect: (z?.protect ?? RESONANCE_ZONE_STOCK.protect) !== false,
  }
})
const index = computed(() =>
  Math.max(0, Math.min(props.selected, props.zones.length - 1)))

const span = computed(() => {
  const b = zoneBounds(props.zones, 20, 20000)[index.value]
  if (!b) return ''
  const f = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`)
  return `${f(b.loHz)}–${f(b.hiHz)} Hz`
})

/**
 * Add and remove act on the SELECTED zone, not on the set as a whole.
 *
 * The control this replaces was a row of the numbers 1 to 6 with the current
 * count lit, borrowed from the reference design — and it read as a selector for
 * which zone was active, which is the one thing on this panel it was not. The
 * numbers were the problem: six of them in a row, next to a row that says
 * ZONE 3, cannot help but look like a way to choose zone 3.
 *
 * A pair of buttons around a count cannot be misread that way, and acting on
 * the selection makes both of them predictable — plus splits the zone you are
 * looking at, minus folds it into its neighbour, the same two edits the plot's
 * double-click makes.
 */
const anyProtect = computed(() => props.zones.some(z => zoneSettings(z).protect))
/** Any zone running unmasked. Tints the closed door, so the state is visible
 *  without opening it — the one thing a hidden control must not cost. */
const anyUnprotected = computed(() => props.zones.some(z => !zoneSettings(z).protect))

const canSplit = computed(() => props.zones.length < RESONANCE_ZONE_MAX)
const canMerge = computed(() => props.zones.length > RESONANCE_ZONE_MIN)

const AXIS = { w: 600, minHz: 20, maxHz: 20000 }
let seq = 0

function addZone() {
  const i = index.value
  const b = zoneBounds(props.zones, 20, 20000)[i]
  // The geometric centre, because the axis is logarithmic: the arithmetic
  // midpoint of 180 Hz and 5 kHz is 2.6 kHz, which sits three quarters of the
  // way along the span as drawn.
  const mid = Math.sqrt(b.loHz * b.hiHz)
  const next = splitZone(props.zones, mid, AXIS, `z${Date.now()}${seq++}`, 20, 20000)
  if (next === props.zones) return
  emit('update:zones', next)
  emit('update:selected', i)
}

function removeZone() {
  const i = index.value
  // Merging the last zone means dropping the divider below it; any other zone
  // absorbs the one above it. Either way the selection lands on the zone that
  // now covers where the old one was.
  const divider = i < props.zones.length - 1 ? i : i - 1
  const next = removeBoundary(props.zones, divider)
  if (next === props.zones) return
  emit('update:zones', next)
  emit('update:selected', Math.min(i, next.length - 1))
}

function set(name, value) {
  emit('update:zones', setZoneParam(props.zones, index.value, name, value))
}

const percent = v => `${Math.round(v * 100)}`
const oneDp = v => v.toFixed(1)
const db = v => `${Math.round(v)}`
</script>

<template>
  <div
    class="flex items-center gap-[16px] rounded-[7px] px-[14px] py-[10px]"
    @keydown.escape="harmonicsOpen = false"
    :style="{
      background: 'rgba(0,0,0,.28)',
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 20%, transparent)`,
      opacity: disabled ? 0.4 : 1,
    }"
  >
    <!-- Identity first: these knobs mean nothing without it, because the same
         three knobs show six different sets of values. -->
    <!-- The identity block, or the harmonics door in its place. -->
    <div class="w-[128px] shrink-0">
      <template v-if="!harmonicsOpen">
      <div
        style="font:700 12px 'JetBrains Mono',monospace;letter-spacing:.08em;white-space:nowrap"
        :style="{ color: settings.enabled
          ? `color-mix(in srgb, ${accent} 60%, #ffffff)` : 'rgba(255,255,255,.35)' }"
      >ZONE {{ index + 1 }}</div>
      <div class="flex items-baseline justify-between gap-[6px] mt-[2px]">
        <span style="font:600 9px 'JetBrains Mono',monospace;color:rgba(255,255,255,.4);white-space:nowrap"
        >{{ span }}</span>
      </div>


      <!-- BYPASS AND SOLO ARE NOT THE SAME KIND OF CONTROL, and the panel has
           to say so. Bypass is a setting: it is stored, it is rendered, a file
           applied with a zone off really has that band untreated. Solo is a
           monitoring state that never reaches Apply — the same distinction as
           DELTA in the header, which is why solo is lettered rather than shown
           as a second lamp. -->
      <div class="flex items-center gap-[5px] mt-[6px]">
        <button
          class="rounded-[4px] cursor-pointer disabled:cursor-default"
          style="padding:2px 6px;font:700 8px 'JetBrains Mono',monospace;letter-spacing:.1em"
          :style="{
            background: settings.enabled
              ? `color-mix(in srgb, ${accent} 22%, transparent)` : 'transparent',
            color: settings.enabled
              ? `color-mix(in srgb, ${accent} 55%, #ffffff)` : 'rgba(255,255,255,.4)',
            boxShadow: settings.enabled
              ? `inset 0 0 0 1px color-mix(in srgb, ${accent} 45%, transparent)`
              : 'inset 0 0 0 1px rgba(255,255,255,.16)',
          }"
          :aria-pressed="String(!settings.enabled)"
          :aria-label="`Zone ${index + 1} bypass, currently ${settings.enabled ? 'off' : 'on'}`"
          title="Bypass this zone — the effect leaves that band alone. Stored, and applied to the file."
          :disabled="disabled"
          @click="emit('update:zones', toggleZone(zones, index))"
        >{{ settings.enabled ? 'ON' : 'BYP' }}</button>
        <button
          class="rounded-[4px] cursor-pointer disabled:cursor-default"
          style="padding:2px 6px;font:700 8px 'JetBrains Mono',monospace;letter-spacing:.1em"
          :style="{
            background: solo === index ? '#ffb27a' : 'transparent',
            color: solo === index ? '#20160c' : 'rgba(255,255,255,.4)',
            boxShadow: solo === index
              ? '0 0 7px rgba(255,178,122,.5)' : 'inset 0 0 0 1px rgba(255,255,255,.16)',
          }"
          :aria-pressed="String(solo === index)"
          :aria-label="`Solo zone ${index + 1}`"
          title="Hear this zone's processing alone. Monitoring only — Apply always renders every zone."
          :disabled="disabled"
          @click="emit('solo', index)"
        >SOLO</button>
      </div>

        <button
          class="cursor-pointer shrink-0 disabled:cursor-default"
          style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.06em;white-space:nowrap"
          :style="{ color: anyUnprotected ? '#ffb27a' : 'rgba(255,255,255,.38)' }"
          :aria-expanded="String(harmonicsOpen)"
          title="Harmonic protection for this zone, and the pitch range the mask looks for."
          :disabled="disabled"
          @click="harmonicsOpen = true"
        > HARMONIC MASK›</button>
      </template>

      <template v-else>
        <button
          class="flex items-center gap-[4px] cursor-pointer"
          style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.5)"
          @click="harmonicsOpen = false"
        >‹ <span>HARMONIC MASK</span></button>

        <!-- Stacked, not side by side: the two together are wider than the
             identity block they replace, and letting them spill would push the
             knobs beside them. The row's height is set by those knobs, so there
             is vertical room going spare and none horizontally. -->
        <div class="flex flex-col items-start gap-[4px] mt-[5px]">


                  <button
          class="shrink-0 px-2 py-[6px] rounded-lg cursor-pointer transition-all text-left disabled:cursor-default"
          style="width:186px"
          :style="{
            background: settings.protect ? 'rgba(141,224,168,.14)' : 'rgba(255,178,122,.12)',
            border: `1px solid ${settings.protect ? 'rgba(141,224,168,.4)' : 'rgba(255,178,122,.45)'}`,
          }"
          title="Protects the harmonics of the pitched source in the recording from being treated as resonances. Turning it off is a diagnostic aid — it will thin the material."
          @click="emit('update:zones', toggleZoneProtect(zones, index))"
        >
          <span
            class="block"
            :style="{
              font: `700 8.5px 'JetBrains Mono',monospace`,
              letterSpacing: '.12em',
              color: resPreserveHarmonics ? '#8de0a8' : '#ffb27a',
            }"
          >{{ settings.protect ? 'PRESERVE HARMONICS' : 'PROTECTION OFF' }}</span>
          <span
            class="block mt-[2px]"
            style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.35)"
          >{{ settings.protect
            ? 'Preserves harmonic frequencies.'
            : 'Full suppression enabled.' }}</span>
        </button>

          <!-- Global, and sitting here anyway: it is what the mask hunts for,
               so it is unreadable apart from the switch that turns the mask on.
               Inert when no zone protects, because then it steers nothing. -->
               <span style="font:500 8.5px/1.25 'Inter';color: rgba(255,255,255,.42)"> PROTECTION RANGE:</span>
          <SegmentedSwitch
            :padding-x="7"
            :model-value="pitchRange"
            @update:model-value="emit('update:pitchRange', $event)"
            :options="pitchRangeOptions"
            :accent="accent"
            :disabled="disabled || !anyProtect"
          />
        </div>

        <div
          class="mt-[4px]"
          style="font:500 8.5px/1.25 'Inter';color: rgba(255,255,255,.42)"
        >{{ `Protect ${pitchRangeCaption ? ` (${pitchRangeCaption})` : ''}`}}</div>
      </template>
    </div>

    <div class="flex-1 flex justify-center items-center gap-[8px]">
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.selectivity" @update:model-value="set('selectivity', $event)"
          :min="RESONANCE_ZONE_RANGES.selectivity.min" :max="RESONANCE_ZONE_RANGES.selectivity.max"
          :step="0.5" :value-font-px="13"
          label="Selectivity" :accent="accent" :format-value="oneDp"
          :disabled="disabled"
        />
      </div>
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.sharpness" @update:model-value="set('sharpness', $event)"
          :min="RESONANCE_ZONE_RANGES.sharpness.min" :max="RESONANCE_ZONE_RANGES.sharpness.max"
          :step="0.01" :value-font-px="13"
          label="Sharpness" :accent="accent" :format-value="percent"
          :disabled="disabled"
        />
      </div>
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.depth" @update:model-value="set('depth', $event)"
          :min="RESONANCE_ZONE_RANGES.depth.min" :max="RESONANCE_ZONE_RANGES.depth.max"
          :step="0.01" :value-font-px="13"
          label="Depth" :accent="accent" :format-value="percent"
          :disabled="disabled"
        />
      </div>
      <!-- A ceiling is set once and read often, so it is a field rather than a
           dial — and it belongs here rather than among the global controls
           because the honest answer differs by band: a low-mid resonance can
           lose 12 dB before it is obviously gone, where the same number spent
           on sibilance is a lisp. -->
      <DeviceField
        :model-value="settings.maxCut" @update:model-value="set('maxCut', $event)"
        :min="RESONANCE_ZONE_RANGES.maxCut.min" :max="RESONANCE_ZONE_RANGES.maxCut.max"
        :step="1" :width="54"
        label="Max Cut" unit="dB" :accent="accent"
        :format-value="db" :disabled="disabled"
      />
    </div>

    <div>
          <div class="text-center mb-2" style="width:52px">
        <div style="font:700 12px 'JetBrains Mono',monospace;color:rgba(255,255,255,.62)">
          {{ zones.length }}</div>
        <div style="font:600 7.5px 'JetBrains Mono',monospace;letter-spacing:.1em;color:rgba(255,255,255,.3)">
          {{ zones.length === 1 ? 'ZONE' : 'ZONES' }}</div>
      </div>

    <div class="shrink-0 flex items-center gap-[7px]">
      <button
        class="cursor-pointer disabled:cursor-default disabled:opacity-30"
        style="width:23px;height:23px;border-radius:5px;font:700 14px/1 'JetBrains Mono',monospace;
               background:rgba(255,255,255,.06);color:rgba(255,255,255,.6)"
        :disabled="disabled || !canMerge"
        title="Merge this zone into its neighbour"
        aria-label="Merge this zone into its neighbour"
        @click="removeZone"
      >−</button>

      <button
        class="cursor-pointer disabled:cursor-default disabled:opacity-30"
        style="width:23px;height:23px;border-radius:5px;font:700 14px/1 'JetBrains Mono',monospace"
        :style="{
          background: `color-mix(in srgb, ${accent} 20%, transparent)`,
          color: `color-mix(in srgb, ${accent} 60%, #ffffff)`,
        }"
        :disabled="disabled || !canSplit"
        title="Split this zone in two"
        aria-label="Split this zone in two"
        @click="addZone"
      >+</button>
    </div>
  </div>


  </div>
</template>
