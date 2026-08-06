<script setup>
import { computed, onMounted } from 'vue'
import { useManualEq } from '../../composables/useManualEq.js'
import { useEditorState } from '../../composables/useEditorState.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'
import GeneralView from './eq/GeneralView.vue'

/**
 * The EQ faceplate — a parametric equaliser, on its own.
 *
 * It carried VoiceRx as a second view for a while, on the reasoning that both
 * were doing one job to one signal. See useEqInstance.js for why that was
 * abandoned; VoiceRx is its own window now, and can hand its corrections here.
 */

defineProps({ z: { type: Number, default: 500 } })

const eq = useManualEq()
const { state } = useEditorState()

const ACCENT = '#8fd18f'

onMounted(() => {
  // Opens with a starting layout rather than a bare plot — four unity bands,
  // so this cannot change what the user hears.
  eq.seedGeneralBands()
  // Default to engaged when the panel opens, matching the other plugin windows.
  if (!eq.eqPreview.value) eq.togglePreview()
})

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const activeBandCount = computed(() => eq.activeBands.value.length)

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  eq.teardown()
}

async function applyAndClose() {
  await eq.apply()
  eq.teardown()
  eq.closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="manual-eq"
    :z="z"
    :width="720"
    :accent="ACCENT"
    brand-lead="EQ"
    brand-tail="PARAMETRIC"
    :engaged="eq.eqPreview.value"
    @toggle-engaged="eq.togglePreview()"
    @close="close"
  >
    <div class="px-[22px] pt-[18px] pb-[22px]">
      <div class="flex items-center justify-end mb-[14px] gap-[14px]">
        <span
          v-if="activeBandCount > 0"
          style="font:600 9px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
        >{{ activeBandCount }} band{{ activeBandCount === 1 ? '' : 's' }} active</span>
        <button
          type="button"
          class="px-[8px] py-[4px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4)"
          title="Back to the four neutral bands this opened with"
          @click="eq.resetBands()"
        >RESET</button>
      </div>

      <div class="flex gap-[16px]">
        <LevelMeter :db="eq.inputDb.value" label="IN" :height="200" />

        <div class="flex-1 min-w-0">
          <GeneralView :eq="eq" :accent="ACCENT" :sample-rate="sampleRate" />
        </div>

        <LevelMeter :db="eq.outputDb.value" label="OUT" :height="200" />
      </div>

      <div class="mt-[16px] pt-[14px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0a1410"
          :met="eq.hasSelection.value"
          message="Make a selection to equalise"
          label="Apply EQ"
          :disabled="!eq.eqPreview.value || activeBandCount === 0"
          :disabled-hint="activeBandCount === 0
            ? 'Move a band before applying'
            : 'Turn the EQ on to apply it'"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
