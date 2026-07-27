<script setup>
import { useEditorState } from './composables/useEditorState.js'
import LandingScreen from './components/LandingScreen.vue'
import EditorScreen from './components/EditorScreen.vue'
import ProcessingOverlay from './components/ProcessingOverlay.vue'
import ToastNotification from './components/ToastNotification.vue'
import LA2AModal from './components/panels/LA2AModal.vue'

const { hasFile, state } = useEditorState()
</script>

<template>
  <LandingScreen v-if="!hasFile" />
  <EditorScreen v-else />
  <ProcessingOverlay v-if="state.isProcessing" />
  <LA2AModal v-if="state.la2aModalOpen" />
  <ToastNotification />
</template>
