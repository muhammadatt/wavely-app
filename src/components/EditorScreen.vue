<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { useWindows } from '../composables/useWindows.js'
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

const {
  state, appState, performCut, performCopy, performPaste,
  undo, redo, canUndo, canRedo, hasSelection, hasClipboard, hasFile,
  selectAll, clearSelection, setPlayhead, totalDuration,
  closeRail, openCommandPalette, closeCommandPalette, closeContextMenu,
  documents, cycleDocument, setActiveDocument, closeDocument,
  documentHasUnsavedWork, activeDoc,
} = useEditorState()
const { importFiles, promptForFiles } = useFileImport()
const { closeTopWindow, anyWindowOpen } = useWindows()

const NUDGE_SECONDS = 1
const NUDGE_SECONDS_COARSE = 5

// ── Workspace-wide drag-drop ────────────────────────────────────────────────
// Dropping was previously only possible on the empty state, which is why a new
// file needed a page refresh. The whole workspace is a drop target now.
const isDragOver = ref(false)
const dragDepth = ref(0)

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth.value++
  isDragOver.value = true
}

function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(e) {
  if (!hasFiles(e)) return
  dragDepth.value--
  if (dragDepth.value <= 0) { dragDepth.value = 0; isDragOver.value = false }
}

function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth.value = 0
  isDragOver.value = false
  importFiles(e.dataTransfer.files)
}

// A shortcut must never reach the timeline from inside a text field — the guard
// belongs on every branch, not just the clipboard ones.
function isTextField(target) {
  return !!target.closest?.('input, textarea, select, [contenteditable="true"]')
}

// The Escape ladder, top layer first. Floating windows sit above the dialogs
// because they're the thing the user most recently reached for.
function closeTopModal() {
  if (appState.contextMenu) { closeContextMenu(); return true }
  if (appState.commandPaletteOpen) { closeCommandPalette(); return true }
  if (closeTopWindow()) return true
  if (appState.exportDialogOpen) { appState.exportDialogOpen = false; return true }
  if (appState.filesPanelOpen) { appState.filesPanelOpen = false; return true }
  return false
}

