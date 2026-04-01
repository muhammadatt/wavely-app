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
    id: 'volume', label: 'Volume',
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
  <div class="h-[66px] flex items-center justify-center shrink-0">
    <div class="inline-flex items-center gap-[3px] bg-surface border-2 border-border rounded-[var(--radius-pill)] px-[5px] py-[5px] shadow-[0_6px_24px_rgba(45,42,62,0.12),0_2px_0_var(--color-border)]">
      <!-- Tool buttons -->
      <button
        v-for="tool in tools"
        :key="tool.id"
        class="h-[38px] px-3.5 flex items-center justify-center gap-1.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all relative group font-heading text-[13px] font-bold whitespace-nowrap"
        :class="state.activeTool === tool.id ? 'bg-accent text-white shadow-[0_3px_0_var(--color-accent-dk),var(--shadow-accent)]' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="setActiveTool(tool.id)"
        :title="tool.label"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="tool.icon"></svg>
        {{ tool.label }}
      </button>

      <div class="w-[2px] h-5 bg-border mx-[2px] rounded-sm"></div>

      <!-- Effects button -->
      <button
        class="h-[38px] px-3.5 flex items-center justify-center gap-1.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all relative group font-heading text-[13px] font-bold whitespace-nowrap"
        :class="state.activeTool === 'effects' ? 'bg-accent text-white shadow-[0_3px_0_var(--color-accent-dk),var(--shadow-accent)]' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="setActiveTool('effects')"
        title="Effects"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14M15.54 8.46a5 5 0 010 7.07M8.46 8.46a5 5 0 000 7.07"/>
        </svg>
        Effects
      </button>

      <!-- Presets button -->
      <button
        class="h-[38px] px-3.5 flex items-center justify-center gap-1.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all relative group font-heading text-[13px] font-bold whitespace-nowrap"
        :class="state.activeTool === 'presets' ? 'bg-accent text-white shadow-[0_3px_0_var(--color-accent-dk),var(--shadow-accent)]' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="setActiveTool('presets')"
        title="Presets"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/>
        </svg>
        Presets
      </button>

      <div class="w-[2px] h-5 bg-border mx-[2px] rounded-sm"></div>

      <!-- Zoom buttons -->
      <button
        class="w-[38px] h-[38px] rounded-[var(--radius-pill)] flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink relative group"
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
        class="w-[38px] h-[38px] rounded-[var(--radius-pill)] flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink relative group"
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
