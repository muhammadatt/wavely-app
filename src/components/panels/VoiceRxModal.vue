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
    :width="820"
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
        <!-- Only once there is something to re-do. Keyed on the raw analysis
             rather than hasAnalysis, which goes false the moment the selection
             changes — precisely when re-analyzing is the thing you want. -->
        <button
          v-if="vox.analysis.value?.ok"
          type="button"
          class="flex items-center gap-[6px] px-[8px] py-[4px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.5)"
          :style="{ opacity: vox.analyzing.value || !vox.hasSelection.value ? 0.55 : 1 }"
          :disabled="vox.analyzing.value || !vox.hasSelection.value"
          :title="vox.hasSelection.value
            ? 'Measure the current selection again'
            : 'Select some audio to measure'"
          @click="vox.analyze()"
        >
          <span v-if="vox.analyzing.value" class="vrx-spin" aria-hidden="true" />
          {{ vox.analyzing.value ? 'ANALYSING…' : 'RE-ANALYZE' }}
        </button>
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
        >CLEAR</button>
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

<style scoped>
/*
 * The analysis blocks the main thread while it runs, so the busy indicator has
 * to be something the compositor can animate on its own. A transform keyframe
 * qualifies; anything driven by JS would sit frozen for exactly the seconds it
 * is meant to cover.
 *
 * Duplicated from VoiceRxView rather than shared: scoped styles do not cross
 * component boundaries, and a two-rule spinner is not worth a global class.
 */
.vrx-spin {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  border-top-color: rgba(255, 255, 255, 0.6);
  animation: vrx-spin 0.7s linear infinite;
  will-change: transform;
}

@keyframes vrx-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .vrx-spin { animation-duration: 2.4s; }
}
</style>
