<script setup>
import { useEditorState } from './composables/useEditorState.js'
import EditorScreen from './components/EditorScreen.vue'
import FilesPanel from './components/FilesPanel.vue'
import ExportDialog from './components/ExportDialog.vue'
import ToastNotification from './components/ToastNotification.vue'
import LA2AModal from './components/panels/LA2AModal.vue'
import FET1176Modal from './components/panels/FET1176Modal.vue'

// ProcessingOverlay is no longer mounted here — it now renders inside the
// waveform area so a job on one document doesn't block the whole app.
const { state, appState } = useEditorState()
</script>

<template>
  <EditorScreen />
  <FilesPanel v-if="appState.filesPanelOpen" />
  <ExportDialog v-if="appState.exportDialogOpen" />
  <LA2AModal v-if="state.la2aModalOpen" />
  <FET1176Modal v-if="state.fet1176ModalOpen" />
  <ToastNotification />
</template>
