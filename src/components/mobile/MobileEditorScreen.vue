<script setup>
import { watch } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { installEditorShell, useWorkspaceDrop } from '../../composables/editorShell.js'
import MobileTopBar from './MobileTopBar.vue'
import MobileSelectionBar from './MobileSelectionBar.vue'
import MobileSelectionReadout from './MobileSelectionReadout.vue'
import MobileTransport from './MobileTransport.vue'
import MobileTabBar from './MobileTabBar.vue'
import WaveformOverview from '../WaveformOverview.vue'
import WaveformArea from '../WaveformArea.vue'
import WaveformScrollbar from '../WaveformScrollbar.vue'
import MobileToolSheet from './MobileToolSheet.vue'
import MobileEffectsMenu from './MobileEffectsMenu.vue'
import MobileFileSheet from './MobileFileSheet.vue'
import { useMobileSheets } from '../../composables/useMobileSheets.js'
import EmptyState from '../EmptyState.vue'
import ProcessingOverlay from '../ProcessingOverlay.vue'

/**
 * The editor on a phone (the mobile design's main screen). A separate shell
 * over the same engine as the desktop EditorScreen: the same documents, undo,
 * waveform, transport rules and plugin windows — so an edit here is the same
 * edit there. What differs is the layout: the file is a name with a switcher
 * instead of tabs, the waveform takes the height, the selection's actions sit
 * in a bar instead of a right-click menu, and the toolbar's categories are
 * ONE Effects menu (the chain's picker over every effect) from the bottom
 * bar, beside Chain. A rail view opened from it (Trim, Split, Silence, Fade,
 * Volume) is a tool sheet above the transport.
 *
 * Chosen at startup on a phone (ui/formFactor.js); "Use desktop layout" in the
 * ⋯ menu switches back.
 */
const { state, hasFile, closeRail } = useEditorState()
const { fileSheetOpen, closeFileSheet, effectsMenuOpen, closeEffectsMenu } = useMobileSheets()
// One sheet at a time: a tool opening closes the switcher and the menu. A
// category list with no tool in it (the desktop rail, open when the user
// switched layouts) has no place here and is closed.
watch(() => [state.activeTool, state.railOperation], ([tool, op]) => {
  if (tool && !op) { closeRail(); return }
  if (op) { closeFileSheet(); closeEffectsMenu() }
}, { immediate: true })
installEditorShell()
const { isDragOver, onDragEnter, onDragOver, onDragLeave, onDrop } = useWorkspaceDrop()
</script>

<template>
  <div
    class="m-shell"
    data-testid="mobile-shell"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <MobileTopBar />

    <!-- Everything between the header and the transport. The tool sheet and
         the file switcher rise inside it, so the transport and the bottom
         bar stay in reach. -->
    <div class="m-main">
      <template v-if="hasFile">
        <WaveformOverview class="m-overview" />
        <div class="m-wave">
          <WaveformArea />
          <WaveformScrollbar collapse />
          <ProcessingOverlay v-if="state.isProcessing" />
        </div>
        <!-- Always there with a file: Split and Paste work at the playhead
             with nothing selected. -->
        <MobileSelectionBar />
      </template>
      <EmptyState v-else class="flex-1 min-h-0" />

      <Transition name="m-sheet">
        <MobileToolSheet v-if="state.railOperation" />
      </Transition>
      <Transition name="m-sheet">
        <MobileFileSheet v-if="fileSheetOpen && hasFile" />
      </Transition>
    </div>

    <MobileTransport />
    <MobileTabBar />

    <MobileEffectsMenu v-if="effectsMenuOpen && hasFile" />

    <div v-if="isDragOver" class="m-drop">Drop to open</div>
  </div>
</template>

<style scoped>
.m-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  font-family: 'Inter', sans-serif;
  background: var(--color-chrome);
  padding-top: env(safe-area-inset-top, 0px);
}
.m-main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-workspace);
}
.m-overview { margin: 2px 10px 6px; flex-shrink: 0; }
.m-wave {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #0c0f13, #080a0d);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
}
.m-drop {
  position: absolute;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  pointer-events: none;
  background: rgba(8,11,15,.72);
  color: #eaf6f8;
  font-weight: 700;
}
.m-sheet-enter-active,
.m-sheet-leave-active { transition: transform .25s ease, opacity .2s ease; }
.m-sheet-enter-from,
.m-sheet-leave-to { transform: translateY(100%); opacity: 0; }

/* A phone on its side (390 px tall): the waveform gets the height. The
   overview goes (pinch and the scrollbar still navigate), and the bars above
   and below it slim down in their own components. */
@media (max-height: 500px) {
  .m-overview { display: none; }
}
.m-wave { min-height: 96px; }
</style>
