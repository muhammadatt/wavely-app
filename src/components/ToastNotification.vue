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
        class="bg-ink text-white text-sm font-bold px-5 py-2.5 rounded-full shadow-[var(--shadow-lg)] pointer-events-auto"
        style="animation: slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1) both;"
      >
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
