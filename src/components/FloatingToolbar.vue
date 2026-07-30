<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import BaseButton from './ui/BaseButton.vue'

const { state, setActiveTool } = useEditorState()

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
  <div class="h-[60px] flex items-center px-5 shrink-0 border-b border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0e1216)">
    <div class="flex-1"></div>
    <div class="flex items-center gap-[4px] p-[5px] rounded-[13px]" style="background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
      <BaseButton
        v-for="tool in tools"
        :key="tool.id"
        size="md" :pill="false" toggle
        :active="state.activeTool === tool.id"
        class="whitespace-nowrap"
        @click="setActiveTool(tool.id)"
        :title="tool.label"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" class="fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="tool.icon"></svg>
        {{ tool.label }}
      </BaseButton>
    </div>
    <div class="flex-1 flex justify-end gap-2">
      <button
        class="w-[34px] h-[34px] rounded-[9px] border cursor-pointer flex items-center justify-center transition-colors relative group"
        style="border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.6)"
        @click="handleZoomIn"
        title="Zoom In (+)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-[#1c2129] text-[#eaf6f8] text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Zoom In
        </span>
      </button>
      <button
        class="w-[34px] h-[34px] rounded-[9px] border cursor-pointer flex items-center justify-center transition-colors relative group"
        style="border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.6)"
        @click="handleZoomOut"
        title="Zoom Out (-)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-[#1c2129] text-[#eaf6f8] text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Zoom Out
        </span>
      </button>
    </div>
  </div>
</template>
