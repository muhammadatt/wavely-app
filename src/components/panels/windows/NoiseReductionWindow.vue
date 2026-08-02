<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import ApplyAction from '../../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const { hasSelection, showToast } = useEditorState()

const ACCENT = '#a78bfa'

const strength = ref(50)
const sensitivity = ref(60)

// Strength reads better as a word than a number — the underlying 0-100 is not
// a unit anyone has a feel for.
function strengthLabel(v) {
  if (v < 34) return 'LOW'
  if (v < 67) return 'MED'
  return 'HIGH'
}

function percent(v) {
  return String(Math.round(v))
}
</script>

<template>
  <FloatingWindow
    window-id="noise-reduction"
    :z="z"
    :width="420"
    :accent="ACCENT"
    brand-lead="NOISE"
    brand-tail="REDUCE"
    :show-engage="false"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-start justify-center gap-[38px]">
        <div class="w-[118px]">
          <Knob
            v-model="strength"
            :min="0" :max="100" :step="1"
            label="Strength" :accent="ACCENT" :format-value="strengthLabel"
            :value-font-px="15"
          />
        </div>
        <div class="w-[118px]">
          <Knob
            v-model="sensitivity"
            :min="0" :max="100" :step="1"
            label="Sensitivity" :accent="ACCENT" :format-value="percent"
          />
        </div>
      </div>

      <p class="mt-[18px] text-center text-[10.5px] leading-[1.5] text-[rgba(255,255,255,.4)]">
        DeepFilterNet3 runs on the server. Higher strength removes more noise
        but risks thinning the voice.
      </p>

      <div class="mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          :accent="ACCENT"
          text-color="#150d28"
          :met="hasSelection"
          message="Make a selection to reduce noise"
          label="Apply Noise Reduction"
          @apply="showToast('Spot noise reduction via DeepFilterNet3 — coming in Sprint 2')"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
