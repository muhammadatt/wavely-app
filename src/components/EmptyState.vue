<script setup>
import { useFileImport } from '../composables/useFileImport.js'
import BaseButton from './ui/BaseButton.vue'

// Drag-drop is handled once at the workspace level in EditorScreen so files can
// be dropped at any time, not only from here. This component is just the
// click-to-browse affordance and the import progress readout.
const { promptForFiles, isImporting, importProgress } = useFileImport()
</script>

<template>
  <div
    class="relative flex-1 min-h-0 rounded-[16px] border-3 border-dashed transition-all cursor-pointer m-1 flex items-center justify-center overflow-hidden"
    style="border-color:rgba(255,255,255,.12)"
  >
    <div
      class="text-center px-6 py-10 w-[420px] md:w-[500px]"
      @click="promptForFiles()"
    >
      <div class="w-[60px] h-[60px] rounded-[16px] flex items-center justify-center mx-auto mb-4" style="background:rgba(53,211,230,.12)">
        <svg viewBox="0 0 24 24" class="w-7 h-7 stroke-current" style="color:#7fe9f6" stroke-width="1.8" fill="none">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
      </div>

      <div v-if="isImporting">
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-2">
          Loading audio<span v-if="importProgress.total > 1"> — {{ importProgress.done + 1 }} of {{ importProgress.total }}</span>…
        </div>
        <div class="w-40 h-1.5 rounded-full mx-auto overflow-hidden" style="background:rgba(255,255,255,.08)">
          <div
            v-if="importProgress.total > 1"
            class="h-full rounded-full transition-all duration-300"
            style="background:#35d3e6"
            :style="{ width: `${(importProgress.done / importProgress.total) * 100}%` }"
          ></div>
          <div v-else class="h-full rounded-full animate-pulse w-2/3" style="background:#35d3e6"></div>
        </div>
      </div>

      <template v-else>
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-1">Drop your audio files here</div>
        <div class="text-[12px] font-medium text-[rgba(255,255,255,.4)] mb-5">or click to browse — you can pick more than one</div>

        <BaseButton size="md" @click.stop="promptForFiles()" class="w-full">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12 0c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/></svg>
          Choose audio files
        </BaseButton>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          <span v-for="fmt in ['MP3', 'WAV', 'OGG', 'M4A', 'FLAC']" :key="fmt"
                class="text-[10px] font-bold px-2 py-0.5 rounded-[6px]"
                style="background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)">
            {{ fmt }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
