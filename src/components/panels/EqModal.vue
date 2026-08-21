<script setup>
import { computed, onMounted, ref } from 'vue'
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

/**
 * Taller than the 200 px other faceplates use, by what removing the instruction
 * row under the plot gave back — so the window is the height it was and the
 * space went to the curve rather than off the bottom. Every dB of range gets
 * ~10% more pixels for free, which matters most at the ±30 stop where the axis
 * is thinnest. Shared with the meters either side so the three line up.
 *
 * That sharing is also what heightDelta feeds: FloatingWindow's corner grip
 * reports raw dragged pixels, and adding them here rather than to a
 * standalone plot constant is what keeps the meters matching the curve once
 * the window is bigger than it opened at. The band strips below the curve are
 * untouched — only the display grows.
 */
const PLOT_HEIGHT_BASE = 221
const heightDelta = ref(0)
const PLOT_HEIGHT = computed(() => PLOT_HEIGHT_BASE + heightDelta.value)

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
    resizable
    @update:height-delta="heightDelta = $event"
    @toggle-engaged="eq.togglePreview()"
    @close="close"
  >
    <div class="px-[22px] pt-[18px] pb-[22px]">
      <div class="flex items-center justify-between mb-[14px] gap-[14px]">
        <label
          class="flex items-center gap-[6px] cursor-pointer shrink-0"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;color:rgba(255,255,255,.4)"
          title="Draw the live spectrum behind the curve"
        >
          <input
            type="checkbox"
            :checked="eq.showAnalyzer.value"
            class="accent-current w-[11px] h-[11px]"
            @change="eq.showAnalyzer.value = $event.target.checked"
          >
          ANALYZER
        </label>
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
        <LevelMeter :levels="eq.inputLevels.value" label="IN" :height="PLOT_HEIGHT" />

        <div class="flex-1 min-w-0">
          <GeneralView
            :eq="eq" :accent="ACCENT" :sample-rate="sampleRate"
            :plot-height="PLOT_HEIGHT"
          />
        </div>

        <LevelMeter :levels="eq.outputLevels.value" label="OUT" :height="PLOT_HEIGHT" />
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
