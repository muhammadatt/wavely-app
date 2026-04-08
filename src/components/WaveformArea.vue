<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { renderWaveform } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'

const { state, peakCaches, peakCacheVersion, setSelection, setPlayhead, totalDuration } = useEditorState()

const canvas = ref(null)
const container = ref(null)
const scrollbarTrack = ref(null)
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const isSelecting = ref(false)
const selectionAnchor = ref(0)
const containerWidth = ref(0)

// Max zoom level
const MAX_PPS = 2000

// Dynamic minimum PPS: zoom out no further than the full waveform fitting the canvas.
// Use containerWidth (which tracks canvas.clientWidth) so this matches the renderer exactly.
function getMinPps() {
  const dur = totalDuration.value
  if (!dur || containerWidth.value === 0) return 10
  return Math.max(1, containerWidth.value / dur)
}

function updateContainerWidth() {
  // Use canvas.clientWidth — this is the exact width the renderer draws into,
  // which is smaller than container.clientWidth by the inner div's padding (p-6 = 24px each side).
  if (canvas.value && canvas.value.clientWidth > 0) {
    containerWidth.value = canvas.value.clientWidth
  } else if (container.value) {
    containerWidth.value = container.value.clientWidth - 48
  }
}

// Scrollbar computed values
const totalContentWidth = computed(() => totalDuration.value * pixelsPerSecond.value)
const isScrollable = computed(() =>
  containerWidth.value > 0 && totalContentWidth.value > containerWidth.value
)
const thumbWidthPct = computed(() => {
  if (!totalContentWidth.value || containerWidth.value === 0) return 100
  return Math.min(100, Math.max(5, (containerWidth.value / totalContentWidth.value) * 100))
})
const maxScrollLeft = computed(() =>
  Math.max(0, totalDuration.value - containerWidth.value / pixelsPerSecond.value)
)
const thumbLeftPct = computed(() => {
  if (maxScrollLeft.value <= 0) return 0
  return (scrollLeft.value / maxScrollLeft.value) * (100 - thumbWidthPct.value)
})

// Scrollbar drag state
let sbDragging = false
let sbDragStartX = 0
let sbDragStartScroll = 0

function handleScrollbarMouseDown(e) {
  if (e.button !== 0 || !isScrollable.value) return
  sbDragging = true
  sbDragStartX = e.clientX
  sbDragStartScroll = scrollLeft.value
  window.addEventListener('mousemove', handleScrollbarMouseMove)
  window.addEventListener('mouseup', handleScrollbarMouseUp)
  e.preventDefault()
  e.stopPropagation()
}

function handleScrollbarMouseMove(e) {
  if (!sbDragging || !scrollbarTrack.value) return
  const dx = e.clientX - sbDragStartX
  const trackWidth = scrollbarTrack.value.clientWidth
  const thumbMovable = trackWidth * (1 - thumbWidthPct.value / 100)
  if (thumbMovable <= 0) return
  const delta = (dx / thumbMovable) * maxScrollLeft.value
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, sbDragStartScroll + delta))
  draw()
}

function handleScrollbarMouseUp() {
  sbDragging = false
  window.removeEventListener('mousemove', handleScrollbarMouseMove)
  window.removeEventListener('mouseup', handleScrollbarMouseUp)
}

function draw() {
  if (!canvas.value || !state.currentFile) return

  // Keep containerWidth in sync with the actual canvas size before any scroll/zoom calculation
  updateContainerWidth()

  renderWaveform(canvas.value, {
    segments: state.segments,
    peakCaches,
    sampleRate: state.currentFile.sampleRate,
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    selection: state.selection,
    playhead: state.playhead,
    totalDuration: totalDuration.value,
  })

  // Notify other components of view state
  window.dispatchEvent(new CustomEvent('wavely:view-update', {
    detail: {
      scrollLeft: scrollLeft.value,
      pixelsPerSecond: pixelsPerSecond.value,
    },
  }))
}

// Convert pixel X to timeline seconds
function pxToTime(px) {
  return scrollLeft.value + px / pixelsPerSecond.value
}

