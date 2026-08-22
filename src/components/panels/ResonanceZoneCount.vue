<script setup>
import { computed } from 'vue'
import {
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN,
  zoneBounds,
} from '../../audio/resonanceParams.js'
import { removeBoundary, splitZone } from '../meters/resonanceZoneEdit.js'

/**
 * How many zones there are, and the pair that changes it.
 *
 * IT LIVES BESIDE THE PLOT, in the column the output meter used to have. Two
 * reasons, and the first is the stronger: this is the one zone control that is
 * not about a particular zone, so sitting inside a row that shows ONE zone's
 * identity and settings was a category error — the count was reading as
 * something belonging to ZONE 3 because it was on the same plate. Beside the
 * plot it sits next to the thing it actually describes, which is the row of
 * columns, not the knobs. The second is height: that column already exists and
 * was carrying a meter, so the count costs the panel nothing.
 *
 * NOT A ROW OF NUMBERS 1..6 WITH THE CURRENT COUNT LIT. That was the first
 * version, borrowed from the reference design, and it read as a selector for
 * which zone was active — six numbers in a row, beside a row that says ZONE 3,
 * cannot help but look like a way to choose zone 3. A pair of buttons around a
 * count cannot be misread that way.
 *
 * BOTH BUTTONS ACT ON THE SELECTED ZONE, which is what makes them predictable:
 * plus splits the zone you are looking at at its geometric centre, minus folds
 * it into its neighbour — the same two edits the plot's double-click makes. A
 * split inherits the zone's settings, because it means "this span needs to be
 * two spans", not "throw away what I set here".
 */
const props = defineProps({
  zones: { type: Array, required: true },
  selected: { type: Number, default: 0 },
  // No `accent`: both colours this control draws are resolved literals now,
  // so a prop for it would be a knob wired to nothing.
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:zones', 'update:selected'])

const index = computed(() =>
  Math.max(0, Math.min(props.selected, props.zones.length - 1)))

const canSplit = computed(() => props.zones.length < RESONANCE_ZONE_MAX)
const canMerge = computed(() => props.zones.length > RESONANCE_ZONE_MIN)

/**
 * The axis the edits are expressed against.
 *
 * Zone boundaries are stored as fractions of a log-frequency axis, and both
 * edits here name a frequency, so they need one to convert through. The width
 * is nominal — the geometry is scale-free in the fraction, and nothing on this
 * control is drawn — which is why it does not have to agree with the plot's
 * measured width.
 */
const AXIS = { w: 600, minHz: 20, maxHz: 20000 }
let seq = 0

function addZone() {
  const i = index.value
  const b = zoneBounds(props.zones, 20, 20000)[i]
  if (!b) return
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
</script>

<!--
  Utilities rather than inline style, with two deliberate exceptions below.

  `leading-none` on the buttons and `leading-[normal]` on the readout are both
  carrying their weight. These were `font:` shorthands, and that property resets
  line-height — to `1` where it was written `14px/1`, and to `normal` where no
  slash appeared. Preflight sets 1.5 on the root, so dropping the leading
  entirely does not preserve the layout: it makes the 24 px numeral's box 36 px
  instead of ~28, which moves both buttons.
-->
<template>
  <div class="flex flex-col items-center" :class="{ 'opacity-40': disabled }">
          <div class="text-center mb-1">
        <div class="font-mono text-[32px] font-bold leading-[normal] text-text-softer">
          {{ zones.length }}</div>
        <div class="font-mono text-[7.5px] font-semibold leading-[normal] tracking-[.1em] text-text-faint">
          {{ zones.length === 1 ? 'ZONE' : 'ZONES' }}</div>
      </div>

    <div class="flex items-center gap-[8px] mt-[6px]">
      <!-- THE TWO ACCENT MIXES ARE RESOLVED TO LITERALS, which is what lets
           this button be classes rather than a bound style: a utility is a
           static string, and color-mix() over a runtime prop is not.

           Both are exact rather than eyeballed, computed against ResoTame's
           #8de0a8. `color-mix(in srgb, X 20%, transparent)` is premultiplied,
           so it resolves to the accent at alpha 0.2 — #8de0a833, since 0x33 is
           51/255 = 0.2 — and `X 60%, #ffffff` interpolates each channel in
           gamma-encoded sRGB to #bbeccb.

           THE COST IS THAT THIS NO LONGER FOLLOWS THE PANEL. ResoTame's accent
           is a constant today, so nothing is lost; if the panel is ever
           re-tinted, or this control is reused under a different one, these two
           literals are what will not move with it. -->
                 <button
        class="w-[23px] h-[23px] rounded-[5px] font-mono text-[14px] font-bold leading-none
               bg-surface-2 text-text-softer hover:bg-[#8de0a833] hover:text-[#bbeccb]
               cursor-pointer disabled:cursor-default disabled:opacity-30"
        :disabled="disabled || !canMerge"
        title="Merge this zone into its neighbour"
        aria-label="Merge this zone into its neighbour"
        @click="removeZone"
      >−</button>
      <button
        class="w-[23px] h-[23px] rounded-[5px] font-mono text-[14px] font-bold leading-none
               bg-surface-2 text-text-softer hover:bg-[#8de0a833] hover:text-[#bbeccb]
               cursor-pointer disabled:cursor-default disabled:opacity-30"
        :disabled="disabled || !canSplit"
        title="Split this zone in two"
        aria-label="Split this zone in two"
        @click="addZone"
      >+</button>



    </div>
  </div>
</template>
