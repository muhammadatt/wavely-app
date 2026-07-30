<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { renderWaveform } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'

const { state, peakCaches, peakCacheVersion, totalDuration } = useEditorState()

const strip = ref(null)
const canvas = ref(null)
const stripWidth = ref(0)

// Mirrors the main viewport's pan/zoom, kept in sync via wavely:view-update.
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const visibleDuration = ref(0)
// Pixel width of the main waveform viewport — derived from the last view
// update (visibleDuration * pixelsPerSecond) and held fixed for the duration
// of a drag gesture so resizing a handle can solve for a new pixelsPerSecond.
let mainWidthPx = 0

const MIN_VISIBLE_DURATION = 0.05 // seconds — guards against a runaway zoom

const windowLeftPct = computed(() => (totalDuration.value ? (scrollLeft.value / totalDuration.value) * 100 : 0))
const windowWidthPct = computed(() => (totalDuration.value ? Math.min(100, (visibleDuration.value / totalDuration.value) * 100) : 100))
const playheadPct = computed(() => (totalDuration.value ? (state.playhead / totalDuration.value) * 100 : 0))

function drawMini() {
  if (!canvas.value || !state.currentFile || !totalDuration.value || !stripWidth.value) return
  renderWaveform(canvas.value, {
    segments: state.segments,
    peakCaches,
    sampleRate: state.currentFile.sampleRate,
    scrollLeft: 0,
    pixelsPerSecond: stripWidth.value / totalDuration.value,
    totalDuration: totalDuration.value,
  })
}

function updateStripWidth() {
  if (strip.value) stripWidth.value = strip.value.clientWidth
}

function handleViewUpdate(e) {
  scrollLeft.value = e.detail.scrollLeft
  pixelsPerSecond.value = e.detail.pixelsPerSecond
  visibleDuration.value = e.detail.visibleDuration
  mainWidthPx = e.detail.visibleDuration * e.detail.pixelsPerSecond
}

function emitViewSet(newScrollLeft, newPixelsPerSecond) {
  window.dispatchEvent(new CustomEvent('wavely:view-set', {
    detail: { scrollLeft: newScrollLeft, pixelsPerSecond: newPixelsPerSecond },
  }))
}

function pxToSec(px) {
  return stripWidth.value ? (px / stripWidth.value) * totalDuration.value : 0
}

// --- Drag state: pan the window, or resize it from either edge ---
let dragMode = null // 'pan' | 'left' | 'right' | null
let dragStartX = 0
let dragStartScrollLeft = 0
let dragStartVisibleDuration = 0

function onWindowMouseDown(e) {
  e.stopPropagation()
  dragMode = 'pan'
  dragStartX = e.clientX
  dragStartScrollLeft = scrollLeft.value
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}

function onLeftHandleMouseDown(e) {
  e.stopPropagation()
  dragMode = 'left'
  dragStartX = e.clientX
  dragStartScrollLeft = scrollLeft.value
  dragStartVisibleDuration = visibleDuration.value
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}

function onRightHandleMouseDown(e) {
  e.stopPropagation()
  dragMode = 'right'
  dragStartX = e.clientX
  dragStartScrollLeft = scrollLeft.value
  dragStartVisibleDuration = visibleDuration.value
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}

function onDragMove(e) {
  if (!dragMode || !stripWidth.value || !totalDuration.value || !mainWidthPx) return
  const deltaSec = pxToSec(e.clientX - dragStartX)

  if (dragMode === 'pan') {
    const maxStart = Math.max(0, totalDuration.value - visibleDuration.value)
    emitViewSet(Math.max(0, Math.min(maxStart, dragStartScrollLeft + deltaSec)), pixelsPerSecond.value)
  } else if (dragMode === 'left') {
    const endTime = dragStartScrollLeft + dragStartVisibleDuration
    const newScrollLeft = Math.max(0, Math.min(endTime - MIN_VISIBLE_DURATION, dragStartScrollLeft + deltaSec))
    const newVisibleDuration = endTime - newScrollLeft
    emitViewSet(newScrollLeft, mainWidthPx / newVisibleDuration)
  } else if (dragMode === 'right') {
    const newEnd = Math.max(
      dragStartScrollLeft + MIN_VISIBLE_DURATION,
      Math.min(totalDuration.value, dragStartScrollLeft + dragStartVisibleDuration + deltaSec)
    )
    const newVisibleDuration = newEnd - dragStartScrollLeft
    emitViewSet(dragStartScrollLeft, mainWidthPx / newVisibleDuration)
  }
}

function onDragUp() {
  dragMode = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
}

// Click on the dimmed area outside the window → jump the window there,
// centered on the click, keeping the current zoom level.
function onStripMouseDown(e) {
  if (!stripWidth.value || !totalDuration.value) return
  const rect = strip.value.getBoundingClientRect()
  const clickTime = pxToSec(e.clientX - rect.left)
  const maxStart = Math.max(0, totalDuration.value - visibleDuration.value)
  emitViewSet(Math.max(0, Math.min(maxStart, clickTime - visibleDuration.value / 2)), pixelsPerSecond.value)
}

function handleResize() {
  updateStripWidth()
  drawMini()
}

watch(() => [state.segments, state.currentFile], () => drawMini(), { deep: true })
watch(peakCacheVersion, () => drawMini())

onMounted(() => {
  updateStripWidth()
  drawMini()
  window.addEventListener('resize', handleResize)
  window.addEventListener('wavely:view-update', handleViewUpdate)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('wavely:view-update', handleViewUpdate)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
})
</script>

<template>
  <div
    ref="strip"
    class="relative h-[52px] shrink-0 rounded-[10px] overflow-hidden cursor-pointer select-none"
    style="background:#080a0d;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)"
    @mousedown="onStripMouseDown"
  >
    <canvas ref="canvas" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>

    <!-- Dimmed regions outside the visible window -->
    <div class="absolute top-0 bottom-0 left-0 pointer-events-none" style="background:rgba(5,7,9,.65)" :style="{ width: windowLeftPct + '%' }"></div>
    <div class="absolute top-0 bottom-0 right-0 pointer-events-none" style="background:rgba(5,7,9,.65)" :style="{ width: (100 - windowLeftPct - windowWidthPct) + '%' }"></div>

    <!-- Draggable zoom window -->
    <div
      class="absolute top-0 bottom-0 box-border cursor-grab active:cursor-grabbing"
      style="border:1.5px solid rgba(53,211,230,.55);background:rgba(53,211,230,.06)"
      :style="{ left: windowLeftPct + '%', width: windowWidthPct + '%' }"
      @mousedown="onWindowMouseDown"
    >
      <div class="absolute -left-[4px] top-0 bottom-0 w-[8px] rounded-[3px] cursor-ew-resize" style="background:rgba(255,255,255,.6)" @mousedown="onLeftHandleMouseDown"></div>
      <div class="absolute -right-[4px] top-0 bottom-0 w-[8px] rounded-[3px] cursor-ew-resize" style="background:rgba(255,255,255,.6)" @mousedown="onRightHandleMouseDown"></div>
    </div>

    <!-- Playhead -->
    <div class="absolute top-0 bottom-0 w-[2px] pointer-events-none" style="background:#ff5a4d" :style="{ left: playheadPct + '%' }"></div>
  </div>
</template>
