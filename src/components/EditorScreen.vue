<script setup>
import { onMounted, onUnmounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import TopBar from './TopBar.vue'
import FloatingToolbar from './FloatingToolbar.vue'
import TimeRuler from './TimeRuler.vue'
import WaveformArea from './WaveformArea.vue'
import SelectionBar from './SelectionBar.vue'
import TransportBar from './TransportBar.vue'
import ContextPanel from './ContextPanel.vue'

const {
  state, performDelete, undo, redo, canUndo, canRedo, hasSelection,
} = useEditorState()

function handleKeydown(e) {
  // Space — play/pause (handled in TransportBar via event bus)
  if (e.code === 'Space' && !e.target.closest('input, textarea, button')) {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
  }

  // Ctrl+Z — undo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
    e.preventDefault()
    if (canUndo.value) undo()
  }

  // Ctrl+Shift+Z or Ctrl+Y — redo
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
    e.preventDefault()
    if (canRedo.value) redo()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    e.preventDefault()
    if (canRedo.value) redo()
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
  <div class="flex flex-col h-screen bg-bg overflow-hidden">
    <TopBar />
    <div class="flex flex-1 overflow-hidden">
      <!-- Workspace -->
      <div class="flex flex-col flex-1 overflow-hidden">
        <FloatingToolbar />
        <TimeRuler />
        <WaveformArea />
        <SelectionBar />
        <TransportBar />
      </div>
      <!-- Context Panel -->
      <ContextPanel v-if="state.contextPanelOpen" />
    </div>
  </div>
</template>
