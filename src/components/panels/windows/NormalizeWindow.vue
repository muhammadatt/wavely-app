<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { normalizeRegion, computePeakCache } from '../../../audio/processing.js'
import FloatingWindow from '../FloatingWindow.vue'
import ParameterSlider from '../../ui/ParameterSlider.vue'
import RequirementNotice from '../../ui/RequirementNotice.vue'
import BaseButton from '../../ui/BaseButton.vue'
import Icon from '../../ui/Icon.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, totalDuration,
} = useEditorState()

const targetPeak = ref(-1)

async function applyNormalize(useSelection) {
  const start = useSelection && state.selection ? state.selection.start : 0
  const end = useSelection && state.selection ? state.selection.end : totalDuration.value

  if (start >= end) return

  startProcessing('Normalizing...')
  try {
    const ctx = getAudioContext()
    const buffer = await normalizeRegion(
      state.segments, start, end, targetPeak.value,
      ctx, state.currentFile.sampleRate, state.currentFile.channels
    )
    const bufferId = replaceRegion(start, end, buffer)

    // Recompute peak cache for new buffer
    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Normalization applied')
  } catch (err) {
    console.error('Normalize failed:', err)
    showToast('Normalization failed')
  } finally {
    endProcessing()
  }
}
</script>

<template>
  <FloatingWindow
    window-id="normalize"
    variant="utility"
    :z="z"
    title="Normalize"
    icon="normalize"
    :show-engage="false"
  >
    <div class="p-4 flex flex-col gap-[14px]">
      <p class="text-[11.5px] leading-[1.45] text-text-muted">
        Scales the selection so its loudest peak sits at the target level.
      </p>

      <ParameterSlider
        v-model="targetPeak"
        label="Target peak"
        :min="-12" :max="0" :step="1"
        unit="dBFS"
      />

      <RequirementNotice
        :met="hasSelection"
        message="Make a selection on the waveform to normalize"
      />

      <BaseButton size="md" block :disabled="!hasSelection" @click="applyNormalize(true)">
        <Icon name="check" :size="13" :stroke-width="2.5" />
        Apply Normalize
      </BaseButton>
    </div>
  </FloatingWindow>
</template>
