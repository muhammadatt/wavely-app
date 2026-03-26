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
  <div class="h-[62px] bg-surface border-b-2 border-border flex items-center px-5 gap-3 shrink-0 shadow-[0_2px_12px_rgba(45,42,62,0.06)] z-10">
    <!-- Logo -->
    <div class="flex items-center gap-2 shrink-0">
      <div class="w-8 h-8 bg-accent rounded-[10px] flex items-center justify-center shadow-[0_3px_0_var(--color-accent-dk)]">
        <svg viewBox="0 0 20 20" class="w-[17px] h-[17px]"><path d="M3 10 Q5 4 7 10 Q9 16 11 10 Q13 4 15 10 Q17 16 19 10" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      </div>
      <span class="font-heading text-xl font-black text-ink">Wavely</span>
    </div>

    <div class="w-px h-[22px] bg-border"></div>

    <!-- Filename -->
    <div class="flex-1 flex items-center gap-2 text-ink-mid text-[13px] overflow-hidden" v-if="state.currentFile">
      <strong class="text-ink font-bold truncate max-w-[260px]">{{ state.currentFile.name }}</strong>
      <span class="bg-purple-lt text-purple text-[10px] font-extrabold px-2 py-[1px] rounded-[var(--radius-sm)] border-2 border-border whitespace-nowrap tracking-[0.5px] shrink-0">
        {{ state.currentFile.name.split('.').pop().toUpperCase() }}
      </span>
      <span class="text-[12px] text-ink-lt font-bold whitespace-nowrap shrink-0">
        {{ formatDuration(state.currentFile.duration) }}
      </span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-1.5">
      <button
        class="inline-flex items-center gap-1.5 bg-transparent text-ink-mid font-heading text-[13px] font-bold px-[13px] py-[7px] rounded-full border-2 border-transparent cursor-pointer transition-all hover:bg-bg hover:border-border hover:text-ink disabled:opacity-35 disabled:cursor-default disabled:pointer-events-none"
        :disabled="!canUndo"
        @click="undo"
        title="Undo (Ctrl+Z)"
      >
        <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] stroke-current fill-none shrink-0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/></svg>
        Undo
      </button>
      <button
        class="inline-flex items-center gap-1.5 bg-transparent text-ink-mid font-heading text-[13px] font-bold px-[13px] py-[7px] rounded-full border-2 border-transparent cursor-pointer transition-all hover:bg-bg hover:border-border hover:text-ink disabled:opacity-35 disabled:cursor-default disabled:pointer-events-none"
        :disabled="!canRedo"
        @click="redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] stroke-current fill-none shrink-0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3L21 13"/></svg>
        Redo
      </button>

      <div class="w-px h-6 bg-border mx-1"></div>

      <button
        class="inline-flex items-center gap-1.5 bg-mint text-white font-heading text-[13px] font-extrabold px-[18px] py-2 rounded-full border-none cursor-pointer transition-all shadow-[0_3px_0_#2aaa8f,var(--shadow-mint)] hover:-translate-y-px hover:shadow-[0_5px_0_#2aaa8f,0_8px_20px_rgba(62,207,178,0.35)] active:translate-y-[2px] active:shadow-[0_1px_0_#2aaa8f]"
        @click="handleExport"
      >
        <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] stroke-white fill-none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
        Export
      </button>
    </div>
  </div>
</template>
