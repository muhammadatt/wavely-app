<script setup>
import { useEditorState } from '../composables/useEditorState.js'

const { state } = useEditorState()
</script>

<template>
  <div class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
    <TransitionGroup name="toast">
      <div
        v-for="toast in state.toasts"
        :key="toast.id"
        class="bg-ink text-white font-heading text-[13px] font-extrabold px-5 py-[11px] rounded-[var(--radius-pill)] shadow-[0_4px_0_rgba(45,42,62,0.4),var(--shadow-lg)] pointer-events-auto flex items-center gap-2 whitespace-nowrap"
        style="animation: slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1) both;"
      >
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-mint shrink-0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active {
  animation: slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1) both;
}
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
