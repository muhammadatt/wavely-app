<script setup>
import { useEditorState } from './composables/useEditorState.js'
import EditorScreen from './components/EditorScreen.vue'
import FilesPanel from './components/FilesPanel.vue'
import ExportDialog from './components/ExportDialog.vue'
import ToastNotification from './components/ToastNotification.vue'
import CommandPalette from './components/CommandPalette.vue'
import WaveformContextMenu from './components/WaveformContextMenu.vue'
import WindowLayer from './components/WindowLayer.vue'

// ProcessingOverlay is no longer mounted here — it now renders inside the
// waveform area so a job on one document doesn't block the whole app.
//
// Floating effect windows are no longer listed here either: WindowLayer renders
// whatever the window manager has open, so adding one is a registry entry.
const { appState } = useEditorState()
</script>

<template>
  <EditorScreen />
  <FilesPanel v-if="appState.filesPanelOpen" />
  <ExportDialog v-if="appState.exportDialogOpen" />
  <WindowLayer />
  <CommandPalette v-if="appState.commandPaletteOpen" />
  <!-- Keyed on position: right-clicking while the menu is open nulls and re-sets
       contextMenu within one tick, so without this Vue reuses the instance and
       the menu stays at the previous coordinates. -->
  <WaveformContextMenu
    v-if="appState.contextMenu"
    :key="`${appState.contextMenu.x},${appState.contextMenu.y}`"
  />
  <ToastNotification />
</template>
