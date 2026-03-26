<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { renderWaveform } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'
import { getTimelineDuration } from '../audio/operations.js'

const { state, peakCaches, peakCacheVersion, setSelection, setPlayhead, totalDuration } = useEditorState()

const canvas = ref(null)
const container = ref(null)
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const isSelecting = ref(false)
const selectionAnchor = ref(0)

// Max zoom level
const MAX_PPS = 2000

// Dynamic minimum PPS: zoom out no further than the full waveform fitting the canvas
function getMinPps() {
  const dur = totalDuration.value
  if (!dur || !container.value) return 10
  return Math.max(1, container.value.clientWidth / dur)
}

function draw() {
  if (!canvas.value || !state.currentFile) return

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
  if (e.button !== 0) return
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

onMounted(() => {
  draw()
  window.addEventListener('resize', draw)
  window.addEventListener('wavely:zoom-in', handleZoomIn)
  window.addEventListener('wavely:zoom-out', handleZoomOut)
  window.addEventListener('wavely:zoom-set', handleZoomSet)
})

onUnmounted(() => {
  window.removeEventListener('resize', draw)
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
    <div class="absolute inset-0 flex items-center p-6">
      <canvas
        ref="canvas"
        class="w-full h-full"
        @mousedown="handleMouseDown"
        @wheel="handleWheel"
      ></canvas>
    </div>
  </div>
</template>
