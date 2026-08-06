<script setup>
import { computed, onMounted } from 'vue'
import { useVoiceRx } from '../../composables/useVoiceRx.js'
import { useEditorState } from '../../composables/useEditorState.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'
import VoiceRxView from './eq/VoiceRxView.vue'

/**
 * The VoiceRx faceplate — voice diagnosis, in its own window.
 *
 * A different accent from the EQ on purpose. The two plugins do adjacent jobs
 * to the same signal and can both be engaged at once, so the one thing the
 * faceplate has to make instant is which of them you are looking at.
 */

defineProps({ z: { type: Number, default: 500 } })

const vox = useVoiceRx()
const { state } = useEditorState()

const ACCENT = '#7fb8e8'

onMounted(() => {
  if (!vox.eqPreview.value) vox.togglePreview()
})

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const activeBandCount = computed(() => vox.activeBands.value.length)

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  vox.teardown()
}

async function applyAndClose() {
  await vox.apply()
  vox.teardown()
  vox.closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="voicerx"
    :z="z"
    :width="720"
    :accent="ACCENT"
    brand-lead="VOICE"
    brand-tail="RX"
    :engaged="vox.eqPreview.value"
    @toggle-engaged="vox.togglePreview()"
    @close="close"
  >
    <div class="px-[22px] pt-[18px] pb-[22px]">
      <div class="flex items-center justify-end mb-[14px] gap-[14px]">
        <span
          v-if="activeBandCount > 0"
          style="font:600 9px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
        >{{ activeBandCount }} correction{{ activeBandCount === 1 ? '' : 's' }}</span>
        <button
          v-if="vox.canSendToEq.value"
          type="button"
          class="px-[8px] py-[4px] rounded-[3px]"
          :style="{
            font: '600 9px/1 Inter', letterSpacing: '.06em',
            border: `1px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
            color: ACCENT,
          }"
          title="Move these corrections into the EQ, where you can shape them further"
          @click="vox.sendToEq()"
        >SEND TO EQ →</button>
        <button
          v-if="vox.bands.value.length > 0"
          type="button"
          class="px-[8px] py-[4px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4)"
          @click="vox.clearBands()"
        >RESET</button>
      </div>

      <div class="flex gap-[16px]">
        <LevelMeter :db="vox.inputDb.value" label="IN" :height="200" />

        <div class="flex-1 min-w-0">
          <VoiceRxView :eq="vox" :accent="ACCENT" :sample-rate="sampleRate" />
        </div>

        <LevelMeter :db="vox.outputDb.value" label="OUT" :height="200" />
      </div>

      <div class="mt-[16px] pt-[14px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0a1410"
          :met="vox.hasSelection.value"
          message="Make a selection to diagnose"
          label="Apply corrections"
          :disabled="!vox.eqPreview.value || activeBandCount === 0"
          :disabled-hint="activeBandCount === 0
            ? 'Apply a suggestion, or move a knob, before applying'
            : 'Turn VoiceRx on to apply it'"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
