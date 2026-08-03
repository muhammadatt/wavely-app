<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { normalizeRegion, computePeakCache } from '../../../audio/processing.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import ApplyAction from '../../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, totalDuration,
} = useEditorState()

const ACCENT = '#5df0b0'

const targetPeak = ref(-1)

function formatDb(v) {
  return v.toFixed(1)
}

async function applyNormalize(useSelection = true) {
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
    :z="z"
    :width="360"
    :accent="ACCENT"
    brand-lead="PEAK"
    brand-tail="NORM"
    :show-engage="false"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <!-- One parameter, so it carries the face: a single large knob rather
           than a lone slider adrift in the panel. -->
      <div class="flex justify-center">
        <div class="w-[136px]">
          <Knob
            v-model="targetPeak"
            :min="-12" :max="0" :step="0.5"
            label="Target Peak" :accent="ACCENT" :format-value="formatDb"
          />
        </div>
      </div>

      <p class="mt-[18px] text-center text-[10.5px] leading-[1.5] text-[rgba(255,255,255,.4)]">
        Scales the selection so its loudest peak lands at
        <span class="font-['JetBrains_Mono']" :style="{ color: ACCENT }">{{ formatDb(targetPeak) }} dBFS</span>.
      </p>

      <div class="mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          :previewable="false"
          :accent="ACCENT"
          text-color="#08211a"
          :met="hasSelection"
          message="Make a selection to normalize"
          label="Apply Normalize"
          @apply="applyNormalize()"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
