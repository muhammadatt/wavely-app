<script setup>
import { useEditorState } from './composables/useEditorState.js'
import LandingScreen from './components/LandingScreen.vue'
import EditorScreen from './components/EditorScreen.vue'
import ProcessingOverlay from './components/ProcessingOverlay.vue'
import ToastNotification from './components/ToastNotification.vue'

const { hasFile, state } = useEditorState()
</script>

<template>
  <LandingScreen v-if="!hasFile" />
  <EditorScreen v-else />
  <ProcessingOverlay v-if="state.isProcessing" />
  <ToastNotification />
</template>
