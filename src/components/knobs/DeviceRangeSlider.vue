<script setup>
import { computed } from 'vue'

/**
 * Two-handle range fader — DeviceSlider's sibling, for a pair of values that
 * are one idea.
 *
 * A low limit and a high limit are not two settings, they are the ends of a
 * band, and as two separate faders they read as unrelated: nothing on screen
 * says which is the bottom of what, the two tracks span different ranges at
 * different scales, and the thing being set — the width and placement of the
 * processed band — is nowhere. One track with two handles states it directly:
 * the lit span between them IS the band.
 *
 * LOG TRACK. Frequency ranges are read by ratio, not by difference. On a linear
 * track the audible bottom four octaves would share the first 5% of the width
 * and be unadjustable; here an octave is an octave anywhere along it.
 *
 * EACH HANDLE STOPS AT THE OTHER ONE, and at nothing else. The two parameters
 * had their own sub-ranges as separate faders (low ≤ 1 kHz, high ≥ 2 kHz) and
 * this control kept them at first, on the argument that merging two faders is
 * presentational and should not widen what the effect can be set to. That was
 * wrong about how the merged control reads: on two separate faders a limit is
 * just where that fader ends, but on one shared track a handle stopping dead in
 * open space with more track visibly in front of it reads as a jam, not as a
 * limit. Nothing about the kernel wanted those stops — it clamps the ceiling to
 * the floor and processes whatever band it is given — so what is left is the
 * only bound the parameters actually have on each other.
 *
 * A closed band is therefore reachable, and it means the effect processes
 * nothing. That is legible rather than silent: the display washes out every
 * frequency outside the band, so closing it greys the whole plot.
 *
 * Two overlaid range inputs rather than a hand-rolled div, for the reason
 * DeviceSlider gives: keyboard control and screen-reader semantics come for
 * free. Both span the full track so their geometry matches the drawn fill
 * exactly; the limits are enforced on the value rather than by shortening an
 * element, which would put the two thumbs on different pixel scales.
 */
const props = defineProps({
  low: { type: Number, required: true },
  high: { type: Number, required: true },
  min: { type: Number, default: 20 },
  max: { type: Number, default: 20000 },
  label: { type: String, default: '' },
  accent: { type: String, default: '#f5a623' },
  formatValue: { type: Function, default: v => String(Math.round(v)) },
  disabled: { type: Boolean, default: false },
  /**
   * Positions along the track. The step is a position, not a frequency, so the
   * resolution is constant in octaves rather than 500 times finer at the top of
   * the range than at the bottom.
   */
  steps: { type: Number, default: 480 },
  /** Round a raw track frequency to something worth printing. */
  snap: { type: Function, default: v => Math.round(v) },
})

const emit = defineEmits(['update:low', 'update:high'])

const logMin = computed(() => Math.log2(props.min))
const logSpan = computed(() => Math.log2(props.max / props.min))

const posOf = hz =>
  Math.round(((Math.log2(hz) - logMin.value) / logSpan.value) * props.steps)
const hzOf = pos =>
  props.min * Math.pow(2, (pos / props.steps) * logSpan.value)

/**
 * Track inset, in pixels: half a thumb.
 *
 * A range input's thumb centre travels between half a thumb from each end, so a
 * fill drawn from 0% to 100% of the element runs past both handles at the
 * extremes. Insetting the drawn span by the same amount keeps the lit band
 * ending exactly under the handle that defines it.
 */
const INSET = 8.5

const fracOf = hz => Math.max(0, Math.min(1, posOf(hz) / props.steps))
// Strings, because these land on custom properties and a bare number would
// depend on the renderer stringifying it for setProperty.
const lowFrac = computed(() => String(fracOf(props.low)))
const highFrac = computed(() => String(fracOf(props.high)))

const valColor = computed(() => `color-mix(in srgb, ${props.accent} 60%, #ffffff)`)

function onLow(e) {
  const hz = props.snap(hzOf(Number(e.target.value)))
  emit('update:low', Math.max(props.min, Math.min(props.high, hz)))
}

function onHigh(e) {
  const hz = props.snap(hzOf(Number(e.target.value)))
  emit('update:high', Math.min(props.max, Math.max(props.low, hz)))
}

/**
 * Which thumb takes a press where the two are on top of one another.
 *
 * Handles that can meet can also hide each other, and the one underneath is
 * then unreachable — a real trap, because the way out of a closed band is to
 * grab one of the two handles sitting in the same place. Whichever one still
 * has somewhere to go wins: with the band closed at the top of the range only
 * the low handle can move, and closed anywhere else the high handle can always
 * open it to the right. So the answer is just "is the high handle pinned at the
 * end", and it is checked whether or not they actually coincide — where they do
 * not, z-order decides nothing.
 */
