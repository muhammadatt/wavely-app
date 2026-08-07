<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import Knob from '../../knobs/Knob.vue'
import FilterShapePicker from './FilterShapePicker.vue'
import {
  PARAM_RANGES, qRangeFor, shapesForBand, quantizeQ,
} from '../../../audio/eqBands.js'

/**
 * General mode — a conventional parametric EQ.
 *
 * This is the mode that has to work on a lecture recording, a field recording
 * or a music bed: material for which no voice reference exists and none could.
 * No analysis, no roles, no suggestions.
 *
 * Every band gets its own strip, all of them on screen at once. An earlier
 * version showed one numeric row for whichever band was selected — the usual
 * parametric-EQ inspector. It is compact and every professional recognises it,
 * and it was the wrong trade here: it makes the curve the only view of the
 * whole chain, and the curve is only a view if you can already read one. A
 * narrator looking at four strips can see there are four bands, which one is
 * cutting and where, without knowing what an EQ curve means. It also left bands
 * unreachable whenever two handles overlapped, since the plot was the only way
 * to select one.
 */

const props = defineProps({
  eq: { type: Object, required: true },
  accent: { type: String, required: true },
  sampleRate: { type: Number, default: 44100 },
  /** Set by the faceplate, which sizes the level meters to match. */
  plotHeight: { type: Number, default: 200 },
})

/**
 * The band under the pointer, from whichever surface the pointer is on.
 *
 * Set by hovering a strip and by hovering its dot on the curve, and read by
 * both — so the highlight is symmetric and either surface teaches the other.
 * That link is what lets the two control surfaces coexist for two audiences
 * instead of competing: a novice living in the strips picks up what the dots
 * are without ever being made to use them.
 */
const hoveredId = ref(null)

// ── Strip order ───────────────────────────────────────────────────────────
// Strips read low to high, left to right, so the row is in the same order as
// the curve above it. That correspondence is most of what makes the row
// teachable, and it is worth the freeze below to keep.

const orderFrozen = ref(false)
let frozenIds = []

const orderedBands = computed(() => {
  const list = [...props.eq.bands.value]
  if (orderFrozen.value) {
    const rank = new Map(frozenIds.map((id, i) => [id, i]))
    return list.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
  }
  return list.sort((a, b) => a.frequencyHz - b.frequencyHz)
})

/**
 * Hold the order still for the duration of a drag.
 *
 * Without this, dragging a frequency knob past its neighbour makes the strip
 * jump sideways out from under the pointer — the control you are holding
 * teleports. Freezing on pointer-down and thawing on release keeps the sort
 * without ever re-sorting while a hand is on it.
 */
function freezeOrder() {
  frozenIds = orderedBands.value.map(b => b.id)
  orderFrozen.value = true
  window.addEventListener('pointerup', thawOrder, { once: true })
  window.addEventListener('pointercancel', thawOrder, { once: true })
}

function thawOrder() {
  orderFrozen.value = false
}

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', thawOrder)
  window.removeEventListener('pointercancel', thawOrder)
})

// ── Plot interaction ──────────────────────────────────────────────────────

function onCreate({ frequencyHz, gainDb }) {
  props.eq.addBand({ frequencyHz, gainDb, q: 1, type: 'peaking', origin: 'manual_general' })
}

function onMove({ id, frequencyHz, gainDb }) {
  props.eq.setFrequency(id, frequencyHz)
  props.eq.setGain(id, gainDb)
}

function onQ({ id, delta }) {
  const band = props.eq.findBand(id)
  if (!band) return
  // Multiplicative, so the step feels the same at Q 0.5 and Q 8.
  props.eq.setQ(id, band.q * (delta > 0 ? 1.15 : 1 / 1.15))
}

// ── Formatting ────────────────────────────────────────────────────────────

function fmtHz(hz) {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)}k`
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)}k`
  return String(Math.round(hz))
}

