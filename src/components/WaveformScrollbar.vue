<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'

/**
 * Horizontal scrollbar for the waveform viewport.
 *
 * Panning used to be reachable only from the overview strip above the waveform,
 * which is a long way from where the eye is once you're zoomed in on a word.
 * This is the ordinary control for the job, sitting directly under the canvas it
 * scrolls.
 *
 * "Auto resize" is the whole behaviour: the thumb is the visible window drawn to
 * scale, so it shrinks as the user zooms in and fills the track when the file
 * fits. Fully zoomed out there is nothing to scroll, so the thumb is hidden and
 * the track stays as an empty rail — the row keeps its height either way, so
 * zooming never shifts the waveform's box under the cursor.
 *
 * State flows the same way as the overview strip's: view geometry arrives on
 * wavely:view-update, and changes go back out on wavely:scroll-set for
 * WaveformArea to clamp and apply. This component never owns the scroll
 * position, so it cannot disagree with the viewport.
 */

const { totalDuration } = useEditorState()

const track = ref(null)
const trackWidth = ref(0)
const scrollLeft = ref(0)
const visibleDuration = ref(0)
const isDragging = ref(false)

// Small enough to grab reliably at any zoom. Below this the thumb stops
// shrinking, so its width no longer maps linearly onto the visible fraction —
// the arithmetic below works in "free track" terms to stay exact regardless.
const MIN_THUMB_PX = 28

const scrollable = computed(() =>
  totalDuration.value > 0 && visibleDuration.value > 0 &&
  visibleDuration.value < totalDuration.value - 1e-6
)

const thumbWidthPx = computed(() => {
  if (!scrollable.value || !trackWidth.value) return 0
  const frac = visibleDuration.value / totalDuration.value
  return Math.max(MIN_THUMB_PX, Math.min(trackWidth.value, trackWidth.value * frac))
})

/** Track pixels the thumb can travel across. */
const freeTrackPx = computed(() => Math.max(0, trackWidth.value - thumbWidthPx.value))

/** Seconds of timeline the viewport can travel across. */
const maxScrollLeft = computed(() => Math.max(0, totalDuration.value - visibleDuration.value))

const thumbLeftPx = computed(() => {
  if (!maxScrollLeft.value || !freeTrackPx.value) return 0
  const ratio = Math.min(1, Math.max(0, scrollLeft.value / maxScrollLeft.value))
  return ratio * freeTrackPx.value
})

function emitScroll(seconds) {
  window.dispatchEvent(new CustomEvent('wavely:scroll-set', {
    detail: { scrollLeft: Math.max(0, Math.min(maxScrollLeft.value, seconds)) },
  }))
}

/** Thumb pixel offset → timeline seconds, the inverse of thumbLeftPx. */
function pxToScroll(px) {
  if (!freeTrackPx.value) return 0
  return (px / freeTrackPx.value) * maxScrollLeft.value
}

// ── Thumb drag ───────────────────────────────────────────────────────────────
let dragStartX = 0
let dragStartLeftPx = 0

// `startLeftPx` is where the thumb is being dragged *from*. It defaults to the
// thumb's current position, but a track click passes the position it just
// jumped to: the view update carrying that jump has not arrived yet, so reading
// thumbLeftPx here would anchor the drag to the pre-jump position and the thumb
// would snap back on the first mouse move.
function onThumbMouseDown(e, startLeftPx = thumbLeftPx.value) {
  if (e.button !== 0 || !scrollable.value) return
  e.preventDefault()
  e.stopPropagation()
  isDragging.value = true
  dragStartX = e.clientX
  dragStartLeftPx = startLeftPx
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragUp)
}

function onDragMove(e) {
  if (!isDragging.value) return
  emitScroll(pxToScroll(dragStartLeftPx + (e.clientX - dragStartX)))
}

function onDragUp() {
  isDragging.value = false
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragUp)
}

// Clicking the track centres the window on the click rather than paging toward
// it: at these zoom levels a page step can take several clicks to cross a long
// file, and the position clicked is where the user wants to be.
function onTrackMouseDown(e) {
  if (e.button !== 0 || !scrollable.value || !track.value) return
  const rect = track.value.getBoundingClientRect()
  const targetPx = Math.max(0, Math.min(
    freeTrackPx.value,
    e.clientX - rect.left - thumbWidthPx.value / 2
  ))
  emitScroll(pxToScroll(targetPx))
  // Continue as a drag from where it landed, so click-then-drag is one gesture.
  onThumbMouseDown(e, targetPx)
}

function handleViewUpdate(e) {
  scrollLeft.value = e.detail.scrollLeft
  visibleDuration.value = e.detail.visibleDuration
}

function measure() {
  if (track.value) trackWidth.value = track.value.clientWidth
}

let resizeObserver = null

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && track.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(track.value)
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
    ref="track"
    class="relative h-[11px] shrink-0 select-none border-t border-[rgba(255,255,255,.05)]"
    :class="scrollable ? 'cursor-pointer' : ''"
    style="background:rgba(255,255,255,.02)"
    @mousedown="onTrackMouseDown"
  >
    <div
      v-if="scrollable"
      class="wf-thumb absolute top-[2px] bottom-[2px] rounded-full"
      :class="{ 'wf-thumb-active': isDragging }"
      :style="{ left: `${thumbLeftPx}px`, width: `${thumbWidthPx}px` }"
      :title="`Drag to scroll — showing ${Math.round((visibleDuration / totalDuration) * 100)}% of the file`"
      @mousedown="onThumbMouseDown"
    ></div>
  </div>
</template>

<style scoped>
.wf-thumb {
  background: rgba(126, 240, 255, 0.28);
  transition: background-color 0.15s ease;
  cursor: grab;
}
.wf-thumb:hover {
  background: rgba(126, 240, 255, 0.5);
}
.wf-thumb-active,
.wf-thumb:active {
  background: rgba(126, 240, 255, 0.72);
  cursor: grabbing;
}
</style>
