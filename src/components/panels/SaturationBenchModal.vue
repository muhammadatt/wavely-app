<script setup>
/**
 * Saturation Bench: four layers of waveshaping in series, one strip each.
 *
 * Every strip is the same instrument — curve, drive, the band it works on,
 * emphasis around the curve, and whether it follows the vowels — so layers are
 * built by stacking rather than by switching modes. Drive reads in dB above a
 * matched point: 0 dB is 1 % THD on that band's measured level, for every
 * curve, which is what makes an A/B between curves a comparison of character.
 * DELTA plays only what the layers add.
 */
import { onMounted, watch } from 'vue'
import { useSaturationBench } from '../../composables/useSaturationBench.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import DeviceDetentRotary from '../knobs/DeviceDetentRotary.vue'
import DeviceTravelSlide from '../knobs/DeviceTravelSlide.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import { SHAPER_CURVES } from '../../audio/dsp/shaperCurves.js'
import {
  SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ,
} from '../../audio/saturationBenchProcessor.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  sbLayers, sbPreview, sbDelta, sbInputLevels, sbOutputLevels,
  togglePreview, toggleDelta, syncLayer, resetLayers, refreshSpectrum,
  apply, teardown, closeModal,
} = useSaturationBench()

const { state, appState } = useEditorState()

// An edit or a document switch changes the file, and with it every layer's
// calibration. Measured only while the window is engaged.
watch(() => [state.revision, appState.activeDocumentId], () => {
  if (sbPreview.value) refreshSpectrum()
})

onMounted(() => {
  if (!sbPreview.value) togglePreview()
})

const ACCENT = '#e89a6f'

const ON_OPTIONS = [
  { value: true, label: 'ON', title: 'This layer shapes the signal' },
  { value: false, label: 'OFF', title: 'This layer passes the signal through' },
]

const CURVE_OPTIONS = SHAPER_CURVES.map(c => ({ value: c.id, label: c.label, title: c.title }))

// An ordered axis — how much of the highs goes INTO the curve — so a slide.
const EMPH_OPTIONS = [
  { value: 'reverse', label: 'REV', title: 'Highs pulled out before the curve, put back after. Lifts the harmonics a voice makes up top — an exciter’s setting' },
  { value: 'off', label: 'OFF', title: 'No emphasis: the curve treats every frequency alike' },
  { value: 'opto', label: 'OPTO', title: 'OptoSmooth’s pair: highs pushed into the curve, taken back out after. The smoothest on voices — its after-shelf trims the harmonics' },
]

const MODE_OPTIONS = [
  { value: 'voiced', label: 'VOICED', title: 'Shape vowels only: the layer fades out as each S arrives and stays out of pauses' },
  { value: 'full', label: 'FULL', title: 'Shape everything, sibilants and room tone included' },
]

function formatDrive(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(0)}`
}

function formatHz(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`
}

function quantizeHz(v) {
  const step = v >= 1000 ? 100 : v >= 100 ? 10 : 1
  return Math.round(v / step) * step
}

function bandCaption(l) {
  const lowOpen = l.loHz <= SAT_BAND_MIN_HZ
  const highOpen = l.hiHz >= SAT_BAND_MAX_HZ
  if (lowOpen && highOpen) return 'FULL BAND'
  if (highOpen) return `ABOVE ${formatHz(l.loHz)}`
  if (lowOpen) return `BELOW ${formatHz(l.hiHz)}`
  return `${formatHz(l.loHz)}–${formatHz(l.hiHz)}`
}

function curveTitle(id) {
  return SHAPER_CURVES.find(c => c.id === id)?.title ?? ''
}

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
}

const LABEL = "font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)"
const CAPTION = "font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)"
</script>

