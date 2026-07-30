<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { startPlayback, stopPlayback } from '../audio/playback.js'
import { getTimelineDuration } from '../audio/operations.js'

const {
  state, setPlayhead, getAudioContext, totalDuration, showToast,
} = useEditorState()

const isLooping = ref(false)
const zoomLevel = ref(0) // 0-100 range for slider; 0 = minimum zoom (fit to width)

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

  let startFrom, endAt
  if (state.selection) {
    startFrom = state.selection.start
    endAt = state.selection.end
  } else {
    startFrom = state.playhead >= totalDuration.value ? 0 : state.playhead
    endAt = null
  }

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
        state.playhead = endAt ? startFrom : 0
        play()
      }
    },
    endAt,
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

function handleViewUpdate(e) {
  // Keep slider in sync when zoom changes via scroll wheel, keyboard, or buttons
  const { pixelsPerSecond } = e.detail
  const minPPS = 10
  const maxPPS = 2000
  const t = Math.log(pixelsPerSecond / minPPS) / Math.log(maxPPS / minPPS)
  zoomLevel.value = Math.max(0, Math.min(100, t * 100))
}

onMounted(() => {
  window.addEventListener('wavely:toggle-play', handleTogglePlay)
  window.addEventListener('wavely:view-update', handleViewUpdate)
})

onUnmounted(() => {
  window.removeEventListener('wavely:toggle-play', handleTogglePlay)
  window.removeEventListener('wavely:view-update', handleViewUpdate)
})

// Stop playback when segments change (edit happened during playback)
watch(() => state.segments, () => {
  if (state.isPlaying) stop()
}, { deep: true })
</script>

<template>
  <div class="h-[76px] flex items-center px-6 gap-5 shrink-0 border-t border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0d1013)">
    <!-- Time display -->
    <div class="font-['JetBrains_Mono'] text-[26px] font-bold tabular-nums min-w-[110px] tracking-tight text-[#eaf6f8]">
      {{ formatTime(state.playhead).main }}<span class="text-[rgba(255,255,255,.4)]">{{ formatTime(state.playhead).seconds }}</span><span class="text-[rgba(255,255,255,.3)] text-[15px] font-semibold">{{ formatTime(state.playhead).ms }}</span>
    </div>

    <!-- Transport controls -->
    <div class="flex items-center gap-3 flex-1 justify-center">
      <!-- Skip to start -->
      <button
        class="w-10 h-10 rounded-full flex items-center justify-center border cursor-pointer transition-all"
        style="border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.65)"
        @click="skipToStart"
        title="Skip to Start"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
      </button>

      <!-- Skip back -->
      <button
        class="w-10 h-10 rounded-full flex items-center justify-center border cursor-pointer transition-all"
        style="border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.65)"
        @click="skipBack"
        title="Skip Back 5s"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg>
      </button>

      <!-- Play/Pause -->
      <button
        class="w-[58px] h-[58px] rounded-full flex items-center justify-center border-none cursor-pointer transition-all"
        style="color:#08161a;background:linear-gradient(180deg,#4fe0f0,#22b6cf);box-shadow:inset 0 1px 0 rgba(255,255,255,.45)"
        @click="togglePlay"
        title="Play/Pause (Space)"
      >
        <!-- Play icon -->
        <svg v-if="!state.isPlaying" viewBox="0 0 24 24" class="w-[24px] h-[24px] ml-[3px]"><polygon points="6 3 20 12 6 21 6 3" fill="#08161a"/></svg>
        <!-- Pause icon -->
        <svg v-else viewBox="0 0 24 24" class="w-[24px] h-[24px]"><rect x="6" y="4" width="4" height="16" rx="1" fill="#08161a"/><rect x="14" y="4" width="4" height="16" rx="1" fill="#08161a"/></svg>
      </button>

      <!-- Skip forward -->
      <button
        class="w-10 h-10 rounded-full flex items-center justify-center border cursor-pointer transition-all"
        style="border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.65)"
        @click="skipForward"
        title="Skip Forward 5s"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>
      </button>

      <!-- Loop -->
      <button
        class="w-10 h-10 rounded-full flex items-center justify-center border cursor-pointer transition-all"
        :style="isLooping
          ? 'border-color:rgba(53,211,230,.4);background:rgba(53,211,230,.12);color:#7fe9f6'
          : 'border-color:rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:rgba(255,255,255,.65)'"
        @click="toggleLoop"
        title="Loop"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
      </button>
    </div>

    <!-- Zoom slider -->
    <div class="flex items-center gap-[11px] min-w-[140px] justify-end">
      <span class="font-['Inter'] text-[10px] font-semibold text-[rgba(255,255,255,.4)]">Zoom</span>
      <input
        type="range"
        min="0"
        max="100"
        v-model.number="zoomLevel"
        @input="handleZoomSlider"
        class="zoom-slider w-20 h-[5px] rounded-full appearance-none cursor-pointer"
        :style="{ background: `linear-gradient(to right, #35d3e6 ${zoomLevel}%, rgba(255,255,255,.1) ${zoomLevel}%)` }"
      />
    </div>
  </div>
</template>

<style scoped>
.zoom-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #eaf6f8;
  box-shadow: 0 0 8px rgba(53, 211, 230, 0.6);
  cursor: pointer;
}
.zoom-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: #eaf6f8;
  box-shadow: 0 0 8px rgba(53, 211, 230, 0.6);
  cursor: pointer;
}
</style>
