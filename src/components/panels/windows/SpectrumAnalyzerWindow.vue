<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import {
  useSpectrumAnalyzer, FFT_OPTIONS, SLOPE_OPTIONS, SMOOTHING_DEFAULT, FLOOR_DEFAULT_DB,
} from '../../../composables/useSpectrumAnalyzer.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaSegmented from '../../modula/ModulaSegmented.vue'
import ModulaLedPill from '../../modula/ModulaLedPill.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import SpectrumDisplay from '../../meters/SpectrumDisplay.vue'

/**
 * The spectrum analyzer window.
 *
 * The one plugin window with no ON/BYPASS pill and no Apply bar, because it is
 * an instrument rather than an effect: it reads the master output and changes
 * nothing. Wearing the same faceplate as the effects is deliberate — it opens
 * from the same list, docks in the same stack and is dragged the same way, so
 * the only thing that distinguishes it is the absence of the controls that
 * would have altered the file.
 */
defineProps({ z: { type: Number, default: 500 } })

const {
  fftSize, smoothing, slope, floorDb, showPeakHold, frozen,
  start, detach, close, frameFn,
} = useSpectrumAnalyzer()

// The kit's second hue (--m-second), as a literal because the plot tints it on
// a canvas: cyan is the colour an analyzer is expected to be, and in the kit it
// already means "where", which is what a spectrum shows.
const ACCENT = '#3fd0de'

const display = ref(null)

onMounted(start)
onUnmounted(detach)

const percent = v => `${Math.round(v * 100)}%`
const decibels = v => `${Math.round(v)} dB`


function togglePeakHold() {
  showPeakHold.value = !showPeakHold.value
  if (showPeakHold.value) display.value?.resetPeaks()
}
</script>

<template>
  <FloatingWindow
    window-id="spectrum-analyzer"
    :z="z"
    :width="700"
    :accent="ACCENT"
    design="modula"
    brand-lead="SPECTRUM ANALYZER"
    :show-engage="false"
    @close="close"
  >
    <template #header-center>
      <!-- Freeze and peak hold belong in the header rather than with the
           settings below: they are what you reach for while looking at the
           plot, usually the instant something interesting goes past. -->
      <ModulaLedPill
        size="sm" label="FREEZE" color="var(--m-second)"
        :model-value="frozen"
        title="Hold the display where it is, to read a moment that has gone past"
        @pointerdown.stop
        @update:model-value="frozen = $event"
      />
      <!-- Turning it on starts a fresh hold. -->
      <ModulaLedPill
        size="sm" label="PEAK HOLD" color="var(--m-second)"
        :model-value="showPeakHold"
        title="Outline showing where the trace has peaked. Turning it on starts a fresh hold."
        @pointerdown.stop
        @update:model-value="togglePeakHold"
      />
    </template>

    <SpectrumDisplay
      ref="display"
      design="modula"
      :frame-fn="frameFn"
      :slope="slope"
      :floor-db="floorDb"
      :show-peak-hold="showPeakHold"
      :frozen="frozen"
      :accent="ACCENT"
      :height="270"
    />

    <!-- The settings, on one panel: the two switches say which spectrum you
         are looking at, the two knobs how it settles and how deep it reads. -->
    <div class="sa-panel">
      <div class="sa-group">
        <span class="m-caption">Resolution</span>
        <ModulaSegmented v-model="fftSize" :options="FFT_OPTIONS" aria-label="FFT size" />
      </div>
      <div class="sa-group">
        <span class="m-caption">Tilt <span class="sa-unit">dB/oct</span></span>
        <ModulaSegmented v-model="slope" :options="SLOPE_OPTIONS" aria-label="Tilt" />
      </div>

      <span class="sa-rule" aria-hidden="true"></span>

      <div class="sa-knobs">
      <ModulaKnob
        variant="small" :size="44" show-value editable
        v-model="smoothing" :min="0" :max="0.95" :step="0.01" :default-value="SMOOTHING_DEFAULT"
        label="Averaging" :color="ACCENT" :format-value="percent"
        :parse-value="t => parseFloat(t) / 100"
        title="How much each frame is averaged with the last: higher is steadier, lower follows faster. Double-click to reset"
      />
      <ModulaKnob
        variant="small" :size="44" show-value editable
        v-model="floorDb" :min="-140" :max="-40" :step="5" :default-value="FLOOR_DEFAULT_DB"
        label="Floor" :color="ACCENT" :format-value="decibels"
        title="The bottom of the plot's dB range. The top is 0 dBFS. Double-click to reset"
      />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.sa-panel {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 18px;
  border-radius: 14px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.sa-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.sa-unit { text-transform: none; letter-spacing: .06em; }
.sa-knobs { display: flex; gap: 20px; }
.sa-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
</style>
