<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import ApplyAction from '../../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const { hasSelection, showToast } = useEditorState()

const ACCENT = '#fb7185'

const threshold = ref(-40)
// Stored in tenths of a second so the control can step in 0.1s increments
// without accumulating float drift.
const minLengthTenths = ref(5)

function formatDb(v) {
  return String(Math.round(v))
}

function formatSeconds(v) {
  return (v / 10).toFixed(1)
}
</script>

<template>
  <FloatingWindow
    window-id="remove-silence"
    :z="z"
    :width="420"
    :accent="ACCENT"
    brand-lead="SILENCE"
    brand-tail="TRIM"
    :show-engage="false"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-start justify-center gap-[38px]">
        <div class="w-[118px]">
          <Knob
            v-model="threshold"
            :min="-60" :max="-10" :step="1"
            label="Threshold" :accent="ACCENT" :format-value="formatDb"
          />
        </div>
        <div class="w-[118px]">
          <Knob
            v-model="minLengthTenths"
            :min="1" :max="30" :step="1"
            label="Min Length" :accent="ACCENT" :format-value="formatSeconds"
          />
        </div>
      </div>

      <p class="mt-[18px] text-center text-[10.5px] leading-[1.5] text-[rgba(255,255,255,.4)]">
        Cuts gaps quieter than
        <span class="font-['JetBrains_Mono']" :style="{ color: ACCENT }">{{ formatDb(threshold) }} dB</span>
        that last longer than
        <span class="font-['JetBrains_Mono']" :style="{ color: ACCENT }">{{ formatSeconds(minLengthTenths) }} s</span>.
      </p>

      <div class="mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          :previewable="false"
          :accent="ACCENT"
          text-color="#2b0d13"
          :met="hasSelection"
          message="Make a selection to remove silence"
          label="Remove Silence"
          @apply="showToast('Remove silence coming soon')"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