const lowOnTop = computed(() => props.high >= props.max)
</script>

<template>
  <div
    class="dev-range w-full select-none"
    :style="{
      '--accent': accent,
      '--inset': `${INSET}px`,
      '--low': lowFrac,
      '--high': highFrac,
      opacity: disabled ? 0.4 : 1,
    }"
  >
    <div class="flex items-baseline justify-between gap-2 mb-[7px]">
      <span class="dev-range__label uppercase">{{ label }}</span>
      <span class="dev-range__value tabular-nums" :style="{ color: valColor }">
        {{ formatValue(low) }} – {{ formatValue(high) }}
      </span>
    </div>

    <div class="dev-range__track">
      <!-- Groove, then the lit band between the handles. Drawn rather than
           taken from a range input's own fill: neither input knows where the
           other one is, so neither can paint a span that starts at one handle
           and ends at the other. -->
      <div class="dev-range__groove"></div>
      <div class="dev-range__band"></div>

      <input
        type="range" class="dev-range__input"
        :min="0" :max="steps" :step="1"
        :value="posOf(low)"
        :disabled="disabled"
        :style="{ zIndex: lowOnTop ? 2 : 1 }"
        :aria-label="`${label} low limit`"
        :aria-valuetext="formatValue(low)"
        @input="onLow"
      />
      <input
        type="range" class="dev-range__input"
        :min="0" :max="steps" :step="1"
        :value="posOf(high)"
        :disabled="disabled"
        :style="{ zIndex: lowOnTop ? 1 : 2 }"
        :aria-label="`${label} high limit`"
        :aria-valuetext="formatValue(high)"
        @input="onHigh"
      />
    </div>
  </div>
</template>

<style scoped>
.dev-range__label {
  font: 600 10px/1 'Inter', system-ui, sans-serif;
  letter-spacing: 0.14em;
  color: rgba(255, 255, 255, 0.55);
}

.dev-range__value {
  font: 500 13px/1 'JetBrains Mono', monospace;
}

.dev-range__track {
  position: relative;
  height: 20px;
}

.dev-range__groove,
.dev-range__band {
  position: absolute;
  top: 7px;
  height: 6px;
  border-radius: 999px;
  pointer-events: none;
}

.dev-range__groove {
  left: 0;
  right: 0;
  background: rgba(255, 255, 255, 0.07);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.65),
    inset 0 0 0 1px rgba(0, 0, 0, 0.35);
}

/* Unitless fractions, so the travel can be expressed as `(100% - a thumb) *
   fraction`. Percentages would not compose: calc cannot divide a pixel inset by
   a percentage, and without the inset the band overshoots its own handles by
   half a thumb at each end of the track. */
.dev-range__band {
  left: calc(var(--inset) + (100% - 2 * var(--inset)) * var(--low));
  width: calc((100% - 2 * var(--inset)) * (var(--high) - var(--low)));
  background: var(--accent);
}

/* Both inputs cover the whole track, so only the thumbs may take the pointer —
   otherwise the one on top would swallow every press and the handle underneath
   could never be grabbed. Clicking the bare groove does nothing as a result,
   which on a two-handle control is the safer behaviour anyway: there is no
   answer to which handle a click in the middle meant to move. */
.dev-range__input {
  -webkit-appearance: none;
  appearance: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 20px;
  margin: 0;
  background: transparent;
  pointer-events: none;
}

.dev-range__input::-webkit-slider-runnable-track {
  height: 6px;
  background: transparent;
}
.dev-range__input::-moz-range-track {
  height: 6px;
  background: transparent;
}

.dev-range__input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 17px;
  height: 17px;
  margin-top: -5.5px;
  border-radius: 999px;
  cursor: ew-resize;
  background: radial-gradient(circle at 50% 34%, #78808b 0%, #454d57 55%, #262c34 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    inset 0 -2px 3px rgba(0, 0, 0, 0.55),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
.dev-range__input::-moz-range-thumb {
  pointer-events: auto;
  width: 17px;
  height: 17px;
  border: none;
  border-radius: 999px;
  cursor: ew-resize;
  background: radial-gradient(circle at 50% 34%, #78808b 0%, #454d57 55%, #262c34 100%);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
.dev-range__input:disabled::-webkit-slider-thumb {
  cursor: default;
}
.dev-range__input:disabled::-moz-range-thumb {
  cursor: default;
}

.dev-range__input:focus-visible {
  outline: none;
}
.dev-range__input:focus-visible::-webkit-slider-thumb {
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.35),
    0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
.dev-range__input:focus-visible::-moz-range-thumb {
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent),
    0 3px 7px rgba(0, 0, 0, 0.6);
}
</style>
