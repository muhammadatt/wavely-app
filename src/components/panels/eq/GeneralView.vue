<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import FilterShapePicker from './FilterShapePicker.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import ModulaChip from '../../modula/ModulaChip.vue'
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

function onCreate({ frequencyHz, gainDb, adopt }) {
  const band = props.eq.addBand({
    frequencyHz, gainDb, q: 1, type: 'peaking', origin: 'manual_general',
  })
  // Hand the id straight back so the press that made it can go on to drag it.
  adopt?.(band?.id)
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

/** Typed frequencies accept "2.4k" as well as "2400". */
function parseHz(raw) {
  const m = /^\s*([0-9]*[.,]?[0-9]+)\s*(k)?/i.exec(raw)
  if (!m) return NaN
  const v = parseFloat(m[1].replace(',', '.'))
  return m[2] ? v * 1000 : v
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
  return 'gain'
}

/** The kit's second hue: frequency and width are WHERE and HOW WIDE, not how much. */
const SECOND = 'var(--m-second)'
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
      design="modula"
      title="Click anywhere on the plot to add a band · click a value under a knob to type an exact one"
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
    <div v-if="orderedBands.length > 0" class="eq-strips">
      <div
        v-for="(band, i) in orderedBands"
        :key="band.id"
        class="eq-strip"
        :class="{ 'is-hot': hoveredId === band.id, 'is-off': !band.enabled }"
        @pointerenter="hoveredId = band.id"
        @pointerleave="hoveredId = null"
        @pointerdown="freezeOrder"
      >
        <span class="eq-strip-num">{{ i + 1 }}</span>

        <!-- Gain: the one thing here that is HOW MUCH, so it takes the accent.
             A notch or pass filter has no gain term — shown, not dimmed. -->
        <ModulaKnob
          variant="arc" :size="52" bipolar
          :model-value="gainInert(band) ? 0 : band.gainDb"
          :min="PARAM_RANGES.gainDb[0]" :max="PARAM_RANGES.gainDb[1]" :step="0.1"
          :default-value="0" :readonly="gainInert(band)" :editable="!gainInert(band)" show-value
          :label="gainLabel(band)" :aria-label="`Band ${i + 1} gain`" :color="accent"
          :format-value="gainInert(band) ? () => '—' : fmtGain"
          @update:model-value="eq.setGain(band.id, $event)"
        />

        <div class="eq-strip-shape">
          <FilterShapePicker
            design="modula"
            :model-value="band.type"
            :options="shapesForBand(band, eq.bands.value)"
            :accent="accent"
            @update:model-value="eq.setType(band.id, $event)"
          />
        </div>

        <ModulaKnob
          variant="arc" :size="42" scale="log" editable show-value
          :model-value="band.frequencyHz"
          :min="PARAM_RANGES.frequencyHz[0]" :max="PARAM_RANGES.frequencyHz[1]"
          :quantize="quantizeHz" :parse-value="parseHz"
          label="freq" :aria-label="`Band ${i + 1} frequency`" :color="SECOND"
          :format-value="v => `${fmtHz(v)} Hz`"
          @update:model-value="eq.setFrequency(band.id, $event)"
        />

        <ModulaKnob
          variant="arc" :size="42" scale="log" editable show-value
          :model-value="band.q"
          :min="qRangeForBand(band)[0]" :max="qRangeForBand(band)[1]"
          :quantize="quantizeQ"
          label="width" :aria-label="`Band ${i + 1} width (Q)`" :color="SECOND"
          :format-value="v => `Q ${fmtQ(v)}`"
          @update:model-value="eq.setQ(band.id, $event)"
        />

        <div class="eq-strip-chips">
          <ModulaChip
            variant="flat" :model-value="band.enabled" :label="band.enabled ? 'ON' : 'OFF'" :color="accent"
            :title="band.enabled ? 'Turn this band off' : 'Turn this band on'"
            :aria-label="`Band ${i + 1} on`"
            @update:model-value="eq.toggleBand(band.id)"
          />
          <ModulaChip
            variant="flat" :model-value="eq.soloBandId.value === band.id" label="S" :color="SECOND"
            :disabled="!band.enabled"
            :title="band.enabled ? 'Hear this band alone' : 'Turn this band on to solo it'"
            :aria-label="`Solo band ${i + 1}`"
            @update:model-value="eq.soloBandId.value === band.id ? eq.clearSolo() : eq.setSolo(band.id)"
          />
          <ModulaChip
            variant="flat" label="×" danger title="Remove this band" :aria-label="`Remove band ${i + 1}`"
            @click="eq.removeBand(band.id)"
          />
        </div>
      </div>
    </div>

    <p
      v-else
      class="mt-[14px] text-center"
      style="font:500 10px/1.5 var(--m-font-ui);color:var(--m-ink-4)"
    >
      No bands yet. Click anywhere on the curve to add one.
    </p>

    <p
      v-if="eq.atBandLimit.value"
      class="mt-[8px] text-center"
      style="font:600 9px/1.4 var(--m-font-ui);color:var(--m-accent)"
    >
      All {{ eq.maxBands }} bands are in use — remove one to add another.
    </p>
  </div>
</template>

<style scoped>
.eq-strips {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  gap: 8px;
}
.eq-strip {
  width: 76px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 7px 4px 9px;
  border-radius: 12px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
  transition: box-shadow .15s ease, opacity .15s ease;
}
.eq-strip.is-hot {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 0 0 1px color-mix(in srgb, var(--m-accent) 45%, #000);
}
.eq-strip.is-off { opacity: .5; }
.eq-strip-num {
  font: 600 9px/1 var(--m-font-mono);
  color: var(--m-ink-4);
}
.eq-strip-shape { width: 56px; }
.eq-strip-chips { display: flex; gap: 3px; }
.eq-strip-chips :deep(.m-chip) { padding: 0 5px; min-width: 20px; }
.eq-strip :deep(.m-knob--arc) { gap: 5px; }
</style>
