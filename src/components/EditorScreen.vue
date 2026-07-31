<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import TopBar from './TopBar.vue'
import FloatingToolbar from './FloatingToolbar.vue'
import WaveformOverview from './WaveformOverview.vue'
import DbfsScale from './DbfsScale.vue'
import WaveformArea from './WaveformArea.vue'
import SelectionBar from './SelectionBar.vue'
import TransportBar from './TransportBar.vue'
import ContextPanel from './ContextPanel.vue'
import EmptyState from './EmptyState.vue'

const {
  state, performDelete, performCut, performCopy, performPaste,
  undo, redo, canUndo, canRedo, hasSelection, hasClipboard, hasFile,
  selectAll, clearSelection, setPlayhead, totalDuration, setActiveTool,
} = useEditorState()

const NUDGE_SECONDS = 1
const NUDGE_SECONDS_COARSE = 5

// A shortcut must never reach the timeline from inside a text field — the guard
// belongs on every branch, not just the clipboard ones.
function isTextField(target) {
  return !!target.closest?.('input, textarea, select, [contenteditable="true"]')
}

function closeTopModal() {
  if (state.la2aModalOpen) { state.la2aModalOpen = false; return true }
  if (state.fet1176ModalOpen) { state.fet1176ModalOpen = false; return true }
  return false
}

function handleKeydown(e) {
  // Shift changes e.key's case ('z' → 'Z'), so match on the lowered key
  // throughout or every Shift-modified shortcut silently never fires.
  const key = e.key.toLowerCase()
  const inText = isTextField(e.target)
  const modalOpen = state.la2aModalOpen || state.fet1176ModalOpen

  // Escape — close the top modal, then the context panel, then the selection.
  if (e.key === 'Escape') {
    if (closeTopModal()) { e.preventDefault(); return }
    if (hasSelection.value) { clearSelection(); e.preventDefault(); return }
    // Route through setActiveTool rather than closing the panel directly, or
    // the toolbar keeps showing the tool as active with nothing open.
    if (state.contextPanelOpen && state.activeTool) { setActiveTool(state.activeTool); e.preventDefault() }
    return
  }

  // Nothing below should reach the timeline behind a modal, the processing
  // overlay, or an empty editor — the editor used to keep taking edits through all three.
  if (modalOpen || state.isProcessing || inText || !hasFile.value) return

  // Space — play/pause (handled in TransportBar via event bus). Focus lands on
  // whichever button was last clicked, and in an editor Space means transport,
  // not "press that button again".
  if (e.code === 'Space') {
    e.preventDefault()
    if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur()
    window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
    return
  }

  // Ctrl+Z — undo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
    e.preventDefault()
    if (canUndo.value) undo()
    return
  }

  // Ctrl+Shift+Z or Ctrl+Y — redo
  if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && key === 'z') || key === 'y')) {
    e.preventDefault()
    if (canRedo.value) redo()
    return
  }

  // Ctrl+A — select all, matching the SelectionBar button
  if ((e.ctrlKey || e.metaKey) && key === 'a') {
    e.preventDefault()
    selectAll()
    return
  }

  // Ctrl+X — cut selection
  if ((e.ctrlKey || e.metaKey) && key === 'x') {
    if (!hasSelection.value) return
    e.preventDefault()
    performCut()
    return
  }

  // Ctrl+C — copy selection. Left alone when the user is copying page text
  // (a filename, a measurement from the report) rather than audio.
  if ((e.ctrlKey || e.metaKey) && key === 'c') {
    const textSelected = !window.getSelection()?.isCollapsed
    if (!hasSelection.value || textSelected) return
    e.preventDefault()
    performCopy()
    return
  }

  // Ctrl+V — paste at playhead
  if ((e.ctrlKey || e.metaKey) && key === 'v') {
    if (!hasClipboard.value) return
    e.preventDefault()
    performPaste(state.playhead)
    return
  }

  if (e.ctrlKey || e.metaKey) return

  // Delete / Backspace — delete selection
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!hasSelection.value) return
    e.preventDefault()
    performDelete()
    return
  }

  // Arrow keys — nudge the playhead; Home / End jump to the edges.
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const step = e.shiftKey ? NUDGE_SECONDS_COARSE : NUDGE_SECONDS
    setPlayhead(state.playhead + (e.key === 'ArrowRight' ? step : -step))
    return
  }
  if (e.key === 'Home') {
    e.preventDefault()
    setPlayhead(0)
    return
  }
  if (e.key === 'End') {
    e.preventDefault()
    setPlayhead(totalDuration.value)
    return
  }

  // + / = — zoom in
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:zoom-in'))
    return
  }

  // - — zoom out
  if (e.key === '-') {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:zoom-out'))
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="flex flex-col h-screen overflow-hidden font-['Inter']" style="background:linear-gradient(160deg,#181c22,#0c0f13 62%)">
    <TopBar />
    <div class="flex flex-1 overflow-hidden">
      <!-- Workspace -->
      <div class="flex flex-col flex-1 overflow-hidden">
        <FloatingToolbar />
        <div class="flex-1 min-h-0 p-[14px] pl-5 flex flex-col gap-[10px]">
          <!-- Overview is indented by the dBFS gutter so its time axis shares an
               x-origin with the main waveform below it. -->
          <div class="flex shrink-0" v-if="hasFile">
            <div class="w-7 shrink-0"></div>
            <WaveformOverview class="flex-1" />
          </div>
          <template v-if="hasFile">
            <!-- Waveform row + SelectionBar sit in their own gap-less column so
                 they stay visually flush, while the scale sits directly on the
                 outermost background rather than the canvas box — it reads as
                 chrome, not content — but still shares the canvas's exact height
                 so its ticks land on the amplitudes they name. -->
            <div class="flex-1 min-h-0 flex flex-col">
              <div class="flex-1 min-h-0 flex">
                <DbfsScale />
                <div
                  class="relative flex-1 min-h-0 flex flex-col rounded-t-[12px] overflow-hidden"
                  style="background:linear-gradient(180deg,#0c0f13,#080a0d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 16px rgba(0,0,0,.7)"
                >
                  <WaveformArea />
                </div>
              </div>
              <div class="flex shrink-0">
                <div class="w-7 shrink-0"></div>
                <SelectionBar class="flex-1 rounded-b-[12px] overflow-hidden" style="background:#080a0d" />
              </div>
            </div>
          </template>
          <EmptyState v-else class="flex-1 min-h-0" />
        </div>
        <TransportBar />
      </div>
      <!-- Context Panel -->
      <Transition name="ctx-panel">
        <ContextPanel v-if="state.contextPanelOpen" />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.ctx-panel-enter-active,
.ctx-panel-leave-active {
  transition: transform 0.25s ease, opacity 0.2s ease;
}
.ctx-panel-enter-from,
.ctx-panel-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