function handleMouseDown(e) {
  if (e.button !== 0 || sbDragging) return
  const rect = canvas.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = pxToTime(x)

  isSelecting.value = true
  selectionAnchor.value = time
  setPlayhead(time)
  setSelection(time, time) // Clear / start fresh

  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
}

function handleMouseMove(e) {
  if (!isSelecting.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = Math.max(0, Math.min(pxToTime(x), totalDuration.value))

  setSelection(selectionAnchor.value, time)
  draw()
}

function handleMouseUp() {
  isSelecting.value = false
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
}

function handleWheel(e) {
  e.preventDefault()

  if (e.deltaX !== 0 && !e.shiftKey) {
    // Horizontal trackpad scroll → pan
    scrollLeft.value = Math.max(0, scrollLeft.value + e.deltaX / pixelsPerSecond.value)
    draw()
  } else if (e.shiftKey && e.deltaY !== 0) {
    // Shift + vertical scroll → pan
    scrollLeft.value = Math.max(0, scrollLeft.value + e.deltaY / pixelsPerSecond.value)
    draw()
  } else if (e.deltaY !== 0) {
    // Vertical scroll (plain or Ctrl/Meta) → zoom, anchored at mouse position
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
    const rect = canvas.value.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const timeAtMouse = pxToTime(mouseX)

    const minPps = getMinPps()
    pixelsPerSecond.value = Math.max(minPps, Math.min(MAX_PPS, pixelsPerSecond.value * zoomFactor))

    // Keep the time under the mouse cursor stable
    scrollLeft.value = Math.max(0, timeAtMouse - mouseX / pixelsPerSecond.value)
    draw()
  }
}

function handleZoomIn() {
  pixelsPerSecond.value = Math.min(MAX_PPS, pixelsPerSecond.value * 1.3)
  draw()
}

function handleZoomOut() {
  pixelsPerSecond.value = Math.max(getMinPps(), pixelsPerSecond.value / 1.3)
  draw()
}

function handleZoomSet(e) {
  pixelsPerSecond.value = Math.max(getMinPps(), Math.min(MAX_PPS, e.detail.pixelsPerSecond))
  draw()
}

// Watch for state changes that require redraw
watch(
  () => [state.segments, state.selection, state.playhead, state.currentFile],
  () => draw(),
  { deep: true }
)

// Watch peakCacheVersion so waveform redraws when a new peak cache is stored
watch(peakCacheVersion, () => draw())

function handleResize() {
  updateContainerWidth()
  draw()
}

onMounted(() => {
  updateContainerWidth()
  draw()
  window.addEventListener('resize', handleResize)
  window.addEventListener('wavely:zoom-in', handleZoomIn)
  window.addEventListener('wavely:zoom-out', handleZoomOut)
  window.addEventListener('wavely:zoom-set', handleZoomSet)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('wavely:zoom-in', handleZoomIn)
  window.removeEventListener('wavely:zoom-out', handleZoomOut)
  window.removeEventListener('wavely:zoom-set', handleZoomSet)
})
</script>

<template>
  <div
    ref="container"
    class="flex-1 relative overflow-hidden cursor-crosshair min-h-[120px]"
  >
    <div class="absolute inset-0 flex items-center pb-2">
      <canvas
        ref="canvas"
        class="w-full h-full"
        @mousedown="handleMouseDown"
        @wheel="handleWheel"
      ></canvas>
    </div>

    <!-- Scrollbar — always visible; full-width thumb when not zoomed in -->
    <div
      ref="scrollbarTrack"
      class="absolute bottom-0 left-0 right-0 h-2 bg-ink/10"
    >
      <div
        class="absolute top-0 h-full rounded-full bg-ink-mid/40 transition-colors"
        :class="isScrollable ? 'hover:bg-ink-mid/65 cursor-grab' : ''"
        :style="{ left: thumbLeftPct + '%', width: thumbWidthPct + '%' }"
        @mousedown="handleScrollbarMouseDown"
      ></div>
    </div>
  </div>
</template>
