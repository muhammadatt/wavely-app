<script setup>
import { computed, onMounted, ref } from 'vue'
import { useManualEq } from '../../composables/useManualEq.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { PARAMETRIC_EQ_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import GeneralView from './eq/GeneralView.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'
import ModulaButton from '../modula/ModulaButton.vue'

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

const ACCENT = '#e8a33d'

const presets = usePluginPresets(PARAMETRIC_EQ_PRESET_PLUGIN, {
  read: () => eq.presetParams(),
  write: p => eq.applyPreset(p),
})

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
    :width="800"
    :accent="ACCENT"
    design="modula"
    brand-lead="PARAMETRIC EQ"
    :presets="presets"
    :presets-disabled="!eq.eqPreview.value"
    presets-disabled-hint="Turn the EQ on to use presets"
    :engaged="eq.eqPreview.value"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!eq.eqPreview.value || activeBandCount === 0"
    :apply-disabled-hint="activeBandCount === 0
      ? 'Move a band before applying'
      : 'Turn the EQ on to apply it'"
    resizable
    @update:height-delta="heightDelta = $event"
    @toggle-engaged="eq.togglePreview()"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="eq-toolbar">
      <ModulaLedPill
        size="sm" label="ANALYZER" color="var(--m-second)"
        :model-value="eq.showAnalyzer.value"
        title="Draw the live spectrum behind the curve"
        @update:model-value="eq.showAnalyzer.value = $event"
      />
      <span class="eq-count">{{ activeBandCount > 0 ? `${activeBandCount} band${activeBandCount === 1 ? '' : 's'} active` : 'flat' }}</span>
      <ModulaButton variant="ghost" size="sm" title="Back to the four neutral bands this opened with" @click="eq.resetBands()">Reset</ModulaButton>
    </div>

    <div class="eq-main">
      <LevelMeter variant="modula" scale-side="left" :levels="eq.inputLevels.value" label="IN" :height="PLOT_HEIGHT - 26" />

      <div class="eq-plot">
        <GeneralView
          :eq="eq" :accent="ACCENT" :sample-rate="sampleRate"
          :plot-height="PLOT_HEIGHT"
        />
      </div>

      <LevelMeter variant="modula" scale-side="right" :levels="eq.outputLevels.value" label="OUT" :height="PLOT_HEIGHT - 26" />
    </div>
  </FloatingWindow>
</template>

<style scoped>
.eq-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin: 0 4px 12px;
}
.eq-count {
  flex: 1;
  text-align: right;
  font: 600 9px/1 var(--m-font-mono);
  letter-spacing: .1em;
  color: var(--m-ink-4);
}
.eq-main {
  display: flex;
  align-items: flex-start;
  /* The meters' readout well is wider than their ladder; this keeps it off the plot. */
  gap: 20px;
}
.eq-plot {
  flex: 1;
  min-width: 0;
}
</style>
