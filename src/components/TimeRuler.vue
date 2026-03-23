<script setup>
import { ref, watch, onMounted, onUnmounted, inject } from 'vue'
import { renderTimeRuler } from '../audio/renderer.js'
import { useEditorState } from '../composables/useEditorState.js'

const { totalDuration } = useEditorState()

const canvas = ref(null)

// These are injected from WaveformArea's provide or synced via events
const scrollLeft = ref(0)
const pixelsPerSecond = ref(100)

function draw() {
  if (!canvas.value) return
  renderTimeRuler(canvas.value, {
    scrollLeft: scrollLeft.value,
    pixelsPerSecond: pixelsPerSecond.value,
    totalDuration: totalDuration.value,
  })
}

function handleViewUpdate(e) {
  scrollLeft.value = e.detail.scrollLeft
  pixelsPerSecond.value = e.detail.pixelsPerSecond
  draw()
}

onMounted(() => {
  window.addEventListener('wavely:view-update', handleViewUpdate)
  draw()
  window.addEventListener('resize', draw)
})

onUnmounted(() => {
  window.removeEventListener('wavely:view-update', handleViewUpdate)
  window.removeEventListener('resize', draw)
})
</script>

<template>
  <div class="h-7 shrink-0 bg-surface border-b border-border">
    <canvas ref="canvas" class="w-full h-full"></canvas>
  </div>
</template>
