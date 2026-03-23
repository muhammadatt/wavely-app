<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { renderWaveform } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'
import { getTimelineDuration } from '../audio/operations.js'

const { state, peakCaches, setSelection, setPlayhead, totalDuration } = useEditorState()

const canvas = ref(null)
const container = ref(null)
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const isSelecting = ref(false)
const selectionAnchor = ref(0)

// Min/max zoom levels
const MIN_PPS = 10
const MAX_PPS = 2000

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
  if (e.ctrlKey || e.metaKey) {
    // Zoom
    e.preventDefault()
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
    const rect = canvas.value.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const timeAtMouse = pxToTime(mouseX)

    pixelsPerSecond.value = Math.max(MIN_PPS, Math.min(MAX_PPS, pixelsPerSecond.value * zoomFactor))

    // Keep the time under the mouse stable
    scrollLeft.value = timeAtMouse - mouseX / pixelsPerSecond.value
    scrollLeft.value = Math.max(0, scrollLeft.value)
    draw()
  } else {
    // Scroll
    const scrollAmount = e.deltaX !== 0 ? e.deltaX : e.deltaY
    scrollLeft.value = Math.max(0, scrollLeft.value + scrollAmount / pixelsPerSecond.value)
    draw()
  }
}

function handleZoomIn() {
  pixelsPerSecond.value = Math.min(MAX_PPS, pixelsPerSecond.value * 1.3)
  draw()
}

function handleZoomOut() {
  pixelsPerSecond.value = Math.max(MIN_PPS, pixelsPerSecond.value / 1.3)
  draw()
}

function handleZoomSet(e) {
  pixelsPerSecond.value = Math.max(MIN_PPS, Math.min(MAX_PPS, e.detail.pixelsPerSecond))
  draw()
}

// Watch for state changes that require redraw
watch(
  () => [state.segments, state.selection, state.playhead, state.currentFile],
  () => draw(),
  { deep: true }
)

// Also watch peakCaches directly so waveform updates when peaks are computed
watch(
  () => peakCaches,
  () => draw(),
  { deep: true }
)

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
    class="flex-1 bg-surface relative overflow-hidden cursor-crosshair min-h-[120px]"
  >
    <canvas
      ref="canvas"
      class="w-full h-full"
      @mousedown="handleMouseDown"
      @wheel="handleWheel"
    ></canvas>
  </div>
</template>
