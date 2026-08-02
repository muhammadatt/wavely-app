<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import ParameterSlider from '../../ui/ParameterSlider.vue'
import RequirementNotice from '../../ui/RequirementNotice.vue'
import BaseButton from '../../ui/BaseButton.vue'
import Icon from '../../ui/Icon.vue'

defineProps({ z: { type: Number, default: 500 } })

const { hasSelection, showToast } = useEditorState()

const strength = ref(50)
const sensitivity = ref(60)

// Strength reads better as a word than a number — the underlying 0-100 is not
// a unit the user has any feel for.
function strengthLabel(v) {
  if (v < 34) return 'Low'
  if (v < 67) return 'Medium'
  return 'High'
}
</script>

<template>
  <FloatingWindow
    window-id="noise-reduction"
    variant="utility"
    :z="z"
    title="Noise Reduction"
    icon="noise"
    :show-engage="false"
  >
    <div class="p-4 flex flex-col gap-[14px]">
      <p class="text-[11.5px] leading-[1.45] text-text-muted">
        Removes background noise from the selection using DeepFilterNet3 on the server.
      </p>

      <ParameterSlider
        v-model="strength"
        label="Strength"
        :min="0" :max="100" :step="1"
        :format-value="strengthLabel"
      />
      <ParameterSlider
        v-model="sensitivity"
        label="Sensitivity"
        :min="0" :max="100" :step="1"
        unit="%"
      />

      <RequirementNotice
        :met="hasSelection"
        message="Make a selection on the waveform to reduce noise"
      />

      <BaseButton
        size="md" block
        :disabled="!hasSelection"
        @click="showToast('Spot noise reduction via DeepFilterNet3 — coming in Sprint 2')"
      >
        <Icon name="check" :size="13" :stroke-width="2.5" />
        Apply Noise Reduction
      </BaseButton>
    </div>
  </FloatingWindow>
</template>
