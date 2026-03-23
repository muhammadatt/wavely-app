<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { startPlayback, stopPlayback } from '../audio/playback.js'
import { getTimelineDuration } from '../audio/operations.js'

const {
  state, setPlayhead, getAudioContext, totalDuration, showToast,
} = useEditorState()

const isLooping = ref(false)
const zoomLevel = ref(50) // 0-100 range for slider

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return { main: `${m}`, seconds: `:${s.toString().padStart(2, '0')}`, ms: `.${ms.toString().padStart(2, '0')}` }
}

function togglePlay() {
  if (state.isPlaying) {
    stop()
  } else {
    play()
  }
}

function play() {
  const ctx = getAudioContext()
  state.isPlaying = true

  const startFrom = state.playhead >= totalDuration.value ? 0 : state.playhead

  startPlayback(
    state.segments,
    startFrom,
    ctx,
    (time) => {
      state.playhead = time
    },
    () => {
      state.isPlaying = false
      if (isLooping.value) {
        state.playhead = 0
        play()
      }
    }
  )
}

function stop() {
  stopPlayback()
  state.isPlaying = false
}

function skipToStart() {
  if (state.isPlaying) stop()
  setPlayhead(0)
}

function skipBack() {
  if (state.isPlaying) stop()
  setPlayhead(Math.max(0, state.playhead - 5))
}

function skipForward() {
  if (state.isPlaying) stop()
  setPlayhead(Math.min(totalDuration.value, state.playhead + 5))
}

function toggleLoop() {
  isLooping.value = !isLooping.value
}

function handleTogglePlay() {
  togglePlay()
}

function handleZoomSlider() {
  // Map 0-100 to pixelsPerSecond range (10-2000) using exponential scale
  const minPPS = 10
  const maxPPS = 2000
  const t = zoomLevel.value / 100
  const pps = minPPS * Math.pow(maxPPS / minPPS, t)
  window.dispatchEvent(new CustomEvent('wavely:zoom-set', { detail: { pixelsPerSecond: pps } }))
}

onMounted(() => {
  window.addEventListener('wavely:toggle-play', handleTogglePlay)
})

onUnmounted(() => {
  window.removeEventListener('wavely:toggle-play', handleTogglePlay)
})

// Stop playback when segments change (edit happened during playback)
watch(() => state.segments, () => {
  if (state.isPlaying) stop()
}, { deep: true })
</script>

<template>
  <div class="h-[76px] bg-surface border-t-2 border-border flex items-center px-5 gap-6 shrink-0">
    <!-- Time display -->
    <div class="font-heading text-[32px] font-black text-ink tabular-nums min-w-[140px]">
      {{ formatTime(state.playhead).main }}<span class="text-ink-mid">{{ formatTime(state.playhead).seconds }}</span><span class="text-ink-lt text-lg">{{ formatTime(state.playhead).ms }}</span>
    </div>

    <!-- Transport controls -->
    <div class="flex items-center gap-1.5">
      <!-- Skip to start -->
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink"
        @click="skipToStart"
        title="Skip to Start"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
      </button>

      <!-- Skip back -->
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink"
        @click="skipBack"
        title="Skip Back 5s"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg>
      </button>

      <!-- Play/Pause -->
      <button
        class="w-12 h-12 rounded-full flex items-center justify-center border-none cursor-pointer transition-all shadow-[0_4px_0_var(--color-accent-dk),0_4px_16px_rgba(255,107,107,0.35)] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_2px_0_var(--color-accent-dk)]"
        :class="state.isPlaying ? 'bg-accent-dk' : 'bg-accent'"
        @click="togglePlay"
        title="Play/Pause (Space)"
      >
        <!-- Play icon -->
        <svg v-if="!state.isPlaying" viewBox="0 0 24 24" class="w-5 h-5"><polygon points="6 3 20 12 6 21 6 3" fill="white"/></svg>
        <!-- Pause icon -->
        <svg v-else viewBox="0 0 24 24" class="w-5 h-5"><rect x="6" y="4" width="4" height="16" rx="1" fill="white"/><rect x="14" y="4" width="4" height="16" rx="1" fill="white"/></svg>
      </button>

      <!-- Skip forward -->
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all bg-transparent text-ink-mid hover:bg-bg hover:text-ink"
        @click="skipForward"
        title="Skip Forward 5s"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>
      </button>

      <!-- Loop -->
      <button
        class="w-9 h-9 rounded-xl flex items-center justify-center border-none cursor-pointer transition-all"
        :class="isLooping ? 'bg-mint-lt text-mint' : 'bg-transparent text-ink-mid hover:bg-bg hover:text-ink'"
        @click="toggleLoop"
        title="Loop"
      >
        <svg viewBox="0 0 24 24" class="w-[18px] h-[18px] fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
      </button>
    </div>

    <!-- Spacer -->
    <div class="flex-1"></div>

    <!-- Zoom slider -->
    <div class="flex items-center gap-2 text-ink-lt text-xs font-bold">
      <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      <input
        type="range"
        min="0"
        max="100"
        v-model.number="zoomLevel"
        @input="handleZoomSlider"
        class="w-24 h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent"
      />
      <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
    </div>
  </div>
</template>
