<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { computePeakCache } from '../../../audio/processing.js'
import { applyVocalSaturation } from '../../../api/spotEffects.js'
import FloatingWindow from '../FloatingWindow.vue'
import ParameterSlider from '../../ui/ParameterSlider.vue'
import RequirementNotice from '../../ui/RequirementNotice.vue'
import BaseButton from '../../ui/BaseButton.vue'
import Icon from '../../ui/Icon.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast,
} = useEditorState()

// Defaults match the server-side script defaults.
const drive         = ref(2.0)
const wetDry        = ref(0.3)
const bias          = ref(0.5)
const lowCrossover  = ref(500)
const midCrossover  = ref(3500)
const softness      = ref(0.3)
const lowDriveMult  = ref(5.0)
const midDriveMult  = ref(0.1)
const highDriveMult = ref(0.1)

// Nine controls is too many to face someone with at once, so the per-band
// multipliers and crossovers fold away behind the four that matter.
const showAdvanced = ref(false)

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
    variant="utility"
    :z="z"
    title="Vocal Saturation"
    icon="saturation"
    :show-engage="false"
  >
    <div class="p-4 flex flex-col gap-[14px]">
      <p class="text-[11.5px] leading-[1.45] text-text-muted">
        Parallel tube-style warmth, driven per frequency band.
      </p>

      <ParameterSlider v-model="drive"    label="Drive"     :min="0" :max="5"   :step="0.05" />
      <ParameterSlider v-model="wetDry"   label="Wet / Dry" :min="0" :max="1"   :step="0.01" />
      <ParameterSlider v-model="bias"     label="Bias"      :min="0" :max="1.5" :step="0.01" />
      <ParameterSlider v-model="softness" label="Softness"  :min="0" :max="1"   :step="0.01" />

      <button
        class="advanced-toggle flex items-center gap-[5px] text-[11px] font-semibold bg-transparent border-none cursor-pointer p-0 self-start"
        :aria-expanded="String(showAdvanced)"
        @click="showAdvanced = !showAdvanced"
      >
        <Icon name="chevronDown" :size="13" :stroke-width="2.5"
              class="transition-transform" :class="showAdvanced ? 'rotate-180' : ''" />
        Band settings
      </button>

      <div v-if="showAdvanced" class="flex flex-col gap-[14px] pl-[10px] border-l border-border-1">
        <ParameterSlider v-model="lowCrossover"  label="Low crossover" :min="100"  :max="2000" :step="10"   unit="Hz" />
        <ParameterSlider v-model="midCrossover"  label="Mid crossover" :min="1000" :max="8000" :step="50"   unit="Hz" />
        <ParameterSlider v-model="lowDriveMult"  label="Low drive ×"   :min="0"    :max="10"   :step="0.05" />
        <ParameterSlider v-model="midDriveMult"  label="Mid drive ×"   :min="0"    :max="10"   :step="0.05" />
        <ParameterSlider v-model="highDriveMult" label="High drive ×"  :min="0"    :max="10"   :step="0.05" />
      </div>

      <RequirementNotice
        :met="hasSelection"
        message="Make a selection on the waveform to saturate"
      />

      <BaseButton size="md" block :disabled="!hasSelection" @click="applySaturation">
        <Icon name="check" :size="13" :stroke-width="2.5" />
        Apply Saturation
      </BaseButton>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.advanced-toggle {
  color: var(--color-text-faint);
  transition: color 0.15s ease;
}
.advanced-toggle:hover {
  color: var(--color-accent-bright);
}
.advanced-toggle:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 3px;
  border-radius: 4px;
}
</style>
