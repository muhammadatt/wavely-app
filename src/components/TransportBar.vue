<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useTransport, installTransport } from '../composables/useTransport.js'
import { MAX_PIXELS_PER_SECOND } from '../audio/zoom.js'
import BaseButton from './ui/BaseButton.vue'

const { state, hasSelection, toggleLoop, hasFile } = useEditorState()
// Play / Stop / skip and the rules that keep playback in step with the
// timeline live in the composable, shared with the mobile shell's transport.
const { togglePlay, skipToStart, skipBack, skipForward } = useTransport()
installTransport()
const zoomLevel = ref(0) // 0-100 range for slider; 0 = fully zoomed out (fit to width)

// Zoom bounds are owned by WaveformArea — the floor is "whole file fits the
// viewport", which depends on duration and viewport width. Mirroring them here
// keeps slider position 0 meaning the same thing the waveform means by it.
// Both are replaced by the first wavely:view-update; the ceiling seeds from the
// shared constant rather than a second copy of the number.
const minPps = ref(10)
const maxPps = ref(MAX_PIXELS_PER_SECOND)

const playTitle = computed(() =>
  hasSelection.value ? 'Play selection (Space)' : 'Play/Pause (Space)'
)

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 100)
  return { main: `${m}`, seconds: `:${s.toString().padStart(2, '0')}`, ms: `.${ms.toString().padStart(2, '0')}` }
}

function handleZoomIn() {
  window.dispatchEvent(new CustomEvent('wavely:zoom-in'))
}

function handleZoomOut() {
  window.dispatchEvent(new CustomEvent('wavely:zoom-out'))
}

// The slider is dragged continuously while the waveform redraws and re-emits
// its view state, so a naive sync would fight the pointer mid-gesture.
const isDraggingZoom = ref(false)

function handleZoomSlider() {
  const t = zoomLevel.value / 100
  const pps = minPps.value * Math.pow(maxPps.value / minPps.value, t)
  window.dispatchEvent(new CustomEvent('wavely:zoom-set', { detail: { pixelsPerSecond: pps } }))
}

function handleViewUpdate(e) {
  // Keep slider in sync when zoom changes via scroll wheel, keyboard, or buttons
  const { pixelsPerSecond, minPixelsPerSecond, maxPixelsPerSecond } = e.detail
  if (Number.isFinite(minPixelsPerSecond)) minPps.value = minPixelsPerSecond
  if (Number.isFinite(maxPixelsPerSecond)) maxPps.value = maxPixelsPerSecond
  if (isDraggingZoom.value) return

  const span = maxPps.value / minPps.value
  if (!(span > 1)) {
    zoomLevel.value = 0
    return
  }
  const t = Math.log(pixelsPerSecond / minPps.value) / Math.log(span)
  zoomLevel.value = Math.max(0, Math.min(100, t * 100))
}

onMounted(() => {
  window.addEventListener('wavely:view-update', handleViewUpdate)
})

onUnmounted(() => {
  window.removeEventListener('wavely:view-update', handleViewUpdate)
})
</script>