function handleKeydown(e) {
  // Shift changes e.key's case ('z' → 'Z'), so match on the lowered key
  // throughout or every Shift-modified shortcut silently never fires.
  const key = e.key.toLowerCase()
  const inText = isTextField(e.target)
  const modalOpen = anyWindowOpen.value || appState.commandPaletteOpen ||
    appState.contextMenu || appState.exportDialogOpen || appState.filesPanelOpen

  // Escape — close the top modal, then the selection, then the rail.
  if (e.key === 'Escape') {
    if (closeTopModal()) { e.preventDefault(); return }
    if (hasSelection.value) { clearSelection(); e.preventDefault(); return }
    if (state.activeTool) { closeRail(); e.preventDefault() }
    return
  }

  // Ctrl+K opens search. Deliberately above the modalOpen guard so it still
  // works with a plugin window open — that's the point of a command palette.
  if ((e.ctrlKey || e.metaKey) && key === 'k') {
    if (!hasFile.value) return
    e.preventDefault()
    openCommandPalette()
    return
  }

  if (modalOpen || inText) return

  // ── Document-level shortcuts ──────────────────────────────────────────────
  // These sit above the hasFile guard on purpose: opening a file and switching
  // between files must work when the editor is empty or busy processing.
  if ((e.ctrlKey || e.metaKey) && key === 'o') {
    e.preventDefault()
    promptForFiles()
    return
  }

  if ((e.ctrlKey || e.metaKey) && key === 'e') {
    if (!hasFile.value) return
    e.preventDefault()
    appState.exportDialogOpen = true
    return
  }

  if ((e.ctrlKey || e.metaKey) && key === 'p') {
    if (documents.value.length === 0) return
    e.preventDefault()
    appState.filesPanelOpen = true
    return
  }

  // Document navigation deliberately avoids Ctrl+Tab, Ctrl+W and Ctrl+1..9:
  // browsers reserve all three and preventDefault does not reclaim them, so
  // binding them would either do nothing or — for Ctrl+W — close the page and
  // discard every open document. Ctrl+Alt+… is not reserved.
  if ((e.ctrlKey || e.metaKey) && e.altKey) {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      if (documents.value.length < 2) return
      e.preventDefault()
      cycleDocument(e.code === 'ArrowRight' ? 1 : -1)
      return
    }

    // Match on e.code so the digits work regardless of keyboard layout.
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) {
      const docs = documents.value
      if (docs.length === 0) return
      e.preventDefault()
      const n = Number(digit[1])
      const target = n === 9 ? docs[docs.length - 1] : docs[n - 1]
      if (target) setActiveDocument(target.id)
      return
    }

    if (e.code === 'KeyW') {
      const doc = activeDoc.value
      if (!doc) return
      e.preventDefault()
      if (documentHasUnsavedWork(doc.id) &&
          !window.confirm(`"${doc.name}" has unsaved edits. Close it anyway?`)) return
      closeDocument(doc.id)
      return
    }
  }

  // Nothing below should reach the timeline while a job is in flight on this
  // document (its timeline is about to be replaced) or when nothing is open.
  if (state.isProcessing || !hasFile.value) return

  // Space — play/pause (handled in TransportBar via event bus). Focus lands on
  // whichever button was last clicked, and in an editor Space means transport,
  // not "press that button again".
  if (e.code === 'Space') {
    e.preventDefault()
    if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur()
    window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
    return
  }

  // Ctrl+Z — undo
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
    e.preventDefault()
    if (canUndo.value) undo()
    return
  }

  // Ctrl+Shift+Z or Ctrl+Y — redo
  if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && key === 'z') || key === 'y')) {
    e.preventDefault()
    if (canRedo.value) redo()
    return
  }

  // Ctrl+A — select all, matching the SelectionBar button
  if ((e.ctrlKey || e.metaKey) && key === 'a') {
    e.preventDefault()
    selectAll()
    return
  }

  // Ctrl+X — cut selection
  if ((e.ctrlKey || e.metaKey) && key === 'x') {
    if (!hasSelection.value) return
    e.preventDefault()
    performCut()
    return
  }

  // Ctrl+C — copy selection. Left alone when the user is copying page text
  // (a filename, a measurement from the report) rather than audio.
  if ((e.ctrlKey || e.metaKey) && key === 'c') {
    const textSelected = !window.getSelection()?.isCollapsed
    if (!hasSelection.value || textSelected) return
    e.preventDefault()
    performCopy()
    return
  }

  // Ctrl+V — paste at playhead
  if ((e.ctrlKey || e.metaKey) && key === 'v') {
    if (!hasClipboard.value) return
    e.preventDefault()
    performPaste(state.playhead)
    return
  }

  if (e.ctrlKey || e.metaKey) return

  // Delete / Backspace — same operation as the toolbar's Cut, so the clipboard
  // is written here too. There is no separate non-clipboard removal.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (!hasSelection.value) return
    e.preventDefault()
    performCut()
    return
  }

  // Arrow keys — nudge the playhead; Home / End jump to the edges.
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    const step = e.shiftKey ? NUDGE_SECONDS_COARSE : NUDGE_SECONDS
    setPlayhead(state.playhead + (e.key === 'ArrowRight' ? step : -step))
    return
  }
  if (e.key === 'Home') {
    e.preventDefault()
    setPlayhead(0)
    return
  }
  if (e.key === 'End') {
    e.preventDefault()
    setPlayhead(totalDuration.value)
    return
  }

  // + / = — zoom in
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:zoom-in'))
    return
  }

  // - — zoom out
  if (e.key === '-') {
    e.preventDefault()
    window.dispatchEvent(new CustomEvent('wavely:zoom-out'))
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    class="relative flex flex-col h-screen overflow-hidden font-['Inter']"
    style="background:linear-gradient(160deg,#181c22,#0c0f13 62%)"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <TopBar />

    <div class="flex flex-1 overflow-hidden">
      <!-- Workspace -->
      <div class="flex flex-col flex-1 overflow-hidden">
        <FloatingToolbar />

        <FileTabs />  
        <div class="flex-1 min-h-0 p-[14px] pl-5 flex flex-col gap-[10px]">
          <!-- Overview is indented by the dBFS gutter so its time axis shares an
               x-origin with the main waveform below it. -->
   
          <div class="flex shrink-0" v-if="hasFile">
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
</style>
