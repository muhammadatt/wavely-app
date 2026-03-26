<script setup>
import { useEditorState } from '../composables/useEditorState.js'

const { state } = useEditorState()
</script>

<template>
  <div class="fixed inset-0 z-[500] flex items-center justify-center" style="background: rgba(45,42,62,0.45); backdrop-filter: blur(6px);">
    <div class="bg-surface rounded-[var(--radius-xl)] px-[52px] py-[44px] shadow-[0_8px_0_rgba(45,42,62,0.1),var(--shadow-lg)] text-center min-w-[290px] border-2 border-border" style="animation: bounceIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both;">
      <!-- Spinner (multicolor like mockup) -->
      <div class="w-[52px] h-[52px] mx-auto mb-5 border-4 border-border border-t-accent border-r-yellow rounded-full" style="animation: spin 0.7s linear infinite;"></div>

      <div class="font-heading text-xl font-black text-ink mb-1.5">{{ state.processingMessage }}</div>
      <div class="text-[13px] text-ink-lt font-bold mb-[22px]">This may take a moment</div>

      <!-- Progress bar (gradient like mockup) -->
      <div class="w-full h-2.5 bg-bg rounded-md overflow-hidden border-2 border-border">
        <div
          class="h-full rounded transition-all duration-400"
          style="background: linear-gradient(90deg, var(--color-accent), var(--color-yellow));"
          :style="{ width: state.processingProgress > 0 ? `${state.processingProgress * 100}%` : '60%' }"
          :class="{ 'animate-pulse': state.processingProgress === 0 }"
        ></div>
      </div>
    </div>
  </div>
</template>
