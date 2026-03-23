<script setup>
import { useEditorState } from '../composables/useEditorState.js'

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
    id: 'silence', label: 'Silence',
    icon: '<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/>',
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
  <div class="flex items-center justify-center py-2 px-4 shrink-0">
    <div class="inline-flex items-center gap-1 bg-surface rounded-[var(--radius-md)] px-3 py-2 shadow-[var(--shadow-md)]">
      <!-- Tool buttons -->
      <button
        v-for="tool in tools"
        :key="tool.id"
        class="w-10 h-10 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all relative group"
        :class="state.activeTool === tool.id ? 'bg-accent text-white shadow-[0_3px_0_var(--color-accent-dk)]' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="setActiveTool(tool.id)"
        :title="tool.label"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="tool.icon"></svg>
        <!-- Tooltip -->
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-ink text-white text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          {{ tool.label }}
        </span>
      </button>

      <div class="w-px h-6 bg-border mx-1"></div>

      <!-- Effects button -->
      <button
        class="w-10 h-10 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all relative group"
        :class="state.activeTool === 'effects' ? 'bg-accent text-white shadow-[0_3px_0_var(--color-accent-dk)]' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="setActiveTool('effects')"
        title="Effects"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14M15.54 8.46a5 5 0 010 7.07M8.46 8.46a5 5 0 000 7.07"/>
        </svg>
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-ink text-white text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Effects
        </span>
      </button>

      <div class="w-px h-6 bg-border mx-1"></div>

      <!-- Zoom buttons -->
      <button
        class="w-10 h-10 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink relative group"
        @click="handleZoomIn"
        title="Zoom In (+)"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-ink text-white text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Zoom In
        </span>
      </button>
      <button
        class="w-10 h-10 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink relative group"
        @click="handleZoomOut"
        title="Zoom Out (-)"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/>
        </svg>
        <span class="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-ink text-white text-[10px] font-bold px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Zoom Out
        </span>
      </button>
    </div>
  </div>
</template>
