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
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import { SHAPER_CURVES } from '../../audio/dsp/shaperCurves.js'
import {
  SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ, SAT_BAND_HIGH_MIN_HZ,
  SAT_EMPH_HZ_MIN, SAT_EMPH_HZ_MAX, SAT_EMPH_Q_MIN, SAT_EMPH_Q_MAX, SAT_EMPH_DB_MAX, SAT_EMPH_QUICK,
} from '../../audio/saturationBenchProcessor.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  sbLayers, sbPreview, sbDelta, sbInputLevels, sbOutputLevels,
  togglePreview, toggleDelta, syncLayer, syncLayerFields, resetLayers, refreshSpectrum,
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

// Three KINDS of filter, not a progression — a detent rotary, like the curves.
const EMPH_TYPE_OPTIONS = [
  { value: 'hishelf', label: 'HI SHELF', title: 'Everything above the corner goes into the curve harder (or softer, at negative gain). OPTO and REV are this shape' },
  { value: 'bell', label: 'BELL', title: 'One region around the frequency — a formant or the sibilant band — goes into the curve harder or softer' },
  { value: 'loshelf', label: 'LO SHELF', title: 'Everything below the corner goes into the curve harder (or softer, at negative gain)' },
]

// One-click settings that fill the three knobs. OFF only zeroes the gain, so
// the shape you dialled survives a toggle.
const EMPH_QUICK = [
  { id: 'reverse', label: 'REV', title: 'Highs pulled out before the curve, put back after: 2300 Hz high shelf at −20.4 dB. Lifts the harmonics a voice makes up top — an exciter’s setting' },
  { id: 'off', label: 'OFF', title: 'No emphasis: the curve treats every frequency alike. Keeps the frequency, Q and shape' },
  { id: 'opto', label: 'OPTO', title: 'OptoSmooth’s pair: 2300 Hz high shelf at +20.4 dB, highs pushed into the curve and taken back out after. The smoothest on voices' },
]

function quickActive(l, id) {
  if (id === 'off') return l.emphDb === 0
  const q = SAT_EMPH_QUICK[id]
  return l.emphType === q.emphType && l.emphHz === q.emphHz && l.emphQ === q.emphQ && l.emphDb === q.emphDb
}

function formatEmphDb(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function formatQ(v) {
  return v.toFixed(2)
}

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
    :width="1320"
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
              title="Bottom of the band this layer saturates. Fully down (1 Hz) is open — no high-pass; the next step is a 2 Hz corner, so leaving open is gentle. The value is the real corner."
            />
            <span :style="CAPTION">{{ bandCaption(layer) }}</span>
          </div>

          <div class="w-[100px] flex flex-col items-center">
            <Knob
              :model-value="layer.hiHz"
              @update:model-value="v => syncLayer(k, 'hiHz', v)"
              :min="SAT_BAND_HIGH_MIN_HZ" :max="SAT_BAND_MAX_HZ" scale="log" :quantize="quantizeHz"
              label="High" :accent="ACCENT" :format-value="formatHz" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Top of the band this layer saturates. Fully up is open — no low-pass. What the curve adds is band-passed again, so nothing it makes leaves the band."
            />
            <span :style="CAPTION">&nbsp;</span>
          </div>

          <div class="w-[96px] flex flex-col items-center gap-[6px]">
            <span :style="LABEL">EMPH</span>
            <DeviceDetentRotary
              :model-value="layer.emphType" :options="EMPH_TYPE_OPTIONS" :accent="ACCENT"
              :disabled="!sbPreview || !layer.on" :label="`Layer ${k + 1} emphasis shape`" :show-label="false"
              @update:model-value="v => syncLayer(k, 'emphType', v)"
            />
            <div class="flex gap-[3px]">
              <button
                v-for="q in EMPH_QUICK" :key="q.id" type="button" class="sb-quick"
                :class="{ 'sb-quick-on': quickActive(layer, q.id) }"
                :disabled="!sbPreview || !layer.on" :title="q.title"
                @click="syncLayerFields(k, SAT_EMPH_QUICK[q.id])"
              >
                {{ q.label }}
              </button>
            </div>
          </div>

          <div class="w-[88px] flex flex-col items-center">
            <Knob
              :model-value="layer.emphHz"
              @update:model-value="v => syncLayer(k, 'emphHz', v)"
              :min="SAT_EMPH_HZ_MIN" :max="SAT_EMPH_HZ_MAX" scale="log" :quantize="quantizeHz"
              label="Freq" :accent="ACCENT" :format-value="formatHz" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Corner of the shelf, or centre of the bell, that the curve sees emphasised."
            />
            <span :style="CAPTION">EMPH · HZ</span>
          </div>

          <div class="w-[88px] flex flex-col items-center">
            <Knob
              :model-value="layer.emphQ"
              @update:model-value="v => syncLayer(k, 'emphQ', v)"
              :min="SAT_EMPH_Q_MIN" :max="SAT_EMPH_Q_MAX" :step="0.05" scale="log"
              label="Q" :accent="ACCENT" :format-value="formatQ" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Width of the bell, or the steepness of the shelf's bend (0.71 is the plain, flat shelf)."
            />
            <span :style="CAPTION">&nbsp;</span>
          </div>

          <div class="w-[88px] flex flex-col items-center">
            <Knob
              :model-value="layer.emphDb"
              @update:model-value="v => syncLayer(k, 'emphDb', v)"
              :min="-SAT_EMPH_DB_MAX" :max="SAT_EMPH_DB_MAX" :step="0.5" bipolar
              label="Gain" :accent="ACCENT" :format-value="formatEmphDb" :value-font-px="16"
              :disabled="!sbPreview || !layer.on"
              title="Positive pushes this region into the curve harder (OPTO), negative pulls it out (REV), 0 is off. The same filter at the opposite gain undoes it after the curve, so nothing outside what the curve adds changes. On a high band it acts mostly as a drive offset."
            />
            <span :style="CAPTION">dB · INTO CURVE</span>
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
.sb-quick {
  height: 20px;
  padding: 0 7px;
  border-radius: 9999px;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.45);
  font: 600 8.5px 'JetBrains Mono', monospace;
  letter-spacing: 0.06em;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.sb-quick:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}
.sb-quick-on {
  border-color: #e89a6f;
  color: #e89a6f;
}
.sb-quick:disabled {
  opacity: 0.4;
  cursor: default;
}
.sb-reset:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
