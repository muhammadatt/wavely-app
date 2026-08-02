<script setup>
import { computed } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import BaseButton from './ui/BaseButton.vue'
import FileTabs from './FileTabs.vue'


const {
  state, appState, hasFile, documentCount,
} = useEditorState()
const { promptForFiles } = useFileImport()

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// The tab strip names the active file, so this row carries the properties a
// tab has no room for instead of repeating the filename.
const fileMeta = computed(() => {
  const f = state.currentFile
  if (!f) return null
  return {
    format: f.name.split('.').pop().toUpperCase(),
    duration: formatDuration(f.duration),
    channels: f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`,
    sampleRate: `${(f.sampleRate / 1000).toFixed(1)} kHz`,
  }
})
</script>

<template>
  <div
    class="h-[56px] flex items-center px-5 gap-[13px] shrink-0 z-10 border-b border-[rgba(255,255,255,.06)]"
    style="background:linear-gradient(rgb(20, 25, 34), rgb(14, 17, 22));"
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

    <!-- Active file properties -->
    <div class="flex-1 flex items-center gap-[8px] overflow-hidden" v-if="fileMeta">
      <span
        class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px] whitespace-nowrap shrink-0"
        style="color:#7fe9f6;background:rgba(53,211,230,.14);border:1px solid rgba(53,211,230,.3)"
      >{{ fileMeta.format }}</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.duration }}</span>
      <span class="text-[rgba(255,255,255,.15)] shrink-0">·</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.channels }}</span>
      <span class="text-[rgba(255,255,255,.15)] shrink-0">·</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.sampleRate }}</span>
    </div>
    <div v-else class="flex-1"></div>

        <FileTabs />

    <!-- Actions -->
    <div class="flex items-center gap-2">
      <BaseButton
        size="md" :pill="false"
        :disabled="!hasFile"
        @click="appState.exportDialogOpen = true"
        :title="documentCount > 1 ? 'Export files (Ctrl+E)' : 'Export as WAV (Ctrl+E)'"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
        Export
      </BaseButton>
    </div>
  </div>
</template>