<template>
  <FloatingWindow
    window-id="saturation-bench"
    :z="z"
    :width="1000"
    :accent="ACCENT"
    brand-lead="SATURATION"
    brand-tail="BENCH"
    :engaged="sbPreview"
    show-delta
    :delta="sbDelta"
    :delta-disabled="!sbPreview"
    delta-title="Hear only what the layers add"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!sbPreview"
    apply-disabled-hint="Turn Saturation Bench on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[22px] pt-[16px] pb-[18px] flex gap-[18px]">
      <LevelMeter :levels="sbInputLevels" label="IN" :height="520" />

      <div class="flex-1 flex flex-col gap-[6px]">
        <div
          v-for="(layer, k) in sbLayers" :key="k"
          class="flex items-center justify-between gap-[10px] px-[10px] py-[4px] rounded-[10px]"
          :style="{
            background: 'rgba(255,255,255,.025)',
            border: '1px solid rgba(255,255,255,.05)',
            opacity: layer.on ? 1 : 0.55,
          }"
        >
          <div class="w-[78px] flex flex-col items-center gap-[8px]">
            <span :style="LABEL">LAYER {{ k + 1 }}</span>
            <DeviceChoiceRocker
              :model-value="layer.on" :options="ON_OPTIONS" :accent="ACCENT"
              :disabled="!sbPreview" :label="`Layer ${k + 1}`"
              @update:model-value="v => syncLayer(k, 'on', v)"
            />
          </div>

          <div class="w-[112px] flex flex-col items-center gap-[4px]" :title="curveTitle(layer.curve)">
            <span :style="LABEL">CURVE</span>
            <DeviceDetentRotary
              :model-value="layer.curve" :options="CURVE_OPTIONS" :accent="ACCENT"
              :disabled="!sbPreview || !layer.on" :label="`Layer ${k + 1} curve`" :show-label="false"
              @update:model-value="v => syncLayer(k, 'curve', v)"
            />
          </div>

          <div class="w-[100px] flex flex-col items-center">
            <Knob
              :model-value="layer.driveDb"
              @update:model-value="v => syncLayer(k, 'driveDb', v)"
              :min="SAT_DRIVE_MIN_DB" :max="SAT_DRIVE_MAX_DB" :step="0.5"
              label="Drive" :accent="ACCENT" :format-value="formatDrive"
              :disabled="!sbPreview || !layer.on"
              title="dB above the matched point: 0 dB puts every curve at 1 % distortion on this band's measured level, so switching curves compares character, not strength. A high band wants +12 to +20 dB to be heard."
            />
            <span :style="CAPTION">dB · MATCHED</span>
          </div>

          <div class="w-[100px] flex flex-col items-center">
            <Knob
              :model-value="layer.loHz"
              @update:model-value="v => syncLayer(k, 'loHz', v)"
              :min="SAT_BAND_MIN_HZ" :max="SAT_BAND_MAX_HZ" scale="log" :quantize="quantizeHz"
              label="Low" :accent="ACCENT" :format-value="formatHz" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Bottom of the band this layer saturates. Fully down is open — no high-pass."
            />
            <span :style="CAPTION">{{ bandCaption(layer) }}</span>
          </div>

          <div class="w-[100px] flex flex-col items-center">
            <Knob
              :model-value="layer.hiHz"
              @update:model-value="v => syncLayer(k, 'hiHz', v)"
              :min="SAT_BAND_MIN_HZ" :max="SAT_BAND_MAX_HZ" scale="log" :quantize="quantizeHz"
              label="High" :accent="ACCENT" :format-value="formatHz" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Top of the band this layer saturates. Fully up is open — no low-pass. What the curve adds is band-passed again, so nothing it makes leaves the band."
            />
            <span :style="CAPTION">&nbsp;</span>
          </div>

          <div class="flex flex-col items-center gap-[8px]">
            <span :style="LABEL">EMPH</span>
            <DeviceTravelSlide
              :model-value="layer.emph" :options="EMPH_OPTIONS" :accent="ACCENT" :width="132"
              :disabled="!sbPreview || !layer.on" :label="`Layer ${k + 1} emphasis`"
              @update:model-value="v => syncLayer(k, 'emph', v)"
            />
          </div>

          <div class="flex flex-col items-center gap-[8px]">
            <span :style="LABEL">MODE</span>
            <DeviceChoiceRocker
              :model-value="layer.mode" :options="MODE_OPTIONS" :accent="ACCENT"
              :disabled="!sbPreview || !layer.on" :label="`Layer ${k + 1} mode`"
              @update:model-value="v => syncLayer(k, 'mode', v)"
            />
          </div>
        </div>

        <div class="flex justify-between items-center mt-[4px]" :style="CAPTION">
          <span>LAYERS RUN TOP TO BOTTOM · 4.5 ms LATENCY, COMPENSATED ON APPLY</span>
          <button
            type="button" class="sb-reset" :disabled="!sbPreview"
            title="Back to the two factory layers: Warmth (Quartic, OPTO, full band) and Exciter (Tanh, REV, 3 kHz up, voiced)"
            @click="resetLayers"
          >
            RESET LAYERS
          </button>
        </div>
      </div>

      <LevelMeter :levels="sbOutputLevels" label="OUT" :height="520" />
    </div>
  </FloatingWindow>
</template>

<style scoped>
.sb-reset {
  height: 26px;
  padding: 0 12px;
  border-radius: 9999px;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.45);
  font: inherit;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sb-reset:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}
.sb-reset:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
