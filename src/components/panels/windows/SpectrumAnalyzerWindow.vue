<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import {
  useSpectrumAnalyzer, FFT_OPTIONS, SLOPE_OPTIONS,
} from '../../../composables/useSpectrumAnalyzer.js'
import FloatingWindow from '../FloatingWindow.vue'
import SegmentedSwitch from '../../knobs/SegmentedSwitch.vue'
import DeviceSlider from '../../knobs/DeviceSlider.vue'
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

// Cyan: unclaimed by any effect, and the colour an analyzer is expected to be.
const ACCENT = '#5bc8ff'

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
    brand-lead="SPECTRUM"
    brand-tail="ANALYZER"
    :show-engage="false"
    @close="close"
  >
    <template #header-center>
      <!-- Freeze belongs in the header rather than with the settings below: it
           is the one control you reach for while looking at the plot, usually
           the instant something interesting goes past. -->
      <button
        class="px-3 py-1.5 rounded-full border cursor-pointer transition-colors"
        :style="{
          background: frozen ? `color-mix(in srgb, ${ACCENT} 26%, transparent)` : 'transparent',
          borderColor: frozen
            ? `color-mix(in srgb, ${ACCENT} 55%, transparent)`
            : 'rgba(255,255,255,.14)',
          font: `700 9px 'JetBrains Mono',monospace`,
          letterSpacing: '.16em',
          color: frozen ? `color-mix(in srgb, ${ACCENT} 60%, #ffffff)` : 'rgba(255,255,255,.45)',
        }"
        :aria-pressed="String(frozen)"
        title="Hold the display where it is, to read a moment that has gone past"
        @pointerdown.stop
        @click="frozen = !frozen"
      >FREEZE</button>
    </template>

    <div class="px-[22px] pt-[18px] pb-[20px]">
      <SpectrumDisplay
        ref="display"
        :frame-fn="frameFn"
        :slope="slope"
        :floor-db="floorDb"
        :show-peak-hold="showPeakHold"
        :frozen="frozen"
        :accent="ACCENT"
        :height="270"
      />

      <div class="mt-[16px] pt-[14px] flex items-end gap-[20px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <SegmentedSwitch
          class="shrink-0"
          v-model="fftSize"
          :options="FFT_OPTIONS"
          :accent="ACCENT"
          caption="Resolution"
          :padding-x="11"
        />
        <SegmentedSwitch
          class="shrink-0"
          v-model="slope"
          :options="SLOPE_OPTIONS"
          :accent="ACCENT"
          caption="Tilt dB/oct"
          :padding-x="11"
        />

        <!-- Peak hold reads as a lamp rather than a switch bank: it is on or
             off, and clicking it while it is already on restarts the hold,
             which is the other thing anyone wants from it. -->
        <button
          class="shrink-0 px-[13px] py-[7px] rounded-full cursor-pointer transition-colors"
          :style="{
            background: showPeakHold ? `color-mix(in srgb, ${ACCENT} 18%, transparent)` : 'transparent',
            border: `1px solid ${showPeakHold ? `color-mix(in srgb, ${ACCENT} 45%, transparent)` : 'rgba(255,255,255,.1)'}`,
            font: `700 9px 'JetBrains Mono',monospace`,
            letterSpacing: '.12em',
            color: showPeakHold ? `color-mix(in srgb, ${ACCENT} 65%, #ffffff)` : 'rgba(255,255,255,.4)',
          }"
          :aria-pressed="String(showPeakHold)"
          title="Outline showing where the trace has peaked. Click again to clear it."
          @click="togglePeakHold"
        >PEAK HOLD</button>
      </div>

      <div class="mt-[15px] grid grid-cols-2 gap-x-[30px]">
        <DeviceSlider
          v-model="smoothing"
          :min="0" :max="0.95" :step="0.01"
          label="Averaging" :accent="ACCENT" :format-value="percent"
        />
        <DeviceSlider
          v-model="floorDb"
          :min="-140" :max="-40" :step="5"
          label="Floor" :accent="ACCENT" :format-value="decibels"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
