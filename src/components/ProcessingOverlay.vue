<script setup>
import { useEditorState } from '../composables/useEditorState.js'

const { state } = useEditorState()
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(45,42,62,0.4); backdrop-filter: blur(4px);">
    <div class="bg-surface rounded-[var(--radius-lg)] p-8 shadow-[var(--shadow-lg)] text-center max-w-[320px] w-full" style="animation: bounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both;">
      <!-- Spinner -->
      <div class="w-12 h-12 mx-auto mb-4 border-3 border-border border-t-accent rounded-full" style="animation: spin 0.8s linear infinite;"></div>

      <div class="font-heading text-lg font-extrabold text-ink mb-2">{{ state.processingMessage }}</div>
      <div class="text-sm text-ink-mid font-semibold mb-4">This may take a moment</div>

      <!-- Progress bar -->
      <div class="w-full h-2 bg-bg rounded-full overflow-hidden">
        <div
          class="h-full bg-accent rounded-full transition-all duration-200"
          :style="{ width: state.processingProgress > 0 ? `${state.processingProgress * 100}%` : '60%' }"
          :class="{ 'animate-pulse': state.processingProgress === 0 }"
        ></div>
      </div>
    </div>
  </div>
</template>
