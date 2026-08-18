<script setup>
import { computed, onMounted } from 'vue'
import { useSoftClipper } from '../../composables/useSoftClipper.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  headroomDb, emphasisDb, outputTrimDb, thresholdMode, fixedThresholdDb,
  clipperPreview, clipperReduction, clipperInputLevels, clipperOutputLevels, hasSelection,
  togglePreview, syncHeadroom, syncEmphasis, syncOutputTrim, syncFixedThreshold,
  setThresholdMode, apply, teardown, closeModal,
} = useSoftClipper()

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!clipperPreview.value) togglePreview()
})

// A colour of its own, distinct from the two compressors it typically
// precedes (OptoSmooth's amber, FET Punch's steel blue) — this is a
// transient-taming stage, not a compressor, and the panel should read
// differently at a glance.
const ACCENT = '#ff8f6b'

const MODE_OPTIONS = [
  { value: 'adaptive', label: 'ADAPTIVE', title: "Threshold rides the speaker's own level" },
  { value: 'fixed', label: 'FIXED', title: 'Threshold is a stated dBFS ceiling' },
]

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

function formatGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function formatDb(v) {
  return v.toFixed(1)
}

const isFixed = computed(() => thresholdMode.value === 'fixed')

// Reads as "how hard you are pushing it" per spec §7.1: 3-6 dB is the usable
// range on speech, past that it starts reading as grit rather than control.
// 12 dB full scale (rather than the compressors' 24) keeps that band visually
// legible instead of crammed into the first quarter of the bar.
const METER_FULL_SCALE_DB = 12
</script>

<template>
  <FloatingWindow
    window-id="soft-clipper"
    :z="z"
    :width="620"
    :top="130"
    :accent="ACCENT"
    brand-lead="SOFT"
    brand-tail="CLIPPER"
    background="linear-gradient(155deg,#1a1613,#0d0a08 60%)"
    header-background="linear-gradient(#241d18,#15100d)"
    :engaged="clipperPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <template #header-center>
      <span style="font:600 9.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.32)">
        TRANSIENT PEAK CONTROL
      </span>
    </template>

    <div class="px-[26px] pt-[20px] pb-[26px]">
      <!-- Peak reduction: what the stage is actually doing, in the same
           instrument the compressors use, with the 3-6 dB usable range
           shaded so a user can find their Headroom setting by eye rather
           than by ear alone (spec §7.2). -->
      <GainReductionBar
        :reduction-db="clipperReduction"
        :accent="ACCENT"
        title="PEAK REDUCTION"
        :full-scale-db="METER_FULL_SCALE_DB"
        :zone-min-db="3"
        :zone-max-db="6"
      />

      <div class="flex items-center justify-between gap-[14px] mt-[24px]">
        <LevelMeter :levels="clipperInputLevels" label="IN" :height="132" />

        <div class="flex-1 flex justify-center gap-[32px]">
          <div class="w-[100px]">
            <!-- Primary control. Lower = the threshold sits closer to the
                 speaker's own level, so more of every transient crosses it. -->
            <Knob
              :model-value="headroomDb"
              @update:model-value="syncHeadroom"
              :min="4" :max="16" :step="0.5"
              label="Headroom" :accent="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview"
            />
          </div>
          <div class="w-[100px]">
            <!-- Harshness-reduction mechanism, not a tone control: it shaves
                 HF first (where clipping's odd harmonics land) and pulls the
                 generated harmonics back down with it. -->
            <Knob
              :model-value="emphasisDb"
              @update:model-value="syncEmphasis"
              :min="0" :max="12" :step="0.5"
              label="HF Emphasis" :accent="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview"
            />
          </div>
          <div class="w-[100px]">
            <Knob
              :model-value="outputTrimDb"
              @update:model-value="syncOutputTrim"
              :min="-6" :max="6" :step="0.1"
              label="Output Trim" :accent="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview"
            />
          </div>
        </div>

        <LevelMeter :levels="clipperOutputLevels" label="OUT" :height="132" />
      </div>

      <!-- Threshold mode: adaptive (rides the speaker's level) or a stated
           dBFS ceiling for users who need one. -->
      <div class="flex items-center justify-between gap-[20px] mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div class="flex items-center gap-[10px]">
          <span class="w-[62px]" style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.4)">THRESHOLD</span>
          <SegmentedSwitch
            :model-value="thresholdMode"
            @update:model-value="setThresholdMode"
            :options="MODE_OPTIONS"
            :accent="ACCENT"
            :disabled="!clipperPreview"
            :padding-x="12"
          />
        </div>

        <div class="w-[100px]" :style="{ opacity: isFixed ? 1 : 0.35 }">
          <Knob
            :model-value="fixedThresholdDb"
            @update:model-value="syncFixedThreshold"
            :min="-24" :max="-1" :step="0.5"
            label="Fixed dBFS" :accent="ACCENT" :format-value="formatDb"
            :disabled="!clipperPreview || !isFixed"
          />
        </div>
      </div>

      <div class="mt-4">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0c1218"
          :met="hasSelection"
          message="Make a selection to process"
          label="Apply soft clipper"
          :disabled="!clipperPreview"
          disabled-hint="Turn Soft Clipper on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
