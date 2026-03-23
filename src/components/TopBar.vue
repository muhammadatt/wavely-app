<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { exportAsWav } from '../audio/export.js'

const { state, undo, redo, canUndo, canRedo, showToast } = useEditorState()

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function handleExport() {
  if (!state.currentFile) return
  exportAsWav(
    state.segments,
    state.currentFile.sampleRate,
    state.currentFile.channels,
    state.currentFile.name
  )
  showToast('File exported as WAV')
}
</script>

<template>
  <div class="h-[62px] bg-surface border-b-2 border-border flex items-center px-5 gap-3 shrink-0 shadow-[0_2px_12px_rgba(45,42,62,0.06)]">
    <!-- Logo -->
    <div class="flex items-center gap-2 shrink-0">
      <div class="w-8 h-8 bg-accent rounded-[10px] flex items-center justify-center shadow-[0_3px_0_var(--color-accent-dk)]">
        <svg viewBox="0 0 20 20" class="w-[17px] h-[17px]"><path d="M3 10 Q5 4 7 10 Q9 16 11 10 Q13 4 15 10 Q17 16 19 10" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      </div>
      <span class="font-heading text-xl font-black text-ink">Wavely</span>
    </div>

    <div class="w-px h-6 bg-border"></div>

    <!-- Filename -->
    <div class="flex-1 flex items-center gap-2 text-ink-mid text-[13px] overflow-hidden" v-if="state.currentFile">
      <strong class="text-ink truncate">{{ state.currentFile.name }}</strong>
      <span class="bg-purple-lt text-purple text-[11px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap">
        {{ formatDuration(state.currentFile.duration) }}
      </span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-1.5">
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent hover:bg-bg disabled:opacity-30 disabled:cursor-default"
        :disabled="!canUndo"
        @click="undo"
        title="Undo (Ctrl+Z)"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] stroke-ink-mid fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg>
      </button>
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent hover:bg-bg disabled:opacity-30 disabled:cursor-default"
        :disabled="!canRedo"
        @click="redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] stroke-ink-mid fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3L21 13"/></svg>
      </button>

      <div class="w-px h-6 bg-border mx-1"></div>

      <button
        class="inline-flex items-center gap-2 bg-accent text-white font-heading text-[13px] font-extrabold px-4 py-2 rounded-full border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk),0_4px_12px_rgba(255,107,107,0.3)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),0_6px_16px_rgba(255,107,107,0.35)] active:translate-y-0.5 active:shadow-[0_1px_0_var(--color-accent-dk)]"
        @click="handleExport"
      >
        <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] stroke-white fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        Export
      </button>
    </div>
  </div>
</template>