<template>
  <!-- Three columns, 1fr / auto / 1fr: the side columns are always equal, so the
       transport sits on the bar's true centre whatever the time readout and the
       zoom block happen to measure (they used to be centred between two
       different min-widths). -->
  <div class="h-[76px] compact:h-[52px] grid grid-cols-[1fr_auto_1fr] items-center px-6 compact:px-3 gap-5 compact:gap-2 shrink-0 border-t border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0d1013)">
    <!-- Time display -->
    <div class="font-['JetBrains_Mono'] text-[26px] compact:text-[18px] font-bold tabular-nums min-w-[110px] compact:min-w-[78px] tracking-tight text-[#eaf6f8]">
      {{ formatTime(state.playhead).main }}<span class="text-[rgba(255,255,255,.4)]">{{ formatTime(state.playhead).seconds }}</span><span class="text-[rgba(255,255,255,.3)] text-[15px] compact:text-[11px] font-semibold">{{ formatTime(state.playhead).ms }}</span>
    </div>

    <!-- Transport controls -->
    <div class="flex items-center gap-3 compact:gap-[6px] justify-center">
      <!-- Skip to start -->
      <BaseButton
        size="sm" color="ghost" circle
        :disabled="!hasFile"
        @click="skipToStart"
        title="Skip to Start (Home)"
        aria-label="Skip to start"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
      </BaseButton>

      <!-- Skip back -->
      <BaseButton
        size="sm" color="ghost" circle
        :disabled="!hasFile"
        @click="skipBack"
        title="Skip Back 5s"
        aria-label="Skip back 5 seconds"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg>
      </BaseButton>

      <!-- Play/Pause — plays the selection when there is one, so the label says so -->
      <BaseButton
        size="lg" circle
        class="play-btn"
        :disabled="!hasFile"
        @click="togglePlay"
        :title="playTitle"
        :aria-label="playTitle"
      >
        <!-- Play icon -->
        <svg v-if="!state.isPlaying" viewBox="0 0 24 24" class="w-[24px] h-[24px] ml-[3px]"><polygon points="6 3 20 12 6 21 6 3" fill="#08161a"/></svg>
        <!-- Pause icon -->
        <svg v-else viewBox="0 0 24 24" class="w-[24px] h-[24px]"><rect x="6" y="4" width="4" height="16" rx="1" fill="#08161a"/><rect x="14" y="4" width="4" height="16" rx="1" fill="#08161a"/></svg>
      </BaseButton>

      <!-- Skip forward -->
      <BaseButton
        size="sm" color="ghost" circle
        :disabled="!hasFile"
        @click="skipForward"
        title="Skip Forward 5s"
        aria-label="Skip forward 5 seconds"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>
      </BaseButton>

      <!-- Loop -->
      <BaseButton
        size="sm" circle toggle :active="state.isLooping"
        color="accent" accent="rgba(53,211,230,.14)" text-color="#7fe9f6"
        :disabled="!hasFile"
        @click="toggleLoop"
        title="Loop"
        aria-label="Loop playback"
      >
    
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m2 9 3-3 3 3" /><path d="M13 18H7a2 2 0 0 1-2-2V6" /><path d="m22 15-3 3-3-3" /><path d="M11 6h6a2 2 0 0 1 2 2v10" /></svg>
    
      </BaseButton>
    </div>

    <!-- Zoom controls -->
    <!-- Hidden outright on a phone held upright (max-sm): there is no width
         for it beside the transport, and pinch zooms the waveform. -->
    <div class="flex items-center gap-[11px] compact:min-w-0 max-sm:hidden justify-end col-start-3">
      <span class="compact:hidden font-['Inter'] text-[10px] font-semibold text-[rgba(255,255,255,.4)]">Zoom</span>
      <input
        type="range"
        min="0"
        max="100"
        v-model.number="zoomLevel"
        @input="handleZoomSlider"
        @pointerdown="isDraggingZoom = true"
        @pointerup="isDraggingZoom = false"
        @pointercancel="isDraggingZoom = false"
        @blur="isDraggingZoom = false"
        :disabled="!hasFile"
        aria-label="Zoom"
        class="zoom-slider compact:hidden w-20 h-[5px] rounded-full appearance-none cursor-pointer"
        :style="{ background: `linear-gradient(to right, #35d3e6 ${zoomLevel}%, rgba(255,255,255,.1) ${zoomLevel}%)` }"
      />
      <div class="flex items-center gap-1 shrink-0">
                <BaseButton
          size="xs" color="ghost" square
          :disabled="!hasFile"
          @click="handleZoomOut"
          title="Zoom Out (-)"
          aria-label="Zoom out"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </BaseButton>
        <BaseButton
          size="xs" color="ghost" square
          :disabled="!hasFile"
          @click="handleZoomIn"
          title="Zoom In (+)"
          aria-label="Zoom in"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
        </BaseButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Compact: the 58 px play button is most of a 52 px bar. Important because
   BaseButton sets its diameter inline. */
@media (max-height: 520px), (max-width: 640px) {
  .play-btn {
    width: 44px !important;
    height: 44px !important;
  }
}
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
