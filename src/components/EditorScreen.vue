<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { installEditorShell, useWorkspaceDrop } from '../composables/editorShell.js'
import TopBar from './TopBar.vue'
import FileTabs from './FileTabs.vue'
import FloatingToolbar from './FloatingToolbar.vue'
import WaveformOverview from './WaveformOverview.vue'
import DbfsScale from './DbfsScale.vue'
import WaveformArea from './WaveformArea.vue'
import WaveformScrollbar from './WaveformScrollbar.vue'
import SelectionBar from './SelectionBar.vue'
import TransportBar from './TransportBar.vue'
import ContextPanel from './ContextPanel.vue'
import EmptyState from './EmptyState.vue'
import ProcessingOverlay from './ProcessingOverlay.vue'
import RotateHint from './RotateHint.vue'

const { state, hasFile } = useEditorState()
// Shortcuts, the unsaved-work guard and per-file plugin settings: shared with
// the mobile shell (composables/editorShell.js).
installEditorShell()
const { isDragOver, onDragEnter, onDragOver, onDragLeave, onDrop } = useWorkspaceDrop()
</script>

<template>
  <div
    class="relative flex flex-col h-screen h-[100dvh] overflow-hidden font-['Inter']"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <TopBar />
    <RotateHint v-if="hasFile" />

    <div class="relative flex flex-1 overflow-hidden">
      <!-- Workspace -->
      <div class="flex flex-col flex-1 overflow-hidden">
        <!-- The categories' own row, between the header and the tabs. -->
        <FloatingToolbar />

        <FileTabs />  
        <div class="flex-1 min-h-0 p-[14px] pl-5 flex flex-col gap-[10px] compact:p-[6px] compact:pl-2 compact:gap-[6px]" :style="{ background: hasFile ? 'var(--color-workspace)' : 'linear-gradient(var(--color-wk-top-empty), var(--color-wk-bottom))' }">
          <!-- Overview is indented by the dBFS gutter so its time axis shares an
               x-origin with the main waveform below it. -->
   
          <div class="flex shrink-0 compact:hidden" v-if="hasFile">
            <div class="w-7 shrink-0"></div>
            <WaveformOverview class="flex-1" />
          </div>
          <template v-if="hasFile">
            <!-- Waveform row + SelectionBar sit in their own gap-less column so
                 they stay visually flush, while the scale sits directly on the
                 outermost background rather than the canvas box — it reads as
                 chrome, not content — but still shares the canvas's exact height
                 so its ticks land on the amplitudes they name. -->
            <div class="flex-1 min-h-0 flex flex-col">
              <div class="flex-1 min-h-0 flex">
                <DbfsScale />
                <div
                  class="relative flex-1 min-h-0 flex flex-col rounded-t-[12px] overflow-hidden"
                  style="background:linear-gradient(180deg,#0c0f13,#080a0d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 16px rgba(0,0,0,.7)"
                >
                  <WaveformArea />
                  <!-- Inside the waveform's own box rather than the gutter-
                       indented rows below it, so the track spans exactly the
                       canvas it scrolls — the two have to agree pixel for
                       pixel for the thumb to line up with what's on screen. -->
                  <WaveformScrollbar />
                  <ProcessingOverlay v-if="state.isProcessing" />
                </div>
              </div>
              <div class="flex shrink-0">
                <div class="w-7 shrink-0"></div>
                <SelectionBar class="flex-1 rounded-b-[12px] overflow-hidden" style="background:#080a0d" />
              </div>
            </div>
          </template>
          <EmptyState v-else class="flex-1 min-h-0" />
        </div>
        <TransportBar />
      </div>
      <!-- Context Panel -->
      <Transition name="ctx-panel">
        <ContextPanel v-if="state.activeTool" />
      </Transition>
    </div>

    <!-- Drop overlay. Pointer events are off so the drag never lands on the
         overlay itself and immediately fires dragleave on the workspace. -->
    <div
      v-if="isDragOver"
      class="absolute inset-0 z-[300] flex items-center justify-center pointer-events-none"
      style="background:rgba(8,11,15,.72);backdrop-filter:blur(3px)"
    >
      <div
        class="rounded-[18px] px-9 py-7 text-center border-2 border-dashed"
        style="border-color:#35d3e6;background:rgba(53,211,230,.07)"
      >
        <svg viewBox="0 0 24 24" class="w-8 h-8 mx-auto mb-3 fill-none stroke-current" style="color:#7fe9f6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
        <div class="text-[15px] font-bold text-[#eaf6f8]">Drop to open</div>
        <div class="text-[11.5px] font-semibold text-[rgba(255,255,255,.45)] mt-1">
          {{ hasFile ? 'Opens in a new tab — your current file stays put' : 'Drop one file or several' }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx-panel-enter-active,
.ctx-panel-leave-active {
  transition: transform 0.25s ease, opacity 0.2s ease;
}
.ctx-panel-enter-from,
.ctx-panel-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
/* The bottom sheet (see ContextPanel) rises rather than slides in. */
@media (max-width: 639.98px) {
  .ctx-panel-enter-from,
  .ctx-panel-leave-to {
    transform: translateY(100%);
  }
}
</style>
