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

const threshold = ref(-40)
// Stored in tenths of a second so the slider can step in 0.1s increments
// without accumulating float drift.
const minLengthTenths = ref(5)
</script>

<template>
  <FloatingWindow
    window-id="remove-silence"
    variant="utility"
    :z="z"
    title="Remove Silence"
    icon="scissors"
    :show-engage="false"
  >
    <div class="p-4 flex flex-col gap-[14px]">
      <p class="text-[11.5px] leading-[1.45] text-text-muted">
        Cuts out quiet gaps longer than the minimum length.
      </p>

      <ParameterSlider
        v-model="threshold"
        label="Silence threshold"
        :min="-60" :max="-10" :step="1"
        unit="dB"
      />
      <ParameterSlider
        v-model="minLengthTenths"
        label="Min silence length"
        :min="1" :max="30" :step="1"
        :format-value="v => `${(v / 10).toFixed(1)} s`"
      />

      <RequirementNotice
        :met="hasSelection"
        message="Make a selection on the waveform to remove silence"
      />

      <BaseButton
        size="md" block
        :disabled="!hasSelection"
        @click="showToast('Remove silence coming soon')"
      >
        <Icon name="check" :size="13" :stroke-width="2.5" />
        Remove Silence
      </BaseButton>
    </div>
  </FloatingWindow>
</template>
