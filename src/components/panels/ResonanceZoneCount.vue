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
 * IT SITS IN THE DISPLAY'S HEADER ROW, BESIDE THE DEEPEST-CUT FIGURE. It began
 * inside the per-zone row, which was a category error — the count is the one
 * zone control that is not about a particular zone, and on a plate showing
 * ZONE 3's identity and settings it read as belonging to zone 3. Beside the
 * plot fixed that and cost the plot its WIDTH: a column carrying a 32 px
 * numeral, two buttons, FIT and a caption is ~90 px of horizontal extent spent
 * on a control nobody turns twice, on a plot whose axis is frequency and which
 * therefore wants every pixel of width it can get.
 *
 * In the header row it costs neither. That row is ~42 px tall because of the
 * 30 px reading at its left, and this is one 22 px line, so it fits in space
 * the numeral already holds — which is why it is laid out horizontally, and
 * why FIT stacks over its own caption rather than sitting beside it. It also
 * lands next to the thing it actually counts, which is the row of zone columns
 * on the plot directly below.
 *
 * ⚠ NOTHING IN HERE MAY GROW A SECOND LINE. The row's height is the numeral's,
 * and anything taller pushes the whole display down.
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
  /** A measurement is in flight. FIT is not clickable and says why. */
  busy: { type: Boolean, default: false },
  /**
   * Whether there is a region to measure.
   *
   * ⚠ FIT MEASURES THE SELECTION, so a selection is its INPUT rather than
   * something incidental to it — and without this prop the button was
   * clickable with nothing selected, the composable bailed on the missing
   * region, and the click was accepted and discarded. That is the worst of the
   * three states and this panel's ceiling presets already shipped it once.
   */
  hasSelection: { type: Boolean, default: false },
  /**
   * What FIT last measured, or null — `{ medianF0Hz, voiceType }`.
   *
   * Shown because a set of boundaries that moved for reasons the user cannot
   * see is worse than one that did not move. The pitch is the whole input to
   * the placement, so printing it is the difference between a button that did
   * something and a button that can be checked.
   */
  profile: { type: Object, default: null },
})

const emit = defineEmits(['update:zones', 'update:selected', 'fit'])

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

/**
 * FIT sits with the count because it is the other control that is about the
 * ROW of zones rather than about one of them — it rewrites every boundary at
 * once. Putting it in the per-zone strip would read as an operation on ZONE 3,
 * which is the category error the count row already had once.
 */
const fitLabel = computed(() => (props.busy ? 'FITTING' : 'VOICE FIT'))

/**
 * Why FIT cannot be pressed, or null.
 *
 * Printed rather than left to the disabled styling alone: a greyed button with
 * nothing beside it says only that something is wrong, and the three reasons
 * have three different fixes. Same rule the ceiling presets ended up with.
 */
const fitDisabledReason = computed(() => {
  if (props.busy) return 'Measuring pitch\u2026'
  if (props.disabled) return 'Turn ResoTame on'
  if (!props.hasSelection) return 'Select audio to fit'
  return null
})
const fitDisabled = computed(() => fitDisabledReason.value !== null)

const fitCaption = computed(() => {
  if (fitDisabledReason.value) return fitDisabledReason.value
  const f0 = props.profile?.medianF0Hz
  return f0 > 0 ? `F0 ${Math.round(f0)} Hz` : 'Places zones from pitch'
})
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
  Utilities rather than inline style, and every `leading-none` here is carrying
  its weight. These were `font:` shorthands, and that property resets
  line-height. Preflight sets 1.5 on the root, so dropping the leading does not
  preserve the layout — and in this row that is not a nicety: 1.5 on the numeral
  alone makes this taller than the reading it sits beside, which sets the header
  row's height and pushes the whole display down.
-->
<template>
  <div class="flex flex-col items-center">
  <div class="flex items-center gap-[16px] shrink-0" :class="{ 'opacity-40': disabled }">
    <!-- THE TWO ACCENT MIXES ARE RESOLVED TO LITERALS, which is what lets
         these buttons be classes rather than a bound style: a utility is a
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
    <span class="ml-[4px] font-mono text-[9px] font-semibold leading-none tracking-[.1em] text-text-faint">
        {{ zones.length === 1 ? 'ZONE' : 'ZONES' }}</span>


    <div class="flex gap-[8px]">    
    <button
      class="w-[22px] h-[20px] rounded-[5px] font-mono text-[14px] font-bold leading-none
             bg-surface-2 text-text-softer hover:bg-[#8de0a833] hover:text-[#bbeccb]
             cursor-pointer disabled:cursor-default disabled:opacity-30"
      :disabled="disabled || !canMerge"
      title="Merge this zone into its neighbour"
      aria-label="Merge this zone into its neighbour"
      @click="removeZone"
    >−</button>

    <!-- Fixed width so the buttons do not step sideways between ZONE and
         ZONES, which on a horizontal row is a visible twitch rather than the
         invisible one it was in a centred column. Sized to the longer of the
         two strings and no wider: this row shares 608 px with two readouts,
         and the tightest case — DELTA lit, FIT idle, several resonances
         tracked — has nothing to spare. -->
    <div class="w-[24px] text-center whitespace-nowrap">
      <span class="font-mono text-[22px] font-bold leading-none text-text-softer">
        {{ zones.length }}</span>
    </div>

    <button
      class="w-[22px] h-[20px] rounded-[5px] font-mono text-[14px] font-bold leading-none
             bg-surface-2 text-text-softer hover:bg-[#8de0a833] hover:text-[#bbeccb]
             cursor-pointer disabled:cursor-default disabled:opacity-30"
      :disabled="disabled || !canSplit"
      title="Split this zone at its centre"
      aria-label="Split this zone at its centre"
      @click="addZone"
    >+</button>
    </div>

    <!-- The boundaries this panel ships are the MALE region table applied to
         every voice — 1100 Hz is within an eighth of an octave of
         `lower_presence`'s bottom (1200). FIT measures the speaker, scales that
         one by its own anchor's ratio, and derives the other two from the
         measured pitch: the sub-fundamental split, and a Z2 top that actually
         contains the fundamental. A male narrator reproduces the shipped UPPER
         boundaries exactly, so nothing already listened to moves. See
         resonanceZonePlacement.js. -->
    <!-- FIT over its caption, mirroring the overlay switches at the other end
         of the row, which stack under their own summary line for the same
         reason: side by side these two are ~160 px of a row that has two
         readouts to fit as well. -->
    <span class="flex flex-col items-center justify-center gap-[3px]">
      <button
        class="px-[7px] py-[3px] rounded-[5px] font-mono text-[9px] font-semibold
               leading-none tracking-[.1em] bg-surface-2 text-text-softer
               hover:bg-[#8de0a833] hover:text-[#bbeccb]
               cursor-pointer disabled:cursor-default disabled:opacity-30"
        :disabled="fitDisabled"
        title="Measure the voice and place the zone boundaries from its pitch"
        @click="emit('fit')"
      >{{ fitLabel }}</button>
      <span class="font-mono text-[8px] leading-none text-text-faint">{{ fitCaption }}</span>
    </span>
  </div>
  </div>
</template>
