<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { renderWaveform, renderOverlay, RULER_GUTTER_HEIGHT } from '../audio/renderer.js'
import { MAX_PIXELS_PER_SECOND } from '../audio/zoom.js'
import { useEditorState } from '../composables/useEditorState.js'
import { useCanvasRecovery } from '../composables/useCanvasRecovery.js'
import { hitSelectionEdge, selectionDragAnchor } from '../audio/selectionDrag.js'
import {
  TOUCH_EDGE_GRAB_PX, TOUCH_DRAG_THRESHOLD_PX, LONG_PRESS_MS,
  pinchSpan, pinchMidX, pinchView, scrollForAnchor,
} from '../audio/touchGestures.js'

const {
  state, appState, peakCaches, peakCacheVersion, setSelection, setPlayhead, totalDuration,
  openContextMenu,
} = useEditorState()

const canvas = ref(null)
const overlayCanvas = ref(null)
const container = ref(null)
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)
const isSelecting = ref(false)
const selectionAnchor = ref(0)

// Where the pointer went down, and whether it has since travelled far enough to
// count as a drag rather than a click.
const selectionAnchorPx = ref(0)
const dragExceededThreshold = ref(false)

// A click is never perfectly still — a few pixels of travel between mousedown
// and mouseup is normal, and treating that as a drag left a sliver of a
// selection behind every attempt to just move the playhead. Everything
// downstream then acts on that sliver: Space plays the sliver instead of the
// file, the effect windows apply to it, and the trim operations light up. Below
// this many pixels the gesture is a click and the selection stays cleared.
const SELECTION_DRAG_THRESHOLD_PX = 4

// Set while the pointer is over one of the selection's edges, and while a drag
// that grabbed one is in flight. Drives the resize cursor — without it the edge
// is a hit target with nothing to say it is one, and the only way to discover
// the feature is to land on it by accident.
const hoverEdge = ref(null)
const draggingEdge = ref(null)
const containerWidth = ref(0)
// Whether the view is pinned to "whole file fits the viewport". Starts true so
// a freshly opened file shows end to end rather than the first few seconds at
// the default 100 px/s. It stays true until the user zooms in, and because it's
// a mode rather than a value it also survives the first-frame case where the
// canvas hasn't been laid out yet and the fit scale can't be computed.
const fitToWindow = ref(true)

// One step, shared by the zoom buttons and the keyboard shortcuts, so the three
// zoom entry points move at a predictable rate.
const ZOOM_STEP = 1.3
// The wheel is continuous, so it steps finer than a discrete button press.
const WHEEL_ZOOM_STEP = 1.1

