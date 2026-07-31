<script setup>
import { useEditorState } from './composables/useEditorState.js'
import EditorScreen from './components/EditorScreen.vue'
import ProcessingOverlay from './components/ProcessingOverlay.vue'
import ToastNotification from './components/ToastNotification.vue'
import LA2AModal from './components/panels/LA2AModal.vue'
import FET1176Modal from './components/panels/FET1176Modal.vue'

const { state } = useEditorState()
</script>

<template>
  <EditorScreen />
  <ProcessingOverlay v-if="state.isProcessing" />
  <LA2AModal v-if="state.la2aModalOpen" />
  <FET1176Modal v-if="state.fet1176ModalOpen" />
  <ToastNotification />
</template>