function fmtGain(db) {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

function fmtQ(q) {
  return q >= 10 ? String(Math.round(q)) : q.toFixed(1)
}

/**
 * Frequency rounding that tracks magnitude: 1 Hz where a hertz is audible,
 * 100 Hz up where it is not. A flat step would be either uselessly coarse at
 * 60 Hz or absurdly fine at 15 kHz.
 */
function quantizeHz(hz) {
  if (hz >= 10000) return Math.round(hz / 100) * 100
  if (hz >= 1000) return Math.round(hz / 10) * 10
  return Math.round(hz)
}

function qRangeForBand(band) {
  return qRangeFor(band.type)
}

/**
 * Shapes with no gain parameter.
 *
 * These cut by construction: a notch is a full null at its centre frequency, a
 * pass filter removes everything past its corner. The kernel's notch(), and
 * RBJ's, take no gain term at all — a live knob here would move and change
 * nothing.
 *
 * They are shown readonly rather than disabled, and labelled with what the
 * filter does rather than with what it lacks. A dimmed knob under the words
 * "no gain" reads as a broken control; the depth is not missing, it is the
 * point of choosing this shape. Anyone wanting an adjustable cut instead of a
 * full one wants a bell at high Q, which is the neighbouring option.
 */
function gainInert(band) {
  return band.type === 'highpass' || band.type === 'lowpass' || band.type === 'notch'
}

function gainLabel(band) {
  if (band.type === 'notch') return 'full cut'
  if (band.type === 'highpass' || band.type === 'lowpass') return 'no gain'
  return 'gain dB'
}
</script>

<template>
  <div>
    <!-- The how-to moved from a line of body copy under the plot into the
         plot's own tooltip. It was facts a user needs once, occupying a row of a
         window already at its height limit — and a tooltip on the thing being
         described is where someone looks when stuck, which is the only time it
         is wanted.

         This one covers the empty canvas only. The band dots carry their own,
         which the browser prefers over this while the pointer is on one. -->
    <EqPlot
      title="Click anywhere on the plot to add a band · double-click any knob to type an exact value"
      :bands="eq.bands.value"
      :sample-rate="sampleRate"
      :accent="accent"
      :height="plotHeight"
      :selected-id="hoveredId"
      :show-analyzer="eq.showAnalyzer.value"
      :spectrum-fn="eq.getSpectrum"
      :db-range="eq.dbRange.value"
      :solo-id="eq.soloBandId.value"
      range-control
      cursor-readout
      @update:db-range="eq.dbRange.value = $event"
      @create-band="onCreate"
      @hover-band="hoveredId = $event"
      @select-band="hoveredId = $event"
      @move-band="onMove"
      @q-band="onQ"
      @remove-band="eq.removeBand"
      @toggle-band="eq.toggleBand"
    />

    <!-- ── Band strips ──────────────────────────────────────────────────── -->
    <div
      v-if="orderedBands.length > 0"
      class="mt-[12px] pt-[12px] flex justify-center gap-x-[8px]"
      style="border-top:1px solid rgba(255,255,255,.06)"
    >
      <div
        v-for="(band, i) in orderedBands"
        :key="band.id"
        class="flex flex-col items-center w-[64px] shrink-0 rounded-[4px] px-[1px] pb-[4px] transition-colors"
        :style="{
          background: hoveredId === band.id ? 'rgba(255,255,255,.045)' : 'transparent',
          opacity: band.enabled ? 1 : 0.45,
        }"
        @pointerenter="hoveredId = band.id"
        @pointerleave="hoveredId = null"
        @pointerdown="freezeOrder"
      >
        <span
          class="mb-[3px]"
          style="font:600 8px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
        >{{ i + 1 }}</span>

        <Knob
          :model-value="gainInert(band) ? 0 : band.gainDb"
          :min="PARAM_RANGES.gainDb[0]" :max="PARAM_RANGES.gainDb[1]" :step="0.1"
          label=""
          bipolar
          :editable="!gainInert(band)"
          :readonly="gainInert(band)"
          :accent="accent"
          :value-font-px="11"
          :format-value="gainInert(band) ? () => '—' : fmtGain"
          @update:model-value="eq.setGain(band.id, $event)"
        />
        <span
          class="uppercase mt-[4px]"
          style="font:600 8px/1 'Inter';letter-spacing:.1em"
          :style="{ color: gainInert(band) ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.45)' }"
        >{{ gainLabel(band) }}</span>

        <div class="w-full mt-[7px]">
          <FilterShapePicker
            :model-value="band.type"
            :options="shapesForBand(band, eq.bands.value)"
            :accent="accent"
            @update:model-value="eq.setType(band.id, $event)"
          />
        </div>

        <div class="w-[46px] mt-[7px]">
          <Knob
            :model-value="band.frequencyHz"
            :min="PARAM_RANGES.frequencyHz[0]" :max="PARAM_RANGES.frequencyHz[1]"
            scale="log"
            label=""
            editable
            :quantize="quantizeHz"
            :accent="accent"
            :value-font-px="9"
            :format-value="fmtHz"
            @update:model-value="eq.setFrequency(band.id, $event)"
          />
        </div>
        <span
          class="uppercase mt-[3px]"
          style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.45)"
        >freq Hz</span>

        <div class="w-[46px] mt-[7px]">
          <Knob
            :model-value="band.q"
            :min="qRangeForBand(band)[0]" :max="qRangeForBand(band)[1]"
            scale="log"
            label=""
            editable
            :quantize="quantizeQ"
            :accent="accent"
            :value-font-px="9"
            :format-value="fmtQ"
            @update:model-value="eq.setQ(band.id, $event)"
          />
        </div>
        <span
          class="uppercase mt-[3px]"
          style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.45)"
        >width</span>

        <div class="flex items-center gap-[3px] mt-[7px]">
          <button
            type="button"
            class="px-[5px] py-[3px] rounded-[2px]"
            style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
            :style="{
              color: band.enabled ? accent : 'rgba(255,255,255,.35)',
              background: band.enabled
                ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
            }"
            :title="band.enabled ? 'Turn this band off' : 'Turn this band on'"
            @click="eq.toggleBand(band.id)"
          >{{ band.enabled ? 'ON' : 'OFF' }}</button>
          <button
            type="button"
            class="px-[5px] py-[3px] rounded-[2px]"
            style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
            :style="{
              color: eq.soloBandId.value === band.id ? accent : 'rgba(255,255,255,.35)',
              background: eq.soloBandId.value === band.id
                ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
            }"
            title="Hear this band alone"
            @click="eq.soloBandId.value === band.id ? eq.clearSolo() : eq.setSolo(band.id)"
          >S</button>
          <button
            type="button"
            class="px-[5px] py-[3px] rounded-[2px]"
            style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.35)"
            title="Remove this band"
            @click="eq.removeBand(band.id)"
          >×</button>
        </div>
      </div>
    </div>

    <p
      v-else
      class="mt-[12px] text-center"
      style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.3)"
    >
      No bands yet. Click anywhere on the curve to add one.
    </p>

    <p
      v-if="eq.atBandLimit.value"
      class="mt-[8px] text-center"
      style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.65)"
    >
      All {{ eq.maxBands }} bands are in use — remove one to add another.
    </p>
  </div>
</template>