// Dynamic minimum PPS: zoom out no further than the full waveform fitting the
// canvas. Uses containerWidth (which tracks canvas.clientWidth) so this matches
// the renderer exactly.
//
// Returns null when the floor is genuinely unknowable — no file, or the canvas
// hasn't been laid out yet. Callers must bail rather than clamp, since any
// stand-in value here silently becomes a real zoom limit.
function getMinPps() {
  const dur = totalDuration.value
  if (!dur || containerWidth.value === 0) return null
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

// Both inputs to getMinPps() move on their own: totalDuration changes on every
// cut/trim/paste, and containerWidth changes when the window resizes or the
// context panel opens. Either one moves the fit scale out from under a
// pixelsPerSecond that was correct when it was set, and the renderer draws
// totalDuration * pixelsPerSecond of content — too narrow for the viewport, or
// too wide for it.
//
// So "fully zoomed out" is tracked as a mode rather than inferred from the
// value. Cutting raises the fit scale and pasting lowers it; only a flag
// survives both. The floor still applies when not fitted, for the case where
// the viewport grows under a fixed zoom.
function applyZoomBounds() {
  const minPps = getMinPps()
  if (minPps === null) return
  if (fitToWindow.value) pixelsPerSecond.value = minPps
  else if (pixelsPerSecond.value < minPps) pixelsPerSecond.value = minPps
}

// Single entry point for every zoom change, so the fit flag can't be set in one
// path and missed in another. Returns whether the zoom was applied.
function setZoom(pps) {
  const minPps = getMinPps()
  // No measurable floor means no meaningful zoom — drop the request rather than
  // clamp against a guess. applyZoomBounds re-establishes the correct scale on
  // the next draw, once the canvas has a width.
  if (minPps === null) return false
  const clamped = Math.max(minPps, Math.min(MAX_PIXELS_PER_SECOND, pps))
  pixelsPerSecond.value = clamped
  // Relative epsilon: the floor is a float ratio, so zooming out to it rarely
  // lands on it exactly.
  fitToWindow.value = clamped <= minPps * 1.0001
  return true
}

function drawMain() {
  if (!canvas.value || !state.currentFile) return

  // Keep containerWidth in sync with the actual canvas size before any scroll/zoom calculation
  updateContainerWidth()
  applyZoomBounds()
  // Same staleness on the pan axis: a shorter timeline lowers maxScrollLeft,
  // which can leave scrollLeft parked past the end of the audio.
  clampScroll()

  renderWaveform(canvas.value, {
    segments: state.segments,
    peakCaches,
    sampleRate: state.currentFile.sampleRate,
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    totalDuration: totalDuration.value,
    // Capped at 2: beyond stereo the lanes get too short to read anything from,
    // and the product's inputs are mono or stereo voice recordings.
    channelCount: Math.min(state.currentFile.channels ?? 1, 2),
    topGutter: RULER_GUTTER_HEIGHT,
  })

  // Notify other components of view state. The zoom bounds travel with it so
  // the transport's slider can map its track onto the range that actually
  // exists for this file and viewport, rather than a hardcoded guess, and so
  // the overview's resize handles stop at the same ceiling the viewport
  // enforces. viewportWidthPx is sent raw: the overview used to recover it as
  // visibleDuration * pixelsPerSecond, which is the same number by a longer
  // route.
  window.dispatchEvent(new CustomEvent('wavely:view-update', {
    detail: {
      scrollLeft: scrollLeft.value,
      pixelsPerSecond: pixelsPerSecond.value,
      visibleDuration: containerWidth.value / pixelsPerSecond.value,
      viewportWidthPx: containerWidth.value,
      minPixelsPerSecond: getMinPps(),
      maxPixelsPerSecond: MAX_PIXELS_PER_SECOND,
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

// Right-click opens the edit menu. It deliberately does not move the playhead
// or clear the selection — the menu's items act on whatever is already
// selected, so changing that out from under the click would be hostile.
function handleContextMenu(e) {
  e.preventDefault()
  // A touch long press opens the menu through its own timer (iOS never fires
  // contextmenu at all); Android's native one would open it a second time.
  if (lastPointerType === 'touch') return
  openContextMenu(e.clientX, e.clientY)
}

// ── Pointer routing ─────────────────────────────────────────────────────────
// One set of pointer handlers for mouse, pen and touch. Mouse and pen take the
// desktop path unchanged; a finger takes the touch path below. The pointer is
// captured on down, so moves and the release keep arriving here when the drag
// runs off the canvas — the job the window-level mouse listeners used to do.
let lastPointerType = 'mouse'

function handlePointerDown(e) {
  lastPointerType = e.pointerType
  try { canvas.value.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
  if (e.pointerType === 'touch') { touchDown(e); return }
  handleMouseDown(e)
}

function handlePointerMove(e) {
  if (e.pointerType === 'touch') { touchMove(e); return }
  if (isSelecting.value) handleMouseMove(e)
  else handleHover(e)
}

function handlePointerUp(e) {
  if (e.pointerType === 'touch') { touchUp(e, e.type === 'pointercancel'); return }
  if (isSelecting.value) handleMouseUp()
}

function handleMouseDown(e) {
  if (e.button !== 0) return
  const rect = canvas.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const time = pxToTime(x)

  // Grabbing an existing edge adjusts the selection instead of replacing it.
  // The opposite edge becomes the anchor, so from here the drag is the same
  // gesture as making a selection from scratch.
  const edge = hitSelectionEdge({
    selection: state.selection,
    xPx: x,
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
  })

  isSelecting.value = true
  selectionAnchorPx.value = x
  draggingEdge.value = edge

  if (edge) {
    selectionAnchor.value = selectionDragAnchor(state.selection, edge)
    // No threshold on an adjust: the selection already exists, so there is no
    // sliver to protect against, and a 3 px nudge of an edge is a legitimate
    // and common move. The playhead stays put too — the user is trimming a
    // boundary, not seeking.
    dragExceededThreshold.value = true
  } else {
    selectionAnchor.value = time
    dragExceededThreshold.value = false
    setPlayhead(time)
    setSelection(time, time) // Clear / start fresh
  }
}

function handleMouseMove(e) {
  if (!isSelecting.value) return
  const rect = canvas.value.getBoundingClientRect()
  const x = e.clientX - rect.left

  // The threshold latches: once the gesture has been read as a drag it stays a
  // drag, so dragging out a selection and then pulling back to a two-pixel one
  // is still a selection. Only the opening move decides.
  if (!dragExceededThreshold.value) {
    if (Math.abs(x - selectionAnchorPx.value) < SELECTION_DRAG_THRESHOLD_PX) return
    dragExceededThreshold.value = true
  }

  const time = Math.max(0, Math.min(pxToTime(x), totalDuration.value))

  setSelection(selectionAnchor.value, time)
  drawOverlay() // Peaks unchanged during selection drag — overlay only
}

function handleMouseUp() {
  isSelecting.value = false
  draggingEdge.value = null
}

// ── Touch ───────────────────────────────────────────────────────────────────
// One finger: tap seeks (and clears the selection), drag selects — or adjusts
// an edge it started on — and a long press opens the edit menu. Two fingers:
// pinch zooms about their midpoint, and moving them together pans.
//
// Nothing commits on touch DOWN, unlike the mouse: seeking and clearing there
// would throw the selection away whenever a second finger arrived to pinch, or
// a long press meant to open the menu that acts on it. See touchGestures.js.
const touches = new Map() // pointerId → { x, y }, x relative to the canvas
// null | { kind: 'pending', id, x0, time, edge }
//      | { kind: 'select', id }
//      | { kind: 'pinch', startSpanPx, startPps, anchorTime }
//      | { kind: 'done' } — swallow the rest until every finger is up
let touchGesture = null
let longPressTimer = null

function clearLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
}

function touchPoint(e) {
  const rect = canvas.value.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function touchDown(e) {
  touches.set(e.pointerId, touchPoint(e))

  if (touches.size === 1) {
    const { x } = touches.get(e.pointerId)
    touchGesture = {
      kind: 'pending',
      id: e.pointerId,
      x0: x,
      time: Math.max(0, Math.min(pxToTime(x), totalDuration.value)),
      edge: hitSelectionEdge({
        selection: state.selection,
        xPx: x,
        scrollLeft: scrollLeft.value,
        pixelsPerSecond: pixelsPerSecond.value,
        grabPx: TOUCH_EDGE_GRAB_PX,
      }),
    }
    const { clientX, clientY } = e
    longPressTimer = setTimeout(() => {
      longPressTimer = null
      if (touchGesture?.kind !== 'pending') return
      touchGesture = { kind: 'done' }
      navigator.vibrate?.(10)
      openContextMenu(clientX, clientY)
    }, LONG_PRESS_MS)
    return
  }

  if (touches.size === 2) {
    // A second finger turns whatever the first was doing into a pinch. A drag
    // already under way keeps the selection it made; a pending touch had not
    // committed anything, so there is nothing to undo.
    clearLongPress()
    isSelecting.value = false
    draggingEdge.value = null
    const [a, b] = [...touches.values()]
    const mid = pinchMidX(a, b)
    touchGesture = {
      kind: 'pinch',
      startSpanPx: pinchSpan(a, b),
      startPps: pixelsPerSecond.value,
      anchorTime: pxToTime(mid),
    }
  }
  // A third finger is ignored: the pinch keeps reading its first two.
}

function touchMove(e) {
  if (!touches.has(e.pointerId)) return
  const p = touchPoint(e)
  touches.set(e.pointerId, p)
  const g = touchGesture
  if (!g) return

  if (g.kind === 'pinch') {
    const [a, b] = [...touches.values()]
    const midPx = pinchMidX(a, b)
    const view = pinchView({ ...g, spanPx: pinchSpan(a, b), midPx })
    setZoom(view.pixelsPerSecond)
    // Re-solved against the zoom setZoom actually granted, so the anchor stays
    // under the fingers even when the pinch runs into a zoom bound.
    scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value,
      scrollForAnchor(g.anchorTime, midPx, pixelsPerSecond.value)))
    drawAll()
    return
  }

  if (g.kind === 'pending' && e.pointerId === g.id) {
    if (Math.abs(p.x - g.x0) < TOUCH_DRAG_THRESHOLD_PX) return
    // Read as a drag: commit the way the mouse path does on down.
    clearLongPress()
    if (g.edge) {
      selectionAnchor.value = selectionDragAnchor(state.selection, g.edge)
    } else {
      selectionAnchor.value = g.time
      setPlayhead(g.time)
    }
    draggingEdge.value = g.edge
    isSelecting.value = true
    touchGesture = { kind: 'select', id: g.id }
  }

  if (touchGesture.kind === 'select' && e.pointerId === touchGesture.id) {
    const time = Math.max(0, Math.min(pxToTime(p.x), totalDuration.value))
    setSelection(selectionAnchor.value, time)
    drawOverlay()
  }
}

function touchUp(e, cancelled) {
  if (!touches.delete(e.pointerId)) return
  const g = touchGesture

  // A tap: seek and clear, which is what a mouse click does on down. A
  // cancelled touch (the browser took it) commits nothing.
  if (g?.kind === 'pending' && e.pointerId === g.id) {
    clearLongPress()
    if (!cancelled) {
      setPlayhead(g.time)
      setSelection(g.time, g.time)
    }
    touchGesture = { kind: 'done' }
  } else if (g?.kind === 'select' && e.pointerId === g.id) {
    touchGesture = { kind: 'done' }
  } else if (g?.kind === 'pinch' && touches.size < 2) {
    // Lifting one finger of a pinch must not turn the other into a selection.
    touchGesture = { kind: 'done' }
  }

  if (touches.size === 0) {
    clearLongPress()
    touchGesture = null
    isSelecting.value = false
    draggingEdge.value = null
  }
}

// Hover only — the drag itself is tracked on the window, so this fires between
// gestures. While a drag is in flight the cursor is held by draggingEdge, since
// the pointer routinely runs off the grabbed edge faster than the selection
// follows it.
function handleHover(e) {
  if (isSelecting.value) return
  const rect = canvas.value.getBoundingClientRect()
  hoverEdge.value = hitSelectionEdge({
    selection: state.selection,
    xPx: e.clientX - rect.left,
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
  })
}

function handleHoverLeave() {
  hoverEdge.value = null
}

const cursorClass = computed(() =>
  (draggingEdge.value || hoverEdge.value) ? 'cursor-ew-resize' : 'cursor-crosshair'
)

function handleWheel(e) {
  e.preventDefault()

  // Ctrl/Meta + wheel → zoom, anchored at the pointer. Plain wheel pans, which
  // is what a two-finger trackpad scroll — the most common gesture over this
  // surface — should do; it used to zoom instead.
  if ((e.ctrlKey || e.metaKey) && e.deltaY !== 0) {
    const zoomFactor = e.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP
    const rect = canvas.value.getBoundingClientRect()

    // The pointer is the anchor here; every other zoom path uses the centre.
    zoomAt(pixelsPerSecond.value * zoomFactor, e.clientX - rect.left)
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

// Zoom about a fixed point: whatever time sits under anchorPx stays under
// anchorPx afterwards. Without this the left edge is the implicit anchor, so
// zooming in walks the view toward the start of the file instead of magnifying
// what the user is looking at.
function zoomAt(pps, anchorPx) {
  const anchorTime = pxToTime(anchorPx)
  if (!setZoom(pps)) return
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, anchorTime - anchorPx / pixelsPerSecond.value))
}

// Anchor for the zoom paths with no pointer position of their own — buttons,
// keyboard, and the transport slider.
//
// The selection is the anchor, not the playhead: click-to-seek moves the
// playhead on every click, so it tracks the last place the user clicked rather
// than what they're working on. A selection only exists after a deliberate drag
// (setSelection nulls itself when start === end), which makes it a real
// statement of intent.
//
// Anchoring on the midpoint of the *visible* part of the selection rather than
// its true midpoint covers the case where it runs past one or both edges: zoomed
// inside a long selection there is no visible midpoint to speak of, and a
// selection half off-screen would otherwise fall back to a centre that isn't
// inside it at all.
function zoomAnchorPx() {
  const center = containerWidth.value / 2
  const sel = state.selection
  if (!sel) return center

  const startPx = (sel.start - scrollLeft.value) * pixelsPerSecond.value
  const endPx = (sel.end - scrollLeft.value) * pixelsPerSecond.value
  if (endPx < 0 || startPx > containerWidth.value) return center

  return (Math.max(0, startPx) + Math.min(containerWidth.value, endPx)) / 2
}

// None of these clamp scroll themselves: drawMain re-establishes both bounds
// before rendering, so a clamp here would only be doing the same work twice.
function handleZoomIn() {
  zoomAt(pixelsPerSecond.value * ZOOM_STEP, zoomAnchorPx())
  drawAll()
}

function handleZoomOut() {
  zoomAt(pixelsPerSecond.value / ZOOM_STEP, zoomAnchorPx())
  drawAll()
}

function handleZoomSet(e) {
  zoomAt(e.detail.pixelsPerSecond, zoomAnchorPx())
  drawAll()
}

// Pan-only, from the scrollbar beneath the waveform. The scrollbar sends a
// position rather than a delta, so it can't accumulate drift over a long drag.
function handleScrollSet(e) {
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, e.detail.scrollLeft))
  drawAll()
}

// Sets pan + zoom together (from the overview strip's drag/resize handles) so
// the two never briefly disagree — e.g. a stale scrollLeft clamped against
// the old pixelsPerSecond for one frame. setZoom has already run, so
// maxScrollLeft reflects the new zoom.
function handleViewSet(e) {
  setZoom(e.detail.pixelsPerSecond)
  scrollLeft.value = Math.max(0, Math.min(maxScrollLeft.value, e.detail.scrollLeft))
  drawAll()
}

// Waveform content changed → redraw everything
watch(
  () => [state.segments, state.currentFile],
  () => drawAll(),
  { deep: true }
)

// ── Per-document view ───────────────────────────────────────────────────────
// Zoom and pan belong to the document being looked at, not to this component.
// Held here rather than on the document itself because they are properties of
// *this viewport* — its width decides what the numbers mean — and nothing
// outside the waveform reads them.
//
// Without this, switching tabs left the incoming document at whatever zoom the
// outgoing one had, and the refit below then threw that away too: every tab
// switch snapped back to the whole file, so a narrator comparing the same
// passage across two chapters had to re-zoom on every switch.
const viewByDoc = new Map()

function saveView(docId) {
  if (!docId) return
  viewByDoc.set(docId, {
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    fitToWindow: fitToWindow.value,
  })
}

function fitView() {
  fitToWindow.value = true
  scrollLeft.value = 0
}

function restoreView(docId) {
  const saved = viewByDoc.get(docId)
  // No saved view means a document opened while another was on screen — it has
  // never been laid out here, so it starts fitted like any freshly opened file.
  if (!saved) { fitView(); return }
  scrollLeft.value = saved.scrollLeft
  pixelsPerSecond.value = saved.pixelsPerSecond
  fitToWindow.value = saved.fitToWindow
  // Both bounds are re-established by drawMain against the current width and
  // duration, so a view saved before a resize or an edit still lands legally.
}

// Documents that have been closed would otherwise sit here forever holding a
// view for an id that can never come back.
//
// The scan is unconditional. Comparing sizes first looked like a cheap way to
// skip it, but it only catches a net shrink: close one document and open
// another and the count is unchanged, so the closed one's entry survived every
// future prune. At these document counts the scan costs nothing.
function pruneViews() {
  const live = new Set(appState.documents.map(d => d.id))
  for (const id of viewByDoc.keys()) if (!live.has(id)) viewByDoc.delete(id)
}

let lastDocId = appState.activeDocumentId
let lastFile = state.currentFile

// Two different events arrive on this one watcher because they need opposite
// treatment and only their order distinguishes them: a *different document* is
// a view switch (save one, restore the other), while a *different file object
// on the same document* is a genuinely new recording, which refits.
//
// Deliberately not deep: loadFile replaces currentFile wholesale, while
// PresetsPanel mutates its channels/sampleRate in place after processing, and
// that shouldn't throw away the user's zoom.
watch(
  () => [appState.activeDocumentId, state.currentFile],
  ([docId, file]) => {
    if (docId !== lastDocId) {
      saveView(lastDocId)
      restoreView(docId)
      pruneViews()
    } else if (file !== lastFile) {
      fitView()
    }
    lastDocId = docId
    lastFile = file
    drawAll()
  },
  // Synchronous, because saving the outgoing view has to happen at the instant
  // the active document changes. On the default 'pre' flush this runs one
  // microtask later, by which time the segments watcher above has already
  // redrawn against the incoming document — and drawMain re-clamps zoom and
  // scroll as it draws, so what got saved was the new document's view, not the
  // one being left behind.
  { flush: 'sync' }
)

// Selection or playhead changed externally (e.g. toolbar operations, click-to-seek)
// → overlay only; peaks are unchanged
watch(() => state.selection, () => drawOverlay(), { deep: true })
watch(() => state.playhead, () => drawOverlay())

// Peak cache updated → full redraw. Not drawMain alone: it re-establishes the
// zoom and scroll bounds, and a processed file that changed duration moves the
// fit scale, which would leave the overlay's selection and playhead painted at
// the previous scale.
watch(peakCacheVersion, () => drawAll())

// scrollLeft is always changed by an event handler that already calls drawAll(),
// so no separate watch is needed here.

// The window is not the only thing that resizes this canvas — opening or
// closing the context panel changes its width too, and without this the
// bitmap kept its old width and the waveform rendered stretched, with peaks
// no longer above the time grid they belong to.
//
// This also covers plain window resizes, so there is no window 'resize'
// listener: that fired a second, identical redraw for every window resize.
let resizeObserver = null

// Both canvases paint on demand, so a dropped GPU backing store would leave
// them blank until the next edit or tab switch.
useCanvasRecovery(() => [canvas.value, overlayCanvas.value], drawAll)

onMounted(() => {
  drawAll()
  if (typeof ResizeObserver !== 'undefined' && container.value) {
    resizeObserver = new ResizeObserver(() => drawAll())
    resizeObserver.observe(container.value)
  }
  window.addEventListener('wavely:zoom-in', handleZoomIn)
  window.addEventListener('wavely:zoom-out', handleZoomOut)
  window.addEventListener('wavely:zoom-set', handleZoomSet)
  window.addEventListener('wavely:view-set', handleViewSet)
  window.addEventListener('wavely:scroll-set', handleScrollSet)
})

onUnmounted(() => {
  clearLongPress()
  resizeObserver?.disconnect()
  window.removeEventListener('wavely:zoom-in', handleZoomIn)
  window.removeEventListener('wavely:zoom-out', handleZoomOut)
  window.removeEventListener('wavely:zoom-set', handleZoomSet)
  window.removeEventListener('wavely:view-set', handleViewSet)
  window.removeEventListener('wavely:scroll-set', handleScrollSet)
})
</script>

<template>
  <div
    ref="container"
    class="flex-1 relative overflow-hidden min-h-[120px]"
    :class="cursorClass"
  >
    <div class="absolute inset-0">
      <!-- Both canvases are absolute inset-0 so they occupy the same compositing
           layer space. Main canvas draws waveform peaks; overlay canvas draws
           selection highlight + playhead. pointer-events-none lets mouse events
           fall through to the main canvas. -->
      <canvas
        ref="canvas"
        class="waveform-canvas absolute inset-0 w-full h-full"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerUp"
        @pointerleave="handleHoverLeave"
        @wheel="handleWheel"
        @contextmenu="handleContextMenu"
      ></canvas>
      <canvas
        ref="overlayCanvas"
        class="absolute inset-0 w-full h-full pointer-events-none"
      ></canvas>
    </div>
  </div>
</template>

<style scoped>
/* Every touch gesture here is the app's own: without touch-action the browser
   claims a one-finger drag as a page scroll and a pinch as a page zoom, and
   cancels the pointer. The callout and user-select stop iOS from showing its
   long-press magnifier or callout over the canvas. */
.waveform-canvas {
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
</style>
