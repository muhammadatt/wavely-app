<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import BaseButton from './ui/BaseButton.vue'

const { state, setActiveTool, hasFile } = useEditorState()

const tools = [
  {
    id: 'split', label: 'Split',
    icon: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M6 8l6-6 6 6"/><path d="M6 16l6 6 6-6"/>',
  },
  {
    id: 'trim', label: 'Trim',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  },
  {
    // SilencePanel existed but nothing could set activeTool to 'silence', so the
    // panel was unreachable — Silence was only available as the SelectionBar's
    // instant-apply button, with no explanation of what it does.
    id: 'silence', label: 'Silence',
    icon: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  },
  {
    id: 'fade', label: 'Fade',
    icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  },
  {
    id: 'volume', label: 'Volume',
    icon: '<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/>',
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

function handleZoomIn() {
  window.dispatchEvent(new CustomEvent('wavely:zoom-in'))
}

function handleZoomOut() {
  window.dispatchEvent(new CustomEvent('wavely:zoom-out'))
}
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
        size="xs" color="ghost" square
        :disabled="!hasFile"
        @click="handleZoomIn"
        title="Zoom In (+)"
        aria-label="Zoom in"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" square
        :disabled="!hasFile"
        @click="handleZoomOut"
        title="Zoom Out (-)"
        aria-label="Zoom out"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
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
