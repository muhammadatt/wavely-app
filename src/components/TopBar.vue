<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { exportAsWav } from '../audio/export.js'
import BaseButton from './ui/BaseButton.vue'

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
  <div
    class="h-[56px] flex items-center px-5 gap-[13px] shrink-0 z-10 border-b border-[rgba(255,255,255,.06)]"
    style="background:linear-gradient(180deg,#1e242b,#151a20)"
  >
    <!-- Logo -->
    <div class="flex items-center gap-[13px] shrink-0">
      <div
        class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center"
        style="background:linear-gradient(135deg,#7ef0ff,#25b6d0);box-shadow:0 0 16px rgba(53,211,230,.5)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#08161a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2-6 3 13 3-16 2 9h5"/></svg>
      </div>
      <span class="font-['Inter'] text-[15px] font-extrabold tracking-[0.2em] text-[#eaf6f8]">WAVELY</span>
    </div>

    <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)]"></div>

    <!-- Filename -->
    <div class="flex-1 flex items-center gap-[10px] overflow-hidden" v-if="state.currentFile">
      <span class="font-['Inter'] text-[12.5px] font-medium text-[rgba(255,255,255,.6)] truncate max-w-[280px]">{{ state.currentFile.name }}</span>
      <span
        class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px] whitespace-nowrap shrink-0"
        style="color:#7fe9f6;background:rgba(53,211,230,.14);border:1px solid rgba(53,211,230,.3)"
      >{{ state.currentFile.name.split('.').pop().toUpperCase() }}</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">
        {{ formatDuration(state.currentFile.duration) }}
      </span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2">
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

      <div class="w-px h-6 bg-[rgba(255,255,255,.1)] mx-1"></div>

      <BaseButton
        size="md" :pill="false"
        :disabled="state.isProcessing"
        @click="handleExport"
        title="Export as WAV"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
        Export
      </BaseButton>
    </div>
  </div>
</template>
