<script setup>
import { computed, ref } from 'vue'
import EqPlot from './EqPlot.vue'
import { FILTER_TYPES, PARAM_RANGES, qRangeFor } from '../../../audio/eqBands.js'

/**
 * General mode — a conventional parametric EQ.
 *
 * This is the mode that has to work on a lecture recording, a field recording
 * or a music bed: material for which no voice reference exists and none could.
 * No analysis, no roles, no suggestions.
 *
 * Every parameter takes direct numeric entry. Non-professionals rarely use it;
 * professionals look for it immediately, and its absence reads as a toy.
 */

const props = defineProps({
  eq: { type: Object, required: true },
  accent: { type: String, required: true },
  sampleRate: { type: Number, default: 44100 },
})

const selectedId = ref(null)

const selected = computed(() =>
  props.eq.bands.value.find(b => b.id === selectedId.value) ?? null)

const qRange = computed(() => qRangeFor(selected.value?.type ?? 'peaking'))

/**
 * Below 100 Hz or above 12 kHz, offer a filter rather than a bell — but only
 * offer. Someone cutting a room mode at 60 Hz wants a bell, and imposing a
 * highpass there would be the tool overruling a decision it cannot see.
 */
function suggestedType(hz) {
  if (hz < 100) return 'highpass'
  if (hz > 12000) return 'lowpass'
  return null
}

const typeHint = computed(() => {
  const b = selected.value
  if (!b || b.type !== 'peaking') return null
  const t = suggestedType(b.frequencyHz)
  return t ? { type: t, label: t === 'highpass' ? 'High-pass' : 'Low-pass' } : null
})

function onCreate({ frequencyHz, gainDb }) {
  const band = props.eq.addBand({
    frequencyHz, gainDb, q: 1, type: 'peaking', origin: 'manual_general',
  })
  if (band) selectedId.value = band.id
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

function onRemove(id) {
  if (selectedId.value === id) selectedId.value = null
  props.eq.removeBand(id)
}

function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`
}
</script>

<template>
  <div>
    <EqPlot
      :bands="eq.bands.value"
      :sample-rate="sampleRate"
      :accent="accent"
      :selected-id="selectedId"
      :show-analyzer="eq.showAnalyzer.value"
      :spectrum-fn="eq.getSpectrum"
      @create-band="onCreate"
      @select-band="selectedId = $event"
      @move-band="onMove"
      @q-band="onQ"
      @remove-band="onRemove"
      @toggle-band="eq.toggleBand"
    />

    <div class="flex items-center justify-between mt-[10px]">
      <p style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.3)">
        Click the curve to add a band · drag to move · scroll for width ·
        double-click to remove
      </p>
      <label
        class="flex items-center gap-[6px] cursor-pointer shrink-0"
        style="font:600 9px/1 'Inter';letter-spacing:.06em;color:rgba(255,255,255,.4)"
      >
        <input
          type="checkbox"
          :checked="eq.showAnalyzer.value"
          class="accent-current w-[11px] h-[11px]"
          @change="eq.showAnalyzer.value = $event.target.checked"
        >
        ANALYZER
      </label>
    </div>

    <!-- Selected band editor -->
    <div
      v-if="selected"
      class="mt-[12px] pt-[12px] grid grid-cols-[1fr_auto_auto_auto_auto] gap-[10px] items-end"
      style="border-top:1px solid rgba(255,255,255,.06)"
    >
      <label class="flex flex-col gap-[3px]">
        <span style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.35)">TYPE</span>
        <select
          :value="selected.type"
          class="bg-black/30 rounded-[3px] px-[6px] py-[4px] outline-none"
          style="font:500 11px/1 'Inter';color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.1)"
          @change="eq.setType(selected.id, $event.target.value)"
        >
          <option v-for="t in FILTER_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </label>

      <label class="flex flex-col gap-[3px]">
        <span style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.35)">FREQ</span>
        <input
          type="number" :value="Math.round(selected.frequencyHz)"
          :min="PARAM_RANGES.frequencyHz[0]" :max="PARAM_RANGES.frequencyHz[1]"
          class="w-[72px] bg-black/30 rounded-[3px] px-[6px] py-[4px] outline-none text-right"
          style="font:500 11px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.1)"
          @change="eq.setFrequency(selected.id, Number($event.target.value))"
        >
      </label>

      <label class="flex flex-col gap-[3px]">
        <span style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.35)">GAIN</span>
        <input
          type="number" step="0.1" :value="selected.gainDb.toFixed(1)"
          :min="PARAM_RANGES.gainDb[0]" :max="PARAM_RANGES.gainDb[1]"
          class="w-[62px] bg-black/30 rounded-[3px] px-[6px] py-[4px] outline-none text-right"
          style="font:500 11px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.1)"
          @change="eq.setGain(selected.id, Number($event.target.value))"
        >
      </label>

      <label class="flex flex-col gap-[3px]">
        <span style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.35)">Q</span>
        <input
          type="number" step="0.1" :value="selected.q.toFixed(2)"
          :min="qRange[0]" :max="qRange[1]"
          class="w-[62px] bg-black/30 rounded-[3px] px-[6px] py-[4px] outline-none text-right"
          style="font:500 11px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.1)"
          @change="eq.setQ(selected.id, Number($event.target.value))"
        >
      </label>

      <div class="flex gap-[5px] pb-[1px]">
        <button
          type="button"
          class="px-[8px] py-[5px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.6)"
          :style="{ opacity: selected.enabled ? 1 : 0.5 }"
          @click="eq.toggleBand(selected.id)"
        >{{ selected.enabled ? 'ON' : 'OFF' }}</button>
        <button
          type="button"
          class="px-[8px] py-[5px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.6)"
          :style="{
            background: eq.soloBandId.value === selected.id
              ? 'color-mix(in srgb, ' + accent + ' 30%, transparent)' : 'transparent',
          }"
          @click="eq.soloBandId.value === selected.id ? eq.clearSolo() : eq.setSolo(selected.id)"
        >SOLO</button>
        <button
          type="button"
          class="px-[8px] py-[5px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.45)"
          @click="onRemove(selected.id)"
        >DEL</button>
      </div>
    </div>

    <p
      v-if="typeHint"
      class="mt-[8px]"
      style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.38)"
    >
      This band sits at {{ fmtHz(selected.frequencyHz) }} —
      <button
        type="button"
        class="underline underline-offset-2"
        :style="{ color: accent }"
        @click="eq.setType(selected.id, typeHint.type)"
      >make it a {{ typeHint.label.toLowerCase() }} filter?</button>
    </p>

    <p
      v-if="eq.bands.value.length === 0"
      class="mt-[12px] text-center"
      style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.3)"
    >
      No bands yet. Click anywhere on the curve to add one.
    </p>

    <p
      v-if="eq.atBandLimit.value"
      class="mt-[8px]"
      style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.65)"
    >
      Band limit reached — remove one to add another.
    </p>
  </div>
</template>
