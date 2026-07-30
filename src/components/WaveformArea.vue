<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { renderWaveform, renderOverlay } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'

const { state, peakCaches, peakCacheVersion, setSelection, setPlayhead, totalDuration } = useEditorState()

const canvas = ref(null)
const overlayCanvas = ref(null)
const container = ref(null)
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const isSelecting = ref(false)
const selectionAnchor = ref(0)
const containerWidth = ref(0)

// Max zoom level
const MAX_PPS = 2000
// One step, shared by the zoom buttons and the keyboard shortcuts, so the three
// zoom entry points move at a predictable rate.
const ZOOM_STEP = 1.3
// The wheel is continuous, so it steps finer than a discrete button press.
const WHEEL_ZOOM_STEP = 1.1

// Dynamic minimum PPS: zoom out no further than the full waveform fitting the canvas.
// Use containerWidth (which tracks canvas.clientWidth) so this matches the renderer exactly.
function getMinPps() {
  const dur = totalDuration.value
  if (!dur || containerWidth.value === 0) return 10
  return Math.max(1, containerWidth.value / dur)
}

function updateContainerWidth() {
  // canvas.clientWidth is the exact width the renderer draws into; the
  // container is only a fallback for the first tick, before layout settles.
  if (canvas.value && canvas.value.clientWidth > 0) {
    containerWidth.value = canvas.value.clientWidth
  } else if (container.value) {
    containerWidth.value = container.value.clientWidth
  }
}

const maxScrollLeft = computed(() =>
  Math.max(0, totalDuration.value - containerWidth.value / pixelsPerSecond.value)
)

function drawMain() {
  if (!canvas.value || !state.currentFile) return

  // Keep containerWidth in sync with the actual canvas size before any scroll/zoom calculation
  updateContainerWidth()

  renderWaveform(canvas.value, {
    segments: state.segments,
    peakCaches,
    sampleRate: state.currentFile.sampleRate,
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    totalDuration: totalDuration.value,
  })

  // Notify other components of view state. The zoom bounds travel with it so
  // the transport's slider can map its track onto the range that actually
  // exists for this file and viewport, rather than a hardcoded guess.
  window.dispatchEvent(new CustomEvent('wavely:view-update', {
    detail: {
      scrollLeft: scrollLeft.value,
      pixelsPerSecond: pixelsPerSecond.value,
      visibleDuration: containerWidth.value / pixelsPerSecond.value,
      minPixelsPerSecond: getMinPps(),
      maxPixelsPerSecond: MAX_PPS,
    },
  }))
}

function drawOverlay() {
  if (!overlayCanvas.value || !state.currentFile) return
  renderOverlay(overlayCanvas.value, {
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    selection: state.selection,
    playhead: state.playhead,
  })
}

function drawAll() {
  drawMain()
  drawOverlay()
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
  drawOverlay() // Peaks unchanged during selection drag — overlay only
}

function handleMouseUp() {
  isSelecting.value = false
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
}

function handleWheel(e) {
  e.preventDefault()

  // Ctrl/Meta + wheel → zoom, anchored at the pointer. Plain wheel pans, which
  // is what a two-finger trackpad scroll — the most common gesture over this
  // surface — should do; it used to zoom instead.
  if ((e.ctrlKey || e.metaKey) && e.deltaY !== 0) {
    const zoomFactor = e.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP
    const rect = canvas.value.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const timeAtMouse = pxToTime(mouseX)

    pixelsPerSecond.value = Math.max(getMinPps(), Math.min(MAX_PPS, pixelsPerSecond.value * zoomFactor))

    // Keep the time under the mouse cursor stable
    scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, timeAtMouse - mouseX / pixelsPerSecond.value))
    drawAll()
    return
  }

  // Otherwise pan, taking whichever axis the device reports.
  const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
  if (delta === 0) return
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, scrollLeft.value + delta / pixelsPerSecond.value))
  drawAll()
}

function clampScroll() {
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, scrollLeft.value))
}

function handleZoomIn() {
  pixelsPerSecond.value = Math.min(MAX_PPS, pixelsPerSecond.value * ZOOM_STEP)
  clampScroll()
  drawAll()
}

function handleZoomOut() {
  pixelsPerSecond.value = Math.max(getMinPps(), pixelsPerSecond.value / ZOOM_STEP)
  clampScroll()
  drawAll()
}

function handleZoomSet(e) {
  pixelsPerSecond.value = Math.max(getMinPps(), Math.min(MAX_PPS, e.detail.pixelsPerSecond))
  clampScroll()
  drawAll()
}

// Sets pan + zoom together (from the overview strip's drag/resize handles) so
// the two never briefly disagree — e.g. a stale scrollLeft clamped against
// the old pixelsPerSecond for one frame.
function handleViewSet(e) {
  pixelsPerSecond.value = Math.max(getMinPps(), Math.min(MAX_PPS, e.detail.pixelsPerSecond))
  const newMaxScroll = Math.max(0, totalDuration.value - containerWidth.value / pixelsPerSecond.value)
  scrollLeft.value = Math.max(0, Math.min(newMaxScroll, e.detail.scrollLeft))
  drawAll()
}

// Waveform content changed → redraw everything
watch(
  () => [state.segments, state.currentFile],
  () => drawAll(),
  { deep: true }
)

// Selection or playhead changed externally (e.g. toolbar operations, click-to-seek)
// → overlay only; peaks are unchanged
watch(() => state.selection, () => drawOverlay(), { deep: true })
watch(() => state.playhead, () => drawOverlay())

// Peak cache updated → redraw main canvas only (overlay positions are unchanged)
watch(peakCacheVersion, () => drawMain())

// scrollLeft is always changed by an event handler that already calls drawAll(),
// so no separate watch is needed here.

function handleResize() {
  updateContainerWidth()
  clampScroll()
  drawAll()
}

// The window is not the only thing that resizes this canvas — opening or
// closing the context panel changes its width too, and without this the
// bitmap kept its old width and the waveform rendered stretched, with peaks
// no longer above the time grid they belong to.
let resizeObserver = null

onMounted(() => {
  updateContainerWidth()
  drawAll()
  if (typeof ResizeObserver !== 'undefined' && container.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container.value)
  }
  window.addEventListener('resize', handleResize)
  window.addEventListener('wavely:zoom-in', handleZoomIn)
  window.addEventListener('wavely:zoom-out', handleZoomOut)
  window.addEventListener('wavely:zoom-set', handleZoomSet)
  window.addEventListener('wavely:view-set', handleViewSet)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('wavely:zoom-in', handleZoomIn)
  window.removeEventListener('wavely:zoom-out', handleZoomOut)
  window.removeEventListener('wavely:zoom-set', handleZoomSet)
  window.removeEventListener('wavely:view-set', handleViewSet)
})
</script>

<template>
  <div
    ref="container"
    class="flex-1 relative overflow-hidden cursor-crosshair min-h-[120px]"
  >
    <div class="absolute inset-0">
      <!-- Both canvases are absolute inset-0 so they occupy the same compositing
           layer space. Main canvas draws waveform peaks; overlay canvas draws
           selection highlight + playhead. pointer-events-none lets mouse events
           fall through to the main canvas. -->
      <canvas
        ref="canvas"
        class="absolute inset-0 w-full h-full"
        @mousedown="handleMouseDown"
        @wheel="handleWheel"
      ></canvas>
      <canvas
        ref="overlayCanvas"
        class="absolute inset-0 w-full h-full pointer-events-none"
      ></canvas>
    </div>
  </div>
</template>
