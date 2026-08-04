<script setup>
import { computed, onMounted } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import { PITCH_RANGES, effectivePitchRange } from '../../audio/resonanceParams.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import DeviceSlider from '../knobs/DeviceSlider.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  resDepth, resSharpness, resSelectivity, resAttack, resRelease,
  resMaxReduction, resFreqFloor, resFreqCeil, resMode, resPreserveHarmonics,
  resPitchRange, resPreview, resReduction, resInputDb, resOutputDb, hasSelection,
  togglePreview, syncDepth, syncSharpness, syncSelectivity, syncAttack,
  syncRelease, syncMaxReduction, syncFreqFloor, syncFreqCeil, syncMode,
  syncPitchRange, togglePreserveHarmonics, apply, teardown, closeModal,
} = useResonance()

const { state } = useEditorState()

onMounted(() => {
  if (!resPreview.value) togglePreview()
})

const ACCENT = '#8de0a8'

const MODE_OPTIONS = [
  { value: 'soft', label: 'SOFT', title: 'Gradual knee above the threshold' },
  { value: 'hard', label: 'HARD', title: 'Linear above the threshold' },
]

// Which pitches harmonic protection looks for. Nothing else about the effect
// assumes speech, and this should not either — see PITCH_RANGES.
const PITCH_RANGE_OPTIONS = Object.entries(PITCH_RANGES).map(([value, r]) => ({
  value,
  label: r.label,
  title: r.title,
}))

const percent = v => `${Math.round(v * 100)}`
const oneDp = v => v.toFixed(1)
const ms = v => `${Math.round(v)}`
const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)
const db = v => `${Math.round(v)}`

const modeCaption = computed(() =>
  resMode.value === 'soft' ? 'gradual knee' : 'linear above threshold',
)

// The kernel clamps the low end to what its analysis frame can resolve, so show
// what it will actually search rather than what the preset asked for.
const pitchRangeCaption = computed(() => {
  const sr = state.currentFile?.sampleRate ?? 44100
  const r = effectivePitchRange(sr, resPitchRange.value)
  return `${Math.round(r.minHz)}–${Math.round(r.maxHz)} Hz`
})

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
    window-id="resonance-suppressor"
    :z="z"
    :width="660"
    :accent="ACCENT"
    brand-lead="RESO"
    brand-tail="TAME"
    :engaged="resPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <GainReductionBar :reduction-db="resReduction" :accent="ACCENT" />

      <div class="flex items-center justify-between gap-[22px] mt-[22px]">
        <LevelMeter :db="resInputDb" label="IN" :height="150" />

        <div class="flex-1 flex justify-center gap-[34px]">
          <div class="w-[124px]">
            <Knob
              :model-value="resDepth" @update:model-value="syncDepth"
              :min="0" :max="1" :step="0.01"
              label="Depth" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[124px]">
            <Knob
              :model-value="resSelectivity" @update:model-value="syncSelectivity"
              :min="3" :max="24" :step="0.5"
              label="Selectivity" :accent="ACCENT" :format-value="oneDp"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[124px]">
            <Knob
              :model-value="resSharpness" @update:model-value="syncSharpness"
              :min="0" :max="1" :step="0.01"
              label="Sharpness" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
        </div>

        <LevelMeter :db="resOutputDb" label="OUT" :height="150" />
      </div>

      <!-- Timing + ceiling -->
      <div class="flex items-center justify-between mt-[18px] pt-[16px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <SegmentedSwitch
          :model-value="resMode"
          @update:model-value="syncMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!resPreview"
          :caption="modeCaption"
        />

        <div class="flex gap-[24px]">
          <div class="w-[74px]">
            <Knob
              :model-value="resAttack" @update:model-value="syncAttack"
              :min="1" :max="100" :step="1" :value-font-px="13"
              label="Attack ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[74px]">
            <Knob
              :model-value="resRelease" @update:model-value="syncRelease"
              :min="10" :max="500" :step="5" :value-font-px="13"
              label="Release ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[74px]">
            <Knob
              :model-value="resMaxReduction" @update:model-value="syncMaxReduction"
              :min="3" :max="48" :step="1" :value-font-px="13"
              label="Max Cut dB" :accent="ACCENT" :format-value="db"
              :disabled="!resPreview"
            />
          </div>
        </div>
      </div>

      <!-- Range + harmonic protection -->
      <div class="mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div class="flex items-start gap-[30px]">
          <div class="flex-1 grid grid-cols-2 gap-x-[26px] gap-y-[12px]">
            <DeviceSlider
              :model-value="resFreqFloor" @update:model-value="syncFreqFloor"
              :min="20" :max="1000" :step="10"
              label="Low Limit" :accent="ACCENT" :format-value="hz"
              :disabled="!resPreview"
            />
            <DeviceSlider
              :model-value="resFreqCeil" @update:model-value="syncFreqCeil"
              :min="2000" :max="20000" :step="100"
              label="High Limit" :accent="ACCENT" :format-value="hz"
              :disabled="!resPreview"
            />
          </div>

          <!-- Harmonic protection is the safety mechanism, not a flavour
               control: without it the cepstral reference sits at the
               inter-harmonic floor and the suppressor eats the harmonics of
               whatever is playing. The range picker sits with it because it
               feeds it — protection is only as good as the pitch it is handed,
               and a source outside the range reports an octave artefact rather
               than nothing, which puts the mask on the wrong bins. -->
          <div class="shrink-0 flex flex-col gap-[10px]" style="width:186px">
            <button
              class="w-full px-3 py-[9px] rounded-lg cursor-pointer transition-all text-left disabled:cursor-default"
              :style="{
                background: resPreserveHarmonics ? 'rgba(141,224,168,.14)' : 'rgba(255,178,122,.12)',
                border: `1px solid ${resPreserveHarmonics ? 'rgba(141,224,168,.4)' : 'rgba(255,178,122,.45)'}`,
                opacity: resPreview ? 1 : 0.4,
              }"
              :disabled="!resPreview"
              title="Protects the harmonics of the pitched source in the recording from being treated as resonances. Turning it off is a diagnostic aid — it will thin the material."
              @click="togglePreserveHarmonics"
            >
              <span
                class="block"
                :style="{
                  font: `700 8.5px 'JetBrains Mono',monospace`,
                  letterSpacing: '.12em',
                  color: resPreserveHarmonics ? '#8de0a8' : '#ffb27a',
                }"
              >{{ resPreserveHarmonics ? 'PRESERVE HARMONICS' : 'PROTECTION OFF' }}</span>
              <span
                class="block mt-[3px]"
                style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.35)"
              >{{ resPreserveHarmonics
                ? 'Preserves harmonic frequencies.'
                : 'Full suppression — risks thinning harmonic frequencies.' }}</span>
            </button>

            <SegmentedSwitch
              :model-value="resPitchRange"
              @update:model-value="syncPitchRange"
              :options="PITCH_RANGE_OPTIONS"
              :accent="ACCENT"
              :disabled="!resPreview || !resPreserveHarmonics"
              :caption="`Protect pitches ${pitchRangeCaption}`"
            />
          </div>
        </div>
      </div>

      <div class="mt-[16px]">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0c1f14"
          :met="hasSelection"
          message="Make a selection to tame resonances"
          label="Apply Resonance Suppression"
          :disabled="!resPreview"
          disabled-hint="Turn ResoTame on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
