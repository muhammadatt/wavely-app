<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import BaseButton from './ui/BaseButton.vue'

const { state, setActiveTool, hasFile, undo, redo, canUndo, canRedo } = useEditorState()

const tools = [
  {
    id: 'split', label: 'Split',
    icon: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M6 8l6-6 6 6"/><path d="M6 16l6 6 6-6"/>',
  },
  {
    // Trim / Silence / Fade / Volume are sub-tools inside EditPanel rather than
    // four toolbar entries — they all operate on the current selection and were
    // pushing the tool group into a scroll on narrower windows.
    id: 'edit', label: 'Edit',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  },
  {
    id: 'effects', label: 'Effects',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14M15.54 8.46a5 5 0 010 7.07M8.46 8.46a5 5 0 000 7.07"/>',
  },
  {
    id: 'presets', label: 'Presets',
    icon: '<path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/>',
  },
]
</script>

<template>
  <div class="h-[60px] flex items-center gap-3 px-5 shrink-0 border-b border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0e1216)">
    <div class="flex-1 min-w-0"></div>
    <!-- min-w-0 + scroll: the tool group gives up centring before it collides
         with the zoom controls on a narrow window. -->
    <div class="tool-group flex items-center gap-[4px] p-[5px] rounded-[13px] min-w-0 overflow-x-auto" style="background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
      <BaseButton
        v-for="tool in tools"
        :key="tool.id"
        size="md" :pill="false" toggle
        :active="state.activeTool === tool.id"
        :disabled="!hasFile"
        class="whitespace-nowrap shrink-0"
        @click="setActiveTool(tool.id)"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" class="fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="tool.icon"></svg>
        {{ tool.label }}
      </BaseButton>
    </div>
    <!-- No min-w-0 here on purpose: this side must never shrink below its own
         content, or its basis-0 box collapses and the buttons spill leftward
         over the tool group. -->
    <div class="flex-1 flex justify-end gap-2">
      <BaseButton
        size="sm" color="ghost" :pill="false"
        :disabled="!canUndo"
        @click="undo"
        title="Undo (Ctrl+Z)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>
        Undo
      </BaseButton>
      <BaseButton
        size="sm" color="ghost" :pill="false"
        :disabled="!canRedo"
        @click="redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/></svg>
        Redo
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  scrollbar-width: none;
}
.tool-group::-webkit-scrollbar {
  display: none;
}
</style>
