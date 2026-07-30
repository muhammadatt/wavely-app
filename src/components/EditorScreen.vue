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

const {
  state, performDelete, performCut, performCopy, performPaste,
  undo, redo, canUndo, canRedo, hasSelection, hasClipboard,
} = useEditorState()

function handleKeydown(e) {
  // Shift changes e.key's case ('z' → 'Z'), so match on the lowered key
  // throughout or every Shift-modified shortcut silently never fires.
  const key = e.key.toLowerCase()

  // Space — play/pause (handled in TransportBar via event bus)
  if (e.code === 'Space' && !e.target.closest('input, textarea, button')) {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
  }

  // Ctrl+Z — undo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
    e.preventDefault()
    if (canUndo.value) undo()
  }

  // Ctrl+Shift+Z or Ctrl+Y — redo
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'z') {
    e.preventDefault()
    if (canRedo.value) redo()
  }
  if ((e.ctrlKey || e.metaKey) && key === 'y') {
    e.preventDefault()
    if (canRedo.value) redo()
  }

  // Ctrl+X — cut selection
  if ((e.ctrlKey || e.metaKey) && key === 'x' && !e.target.closest('input, textarea')) {
    e.preventDefault()
    if (hasSelection.value) performCut()
  }

  // Ctrl+C — copy selection
  if ((e.ctrlKey || e.metaKey) && key === 'c' && !e.target.closest('input, textarea')) {
    e.preventDefault()
    if (hasSelection.value) performCopy()
  }

  // Ctrl+V — paste at playhead
  if ((e.ctrlKey || e.metaKey) && key === 'v' && !e.target.closest('input, textarea')) {
    e.preventDefault()
    if (hasClipboard.value) performPaste(state.playhead)
  }

  // Delete / Backspace — delete selection
  if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input, textarea')) {
    e.preventDefault()
    if (hasSelection.value) performDelete()
  }

  // + / = — zoom in
  if ((e.key === '+' || e.key === '=') && !e.target.closest('input, textarea')) {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:zoom-in'))
  }

  // - — zoom out
  if (e.key === '-' && !e.target.closest('input, textarea')) {
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
          <div class="flex shrink-0">
            <div class="w-7 shrink-0"></div>
            <WaveformOverview class="flex-1" />
          </div>
          <div
            class="relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-[12px]"
            style="background:linear-gradient(180deg,#0c0f13,#080a0d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 16px rgba(0,0,0,.7)"
          >
            <!-- The scale shares the canvas's box exactly, so its ticks land on
                 the amplitudes they name. SelectionBar sits below in flow rather
                 than overlaying the waveform's loudest peaks. -->
            <div class="flex-1 min-h-0 flex">
              <DbfsScale />
              <WaveformArea />
            </div>
            <SelectionBar />
          </div>
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
