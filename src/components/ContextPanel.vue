<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import SplitPanel from './panels/SplitPanel.vue'
import TrimPanel from './panels/TrimPanel.vue'
import SilencePanel from './panels/SilencePanel.vue'
import VolumePanel from './panels/VolumePanel.vue'
import FadePanel from './panels/FadePanel.vue'
import EffectsPanel from './panels/EffectsPanel.vue'
import PresetsPanel from './panels/PresetsPanel.vue'

const { state } = useEditorState()
</script>

<template>
  <div class="w-[280px] overflow-y-auto shrink-0 border-l border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#141922,#0e1116)">
    <SplitPanel v-if="state.activeTool === 'split'" />
    <TrimPanel v-if="state.activeTool === 'trim'" />
    <SilencePanel v-if="state.activeTool === 'silence'" />
    <VolumePanel v-if="state.activeTool === 'volume'" />
    <FadePanel v-if="state.activeTool === 'fade'" />
    <EffectsPanel v-if="state.activeTool === 'effects'" />
    <PresetsPanel v-if="state.activeTool === 'presets'" />
  </div>
</template>
