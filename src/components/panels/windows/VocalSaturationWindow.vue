<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { computePeakCache } from '../../../audio/processing.js'
import { applyVocalSaturation } from '../../../api/spotEffects.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import DeviceSlider from '../../knobs/DeviceSlider.vue'
import ApplyAction from '../../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast,
} = useEditorState()

const ACCENT = '#ff8a5b'

// Defaults match the server-side script defaults.
const drive         = ref(2.0)
const wetDry        = ref(0.3)
const bias          = ref(0.5)
const softness      = ref(0.3)
const lowCrossover  = ref(500)
const midCrossover  = ref(3500)
const lowDriveMult  = ref(5.0)
const midDriveMult  = ref(0.1)
const highDriveMult = ref(0.1)

const twoDp = v => v.toFixed(2)
const percent = v => `${Math.round(v * 100)}`
const hertz = v => `${Math.round(v)} Hz`
const multiplier = v => `${v.toFixed(2)}×`

async function applySaturation() {
  if (!state.selection) return
  const { start, end } = state.selection

  startProcessing('Saturating...')
  try {
    const blob = await applyVocalSaturation({
      segments:   state.segments,
      start, end,
      sampleRate: state.currentFile.sampleRate,
      channels:   state.currentFile.channels,
      params: {
        drive:         drive.value,
        wetDry:        wetDry.value,
        bias:          bias.value,
        lowCrossover:  lowCrossover.value,
        midCrossover:  midCrossover.value,
        softness:      softness.value,
        lowDriveMult:  lowDriveMult.value,
        midDriveMult:  midDriveMult.value,
        highDriveMult: highDriveMult.value,
      },
    })

    const ctx = getAudioContext()
    const arrayBuffer = await blob.arrayBuffer()
    const buffer = await ctx.decodeAudioData(arrayBuffer)
    const bufferId = replaceRegion(start, end, buffer)

    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Vocal saturation applied')
  } catch (err) {
    console.error('Vocal saturation failed:', err)
    showToast('Vocal saturation failed')
  } finally {
    endProcessing()
  }
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
    :show-engage="false"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <!-- The four you dial by ear get knobs. -->
      <div class="flex items-start justify-center gap-[34px]">
        <div class="w-[112px]">
          <Knob v-model="drive" :min="0" :max="5" :step="0.05"
                label="Drive" :accent="ACCENT" :format-value="twoDp" />
        </div>
        <div class="w-[112px]">
          <Knob v-model="wetDry" :min="0" :max="1" :step="0.01"
                label="Wet / Dry" :accent="ACCENT" :format-value="percent" />
        </div>
        <div class="w-[112px]">
          <Knob v-model="bias" :min="0" :max="1.5" :step="0.01"
                label="Bias" :accent="ACCENT" :format-value="twoDp" />
        </div>
        <div class="w-[112px]">
          <Knob v-model="softness" :min="0" :max="1" :step="0.01"
                label="Softness" :accent="ACCENT" :format-value="twoDp" />
        </div>
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
          <DeviceSlider v-model="lowCrossover" :min="100" :max="2000" :step="10"
                        label="Low Crossover" :accent="ACCENT" :format-value="hertz" />
          <DeviceSlider v-model="midCrossover" :min="1000" :max="8000" :step="50"
                        label="Mid Crossover" :accent="ACCENT" :format-value="hertz" />
          <DeviceSlider v-model="lowDriveMult" :min="0" :max="10" :step="0.05"
                        label="Low Drive" :accent="ACCENT" :format-value="multiplier" />
          <DeviceSlider v-model="midDriveMult" :min="0" :max="10" :step="0.05"
                        label="Mid Drive" :accent="ACCENT" :format-value="multiplier" />
          <DeviceSlider v-model="highDriveMult" :min="0" :max="10" :step="0.05"
                        label="High Drive" :accent="ACCENT" :format-value="multiplier" />
        </div>
      </div>

      <div class="mt-[20px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          :accent="ACCENT"
          text-color="#2b1006"
          :met="hasSelection"
          message="Make a selection to saturate"
          label="Apply Saturation"
          @apply="applySaturation"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
