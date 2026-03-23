<script setup>
import { useEditorState } from '../composables/useEditorState.js'

const { state, hasSelection, performDelete, performSilence, showToast } = useEditorState()

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(2)
  return `${m}:${s.padStart(5, '0')}`
}

function handleCopy() {
  showToast('Copied to clipboard')
}
</script>

<template>
  <div
    v-if="hasSelection"
    class="h-10 bg-ink flex items-center px-4 gap-3 text-[12px] font-semibold text-white shrink-0"
  >
    <span class="text-ink-lt">Selection</span>
    <span class="text-purple-lt font-bold">{{ formatTime(state.selection.start) }}</span>
    <span class="text-ink-lt">→</span>
    <span class="text-purple-lt font-bold">{{ formatTime(state.selection.end) }}</span>

    <div class="w-px h-4 bg-ink-mid mx-1"></div>

    <span class="text-ink-lt">Duration</span>
    <span class="text-white font-bold">{{ (state.selection.end - state.selection.start).toFixed(2) }}s</span>

    <div class="w-px h-4 bg-ink-mid mx-1"></div>

    <div class="flex items-center gap-1 ml-auto">
      <button
        class="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 text-white/80 text-[11px] font-bold border-none cursor-pointer transition-all hover:bg-white/20"
        @click="handleCopy"
      >
        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy
      </button>
      <button
        class="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/10 text-white/80 text-[11px] font-bold border-none cursor-pointer transition-all hover:bg-white/20"
        @click="performSilence"
      >
        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>
        Silence
      </button>
      <button
        class="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-accent/30 text-accent-lt text-[11px] font-bold border-none cursor-pointer transition-all hover:bg-accent/50"
        @click="performDelete"
      >
        <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        Delete
      </button>
    </div>
  </div>
</template>
