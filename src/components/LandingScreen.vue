<script setup>
import { ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { decodeAudioFile, isSupportedFormat } from '../audio/loader.js'
import { computePeakCache } from '../audio/processing.js'

const { loadFile, getAudioContext, setPeakCache, showToast } = useEditorState()

const isDragOver = ref(false)
const isLoading = ref(false)
const dragCounter = ref(0)

function onPageDragEnter(e) {
  e.preventDefault()
  dragCounter.value++
  isDragOver.value = true
}

function onPageDragLeave() {
  dragCounter.value--
  if (dragCounter.value === 0) isDragOver.value = false
}

function onPageDrop(e) {
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
    // Decode and load the audio file (critical path)
    try {
      const ctx = getAudioContext()
      audioBuffer = await decodeAudioFile(file, ctx)
      bufferId = loadFile(file.name, audioBuffer)
    } catch (err) {
      console.error('Failed to load audio file:', err)
      showToast('Failed to load audio file')
      return
    }

    // Compute peak cache in background (non-fatal if it fails)
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
  <div class="flex flex-col items-center justify-center min-h-screen px-6 py-10 relative overflow-hidden"
       style="background: linear-gradient(145deg, #EEF6FF 0%, #F5F0FF 50%, #FFF5F5 100%);"
       @dragenter="onPageDragEnter"
       @dragover.prevent
       @dragleave="onPageDragLeave"
       @drop="onPageDrop"
  >
    <!-- Decorative blobs -->
    <div class="absolute -top-[150px] -right-[100px] w-[500px] h-[500px] rounded-full pointer-events-none"
         style="background: radial-gradient(circle, rgba(255,209,102,0.3) 0%, transparent 65%);"></div>
    <div class="absolute -bottom-[100px] -left-[80px] w-[400px] h-[400px] rounded-full pointer-events-none"
         style="background: radial-gradient(circle, rgba(62,207,178,0.25) 0%, transparent 65%);"></div>

    <div class="text-center max-w-[560px] relative z-10" style="animation: bounceIn 0.6s cubic-bezier(0.34,1.56,0.64,1) both;">
      <!-- Logo -->
      <div class="inline-flex items-center gap-2.5 mb-9">
        <div class="w-11 h-11 bg-accent rounded-[16px] flex items-center justify-center shadow-[0_4px_0_var(--color-accent-dk),0_4px_16px_rgba(255,107,107,0.35)] transition-transform hover:animate-wiggle">
          <svg viewBox="0 0 20 20" class="w-[22px] h-[22px]"><path d="M3 10 Q5 4 7 10 Q9 16 11 10 Q13 4 15 10 Q17 16 19 10" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </div>
        <span class="font-heading text-[26px] font-black text-ink tracking-tight">Wavely</span>
      </div>

      <!-- Headline -->
      <h1 class="font-heading font-black leading-[1.15] tracking-tight text-ink mb-3.5"
          style="font-size: clamp(36px, 6vw, 52px);">
        Edit audio,<br>
        <em class="not-italic text-accent relative inline-block">
          beautifully simple.
          <span class="absolute bottom-0.5 left-0 right-0 h-1.5 bg-yellow rounded-full -z-1 opacity-70"></span>
        </em>
      </h1>

      <p class="text-base text-ink-mid leading-relaxed font-semibold mb-10">
        Trim, clean, and polish your audio right in the browser.<br>
        No downloads. No accounts. No complexity.
      </p>

      <!-- Drop zone -->
      <div
        class="border-3 border-dashed rounded-[var(--radius-xl)] p-[52px_40px] cursor-pointer transition-all bg-surface shadow-[0_4px_20px_rgba(45,42,62,0.10)] relative overflow-hidden group"
        :class="{ 'border-mint !shadow-[0_12px_32px_rgba(62,207,178,0.2)] -translate-y-[3px]': isDragOver, 'border-border hover:border-mint hover:-translate-y-[3px] hover:shadow-[0_12px_32px_rgba(62,207,178,0.2)]': !isDragOver }"
        @click="$refs.fileInput.click()"
      >
        <!-- Hover gradient overlay -->
        <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
             :class="{ '!opacity-100': isDragOver }"
             style="background: linear-gradient(135deg, var(--color-mint-lt), var(--color-accent-lt));"></div>

        <div class="relative z-10">
          <!-- Upload icon -->
          <div class="w-[72px] h-[72px] bg-mint-lt rounded-[22px] flex items-center justify-center mx-auto mb-5 shadow-[0_4px_0_rgba(62,207,178,0.3)] transition-all group-hover:bg-mint group-hover:shadow-[0_4px_0_#2aaa8f,0_4px_16px_rgba(62,207,178,0.35)]"
               :class="{ '!bg-mint !shadow-[0_4px_0_#2aaa8f,0_4px_16px_rgba(62,207,178,0.35)]': isDragOver }">
            <svg viewBox="0 0 24 24" class="w-8 h-8 stroke-mint group-hover:stroke-white transition-colors" :class="{ '!stroke-white': isDragOver }" stroke-width="1.8" fill="none">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
            </svg>
          </div>

          <div v-if="isLoading" class="text-center">
            <div class="font-heading text-[22px] font-extrabold text-ink mb-1.5">Loading audio...</div>
            <div class="w-48 h-2 bg-border rounded-full mx-auto overflow-hidden">
              <div class="h-full bg-mint rounded-full animate-pulse w-2/3"></div>
            </div>
          </div>

          <template v-else>
            <div class="font-heading text-[22px] font-extrabold text-ink mb-1.5">Drop your audio file here</div>
            <div class="text-sm text-ink-mid font-semibold mb-6">or click to browse your files</div>

            <button class="inline-flex items-center gap-2 bg-accent text-white font-heading text-[15px] font-extrabold px-7 py-3 rounded-full border-none cursor-pointer transition-all shadow-[0_4px_0_var(--color-accent-dk),0_4px_16px_rgba(255,107,107,0.35)] hover:-translate-y-0.5 hover:shadow-[0_6px_0_var(--color-accent-dk),0_8px_20px_rgba(255,107,107,0.4)] active:translate-y-0.5 active:shadow-[0_2px_0_var(--color-accent-dk)]"
                    @click.stop="$refs.fileInput.click()">
              <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 stroke-white fill-none stroke-2"><path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12 0c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/></svg>
              Choose audio file
            </button>

            <div class="mt-4.5 text-xs text-ink-lt font-bold">
              <span v-for="fmt in ['MP3', 'WAV', 'OGG', 'M4A', 'FLAC']" :key="fmt"
                    class="inline-block bg-bg border-2 border-border rounded-lg px-2.5 py-0.5 m-0.5 font-bold text-[11px] text-ink-mid">
                {{ fmt }}
              </span>
            </div>
          </template>
        </div>

        <input ref="fileInput" type="file" accept="audio/*" class="hidden" @change="onFileSelect" />
      </div>

      <!-- Trust row -->
      <div class="mt-7 flex items-center justify-center gap-5 text-xs text-ink-mid font-bold">
        <div class="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 stroke-mint fill-none" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Files never leave your device
        </div>
        <div class="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 stroke-mint fill-none" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
          Instant processing
        </div>
        <div class="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 stroke-mint fill-none" stroke-width="2.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
          Free forever
        </div>
      </div>
    </div>
  </div>
</template>
