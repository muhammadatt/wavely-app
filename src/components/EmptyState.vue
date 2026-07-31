<script setup>
import { ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { decodeAudioFile, isSupportedFormat } from '../audio/loader.js'
import { computePeakCache } from '../audio/processing.js'
import BaseButton from './ui/BaseButton.vue'

const { loadFile, getAudioContext, setPeakCache, showToast } = useEditorState()

const isDragOver = ref(false)
const isLoading = ref(false)
const dragCounter = ref(0)
const fileInput = ref(null)

function onDragEnter(e) {
  e.preventDefault()
  dragCounter.value++
  isDragOver.value = true
}

function onDragLeave() {
  dragCounter.value--
  if (dragCounter.value === 0) isDragOver.value = false
}

function onDrop(e) {
  e.preventDefault()
  dragCounter.value = 0
  isDragOver.value = false
  const file = e.dataTransfer.files[0]
  if (file) handleFile(file)
}

function onFileSelect(e) {
  const file = e.target.files[0]
  if (file) handleFile(file)
}

async function handleFile(file) {
  if (!isSupportedFormat(file)) {
    showToast('Unsupported file format')
    return
  }

  isLoading.value = true

  let audioBuffer
  let bufferId

  try {
    try {
      const ctx = getAudioContext()
      audioBuffer = await decodeAudioFile(file, ctx)
      bufferId = loadFile(file.name, audioBuffer)
    } catch (err) {
      console.error('Failed to load audio file:', err)
      showToast('Failed to load audio file')
      return
    }

    try {
      const baseSamplesPerPx = 256
      const cache = await computePeakCache(audioBuffer, baseSamplesPerPx)
      setPeakCache(bufferId, cache)
    } catch (err) {
      console.warn('Failed to compute peak cache:', err)
      showToast('Loaded file but failed to generate waveform overview')
    }
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div
    class="relative flex-1 min-h-0 rounded-[16px] border-3 border-dashed transition-all cursor-pointer m-1 flex items-center justify-center overflow-hidden"
    :style="isDragOver
      ? 'border-color:#35d3e6;background:rgba(53,211,230,.06)'
      : 'border-color:rgba(255,255,255,.12)'"
    @dragenter="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      class="text-center px-6 py-10 w-[420px] md:w-[500px]"
      @click="fileInput.click()"
    >
      <div class="w-[60px] h-[60px] rounded-[16px] flex items-center justify-center mx-auto mb-4" style="background:rgba(53,211,230,.12)">
        <svg viewBox="0 0 24 24" class="w-7 h-7 stroke-current" style="color:#7fe9f6" stroke-width="1.8" fill="none">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
      </div>

      <div v-if="isLoading">
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-2">Loading audio...</div>
        <div class="w-40 h-1.5 rounded-full mx-auto overflow-hidden" style="background:rgba(255,255,255,.08)">
          <div class="h-full rounded-full animate-pulse w-2/3" style="background:#35d3e6"></div>
        </div>
      </div>

      <template v-else>
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-1">Drop your audio file here</div>
        <div class="text-[12px] font-medium text-[rgba(255,255,255,.4)] mb-5">or click to browse your files</div>

        <BaseButton size="md" @click.stop="fileInput.click()" class="w-full">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12 0c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/></svg>
          Choose audio file
        </BaseButton>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          <span v-for="fmt in ['MP3', 'WAV', 'OGG', 'M4A', 'FLAC']" :key="fmt"
                class="text-[10px] font-bold px-2 py-0.5 rounded-[6px]"
                style="background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)">
            {{ fmt }}
          </span>
        </div>
      </template>

      <input ref="fileInput" type="file" accept="audio/*" class="hidden" @change="onFileSelect" />
    </div>
  </div>
</template>
