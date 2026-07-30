<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import SplitPanel from './panels/SplitPanel.vue'
import TrimPanel from './panels/TrimPanel.vue'
import SilencePanel from './panels/SilencePanel.vue'
import VolumePanel from './panels/VolumePanel.vue'
import FadePanel from './panels/FadePanel.vue'
import EffectsPanel from './panels/EffectsPanel.vue'
import PresetsPanel from './panels/PresetsPanel.vue'

const { state, setActiveTool } = useEditorState()

// Re-clicking the active tool was the only way out of here, which is not a
// thing a panel with no visible close control tells you.
function close() {
  if (state.activeTool) setActiveTool(state.activeTool)
}
</script>

<template>
  <div class="w-[280px] shrink-0 relative border-l border-[rgba(255,255,255,.06)] overflow-y-auto" style="background:linear-gradient(180deg,#141922,#0e1116)">
    <button
      class="panel-close absolute top-[14px] right-[14px] z-10 w-6 h-6 rounded-[7px] flex items-center justify-center cursor-pointer"
      title="Close panel (Esc)"
      aria-label="Close panel"
      @click="close"
    >
      <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>

    <SplitPanel v-if="state.activeTool === 'split'" />
    <TrimPanel v-if="state.activeTool === 'trim'" />
    <SilencePanel v-if="state.activeTool === 'silence'" />
    <VolumePanel v-if="state.activeTool === 'volume'" />
    <FadePanel v-if="state.activeTool === 'fade'" />
    <EffectsPanel v-if="state.activeTool === 'effects'" />
    <PresetsPanel v-if="state.activeTool === 'presets'" />
  </div>
</template>

<style scoped>
.panel-close {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.55);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.panel-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
.panel-close:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
</style>
