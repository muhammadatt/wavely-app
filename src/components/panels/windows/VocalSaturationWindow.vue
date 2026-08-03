<script setup>
import { onMounted } from 'vue'
import { useVocalSaturation } from '../../../composables/useVocalSaturation.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import DeviceSlider from '../../knobs/DeviceSlider.vue'
import LevelMeter from '../../meters/LevelMeter.vue'
import ApplyAction from '../../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  vsDrive, vsWetDry, vsBias, vsSoftness,
  vsLowCrossover, vsMidCrossover,
  vsLowDriveMult, vsMidDriveMult, vsHighDriveMult,
  vsPreview, vsInputDb, vsOutputDb, hasSelection,
  togglePreview,
  syncDrive, syncWetDry, syncBias, syncSoftness,
  syncLowCrossover, syncMidCrossover,
  syncLowDriveMult, syncMidDriveMult, syncHighDriveMult,
  apply, teardown, closeModal,
} = useVocalSaturation()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!vsPreview.value) togglePreview()
})

const ACCENT = '#ff8a5b'

const twoDp = v => v.toFixed(2)
const percent = v => `${Math.round(v * 100)}`
const hertz = v => `${Math.round(v)} Hz`
const multiplier = v => `${v.toFixed(2)}×`

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
</script>

<template>
  <FloatingWindow
    window-id="vocal-saturation"
    :z="z"
    :width="620"
    :accent="ACCENT"
    brand-lead="VOCAL"
    brand-tail="SAT"
    :engaged="vsPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-center justify-between gap-[20px]">
        <LevelMeter :db="vsInputDb" label="IN" :height="132" />

        <!-- The four you dial by ear get knobs. -->
        <div class="flex-1 flex items-start justify-center gap-[30px]">
          <div class="w-[104px]">
            <Knob :model-value="vsDrive" @update:model-value="syncDrive"
                  :min="0" :max="5" :step="0.05"
                  label="Drive" :accent="ACCENT" :format-value="twoDp"
                  :disabled="!vsPreview" />
          </div>
          <div class="w-[104px]">
            <Knob :model-value="vsWetDry" @update:model-value="syncWetDry"
                  :min="0" :max="1" :step="0.01"
                  label="Wet / Dry" :accent="ACCENT" :format-value="percent"
                  :disabled="!vsPreview" />
          </div>
          <div class="w-[104px]">
            <Knob :model-value="vsBias" @update:model-value="syncBias"
                  :min="0" :max="1.5" :step="0.01"
                  label="Bias" :accent="ACCENT" :format-value="twoDp"
                  :disabled="!vsPreview" />
          </div>
          <div class="w-[104px]">
            <Knob :model-value="vsSoftness" @update:model-value="syncSoftness"
                  :min="0" :max="1" :step="0.01"
                  label="Softness" :accent="ACCENT" :format-value="twoDp"
                  :disabled="!vsPreview" />
          </div>
        </div>

        <LevelMeter :db="vsOutputDb" label="OUT" :height="132" />
      </div>

      <!-- Band shaping: wide numeric ranges you read rather than feel, so
           faders beat knobs here. Laid out as a labelled sub-section the way a
           real faceplate separates its secondary controls. -->
      <div class="mt-[22px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div
          class="mb-[14px] uppercase"
          style="font:700 9px/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:rgba(255,255,255,.32)"
        >
          Band Shaping
        </div>

        <div class="grid grid-cols-2 gap-x-[30px] gap-y-[15px]">
          <DeviceSlider :model-value="vsLowCrossover" @update:model-value="syncLowCrossover"
                        :min="100" :max="2000" :step="10"
                        label="Low Crossover" :accent="ACCENT" :format-value="hertz"
                        :disabled="!vsPreview" />
          <DeviceSlider :model-value="vsMidCrossover" @update:model-value="syncMidCrossover"
                        :min="1000" :max="8000" :step="50"
                        label="Mid Crossover" :accent="ACCENT" :format-value="hertz"
                        :disabled="!vsPreview" />
          <DeviceSlider :model-value="vsLowDriveMult" @update:model-value="syncLowDriveMult"
                        :min="0" :max="10" :step="0.05"
                        label="Low Drive" :accent="ACCENT" :format-value="multiplier"
                        :disabled="!vsPreview" />
          <DeviceSlider :model-value="vsMidDriveMult" @update:model-value="syncMidDriveMult"
                        :min="0" :max="10" :step="0.05"
                        label="Mid Drive" :accent="ACCENT" :format-value="multiplier"
                        :disabled="!vsPreview" />
          <DeviceSlider :model-value="vsHighDriveMult" @update:model-value="syncHighDriveMult"
                        :min="0" :max="10" :step="0.05"
                        label="High Drive" :accent="ACCENT" :format-value="multiplier"
                        :disabled="!vsPreview" />
        </div>
      </div>

      <div class="mt-[20px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#2b1006"
          :met="hasSelection"
          message="Make a selection to saturate"
          label="Apply Saturation"
          :disabled="!vsPreview"
          disabled-hint="Turn Vocal Sat on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
