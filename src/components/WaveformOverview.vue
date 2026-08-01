<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { renderWaveform } from '../audio/renderer.js'
import { MAX_PIXELS_PER_SECOND } from '../audio/zoom.js'
import { useEditorState } from '../composables/useEditorState.js'

const { state, peakCaches, peakCacheVersion, totalDuration } = useEditorState()

const strip = ref(null)
const canvas = ref(null)
const stripWidth = ref(0)

// Mirrors the main viewport's pan/zoom, kept in sync via wavely:view-update.
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const visibleDuration = ref(0)
// Pixel width of the main waveform viewport, sent with each view update. The
// resize handles solve for a new pixelsPerSecond from it.
let viewportWidthPx = 0
// The viewport's zoom ceiling, mirrored from the view update. Seeded from the
// shared constant so the very first drag — before any update has arrived — is
// bounded by the same number.
let maxPps = MAX_PIXELS_PER_SECOND

// The narrowest window the viewport will actually honour. Deriving it from the
// zoom ceiling rather than a local constant is what keeps a handle drag from
// running past the point where the viewport clamps: it used to allow 0.05s,
// which asks for roughly 16000 px/s, and the clamped value bounced straight
// back through view-update and snapped the window out from under the cursor.
function minVisibleDuration() {
  return viewportWidthPx && maxPps ? viewportWidthPx / maxPps : 0
}

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
    showTimeGrid: false,
  })
}

function updateStripWidth() {
  if (strip.value) stripWidth.value = strip.value.clientWidth
}

function handleViewUpdate(e) {
  scrollLeft.value = e.detail.scrollLeft
  pixelsPerSecond.value = e.detail.pixelsPerSecond
  visibleDuration.value = e.detail.visibleDuration
  viewportWidthPx = e.detail.viewportWidthPx
  if (Number.isFinite(e.detail.maxPixelsPerSecond)) maxPps = e.detail.maxPixelsPerSecond
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
  if (!dragMode || !stripWidth.value || !totalDuration.value || !viewportWidthPx) return
  const deltaSec = pxToSec(e.clientX - dragStartX)
  const minVisible = minVisibleDuration()

  if (dragMode === 'pan') {
    const maxStart = Math.max(0, totalDuration.value - visibleDuration.value)
    emitViewSet(Math.max(0, Math.min(maxStart, dragStartScrollLeft + deltaSec)), pixelsPerSecond.value)
  } else if (dragMode === 'left') {
    const endTime = dragStartScrollLeft + dragStartVisibleDuration
    const newScrollLeft = Math.max(0, Math.min(endTime - minVisible, dragStartScrollLeft + deltaSec))
    const newVisibleDuration = endTime - newScrollLeft
    emitViewSet(newScrollLeft, viewportWidthPx / newVisibleDuration)
  } else if (dragMode === 'right') {
    const newEnd = Math.max(
      dragStartScrollLeft + minVisible,
      Math.min(totalDuration.value, dragStartScrollLeft + dragStartVisibleDuration + deltaSec)
    )
    const newVisibleDuration = newEnd - dragStartScrollLeft
    emitViewSet(dragStartScrollLeft, viewportWidthPx / newVisibleDuration)
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

// Same reason as the main waveform: the context panel changes this strip's
// width without the window ever resizing. It covers window resizes too, so
// there is no separate window 'resize' listener.
let resizeObserver = null

onMounted(() => {
  updateStripWidth()
  drawMini()
  if (typeof ResizeObserver !== 'undefined' && strip.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(strip.value)
  }
  window.addEventListener('wavely:view-update', handleViewUpdate)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('wavely:view-update', handleViewUpdate)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
})
</script>

<template>
  <div
    ref="strip"
    class="relative h-[52px] shrink-0 rounded-[10px] cursor-pointer select-none"
    style="background:#080a0d;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)"
    @mousedown="onStripMouseDown"
  >
    <!-- The canvas carries its own radius instead of the strip clipping to it:
         the resize handles straddle the window edge, and at either extreme of
         the file that put half a handle outside a clipping parent. -->
    <canvas ref="canvas" class="absolute inset-0 w-full h-full rounded-[10px] pointer-events-none"></canvas>

    <!-- Dimmed regions outside the visible window -->
    <div class="absolute top-0 bottom-0 left-0 pointer-events-none" style="background:rgba(5,7,9,.65)" :style="{ width: windowLeftPct + '%' }"></div>
    <div class="absolute top-0 bottom-0 right-0 pointer-events-none" style="background:rgba(5,7,9,.65)" :style="{ width: (100 - windowLeftPct - windowWidthPct) + '%' }"></div>

    <!-- Draggable zoom window. The body pans the view; the edges resize it,
         which is the zoom. Neither is guessable from a plain translucent bar,
         so the handles carry a grip and both halves carry a tooltip. -->
    <div
      class="zoom-window absolute top-0 bottom-0 box-border cursor-grab active:cursor-grabbing"
      :style="{ left: windowLeftPct + '%', width: windowWidthPct + '%' }"
      title="Drag to scroll the waveform"
      @mousedown="onWindowMouseDown"
    >
      <div
        class="ov-handle absolute -left-[7px] top-0 bottom-0 w-[14px] flex items-center justify-center cursor-ew-resize"
        title="Drag to zoom"
        @mousedown="onLeftHandleMouseDown"
      >
        <span class="ov-grip"></span>
      </div>
      <div
        class="ov-handle absolute -right-[7px] top-0 bottom-0 w-[14px] flex items-center justify-center cursor-ew-resize"
        title="Drag to zoom"
        @mousedown="onRightHandleMouseDown"
      >
        <span class="ov-grip"></span>
      </div>
    </div>

    <!-- Playhead -->
    <div class="absolute top-0 bottom-0 w-[2px] pointer-events-none" style="background:#ff5a4d" :style="{ left: playheadPct + '%' }"></div>
  </div>
</template>

<style scoped>
.zoom-window {
  border: 1.5px solid rgba(126, 240, 255, 0.75);
  background: rgba(53, 211, 230, 0.07);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.zoom-window:hover {
  background: rgba(53, 211, 230, 0.12);
  border-color: rgba(126, 240, 255, 0.95);
}

/* The grip is a slim pill with two ridges — small enough not to cover the
   waveform underneath, distinct enough to read as a control rather than an
   edge of the highlight. */
.ov-grip {
  width: 6px;
  height: 26px;
  border-radius: 3px;
  background: #cbf5fd;
  box-shadow:
    0 0 0 1px rgba(8, 22, 26, 0.55),
    0 1px 4px rgba(0, 0, 0, 0.5);
  background-image: linear-gradient(
    to right,
    transparent 1.5px,
    rgba(8, 22, 26, 0.45) 1.5px 2.5px,
    transparent 2.5px 3.5px,
    rgba(8, 22, 26, 0.45) 3.5px 4.5px,
    transparent 4.5px
  );
  transition: height 0.15s ease, background-color 0.15s ease;
}
.ov-handle:hover .ov-grip,
.ov-handle:active .ov-grip {
  height: 36px;
  background-color: #ffffff;
}
</style>
