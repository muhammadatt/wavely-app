<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { formatDuration } from '../utils/format.js'
import { documentStatus } from '../utils/documentStatus.js'
import { focusRenameInput } from '../utils/renameInput.js'

/**
 * Tab strip for open documents, plus the properties of whichever one is active.
 *
 * Tabs handle the "few files I'm actively holding" case. Past what fits at the
 * minimum tab width they collapse into an overflow chip that opens FilesPanel,
 * which is the navigation surface once you have ten-plus files. The strip never
 * scrolls horizontally — scrolling tab strips are miserable to use.
 *
 * The format/duration/channel readout lives at the right of this row rather
 * than up in the command bar: it describes the active document, so it belongs
 * on the same line as the tab that chose it.
 */

const {
  state, appState, documents, activeDoc, setActiveDocument, closeDocument,
  documentHasUnsavedWork, renameDocument,
} = useEditorState()
const { promptForFiles } = useFileImport()

// The tab names the active file, so this readout carries the properties a tab
// has no room for instead of repeating the filename.
const fileMeta = computed(() => {
  const f = state.currentFile
  if (!f) return null
  return {
    format: f.name.split('.').pop().toUpperCase(),
    duration: formatDuration(f.duration),
    channels: f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`,
    sampleRate: `${(f.sampleRate / 1000).toFixed(1)} kHz`,
  }
})

const MIN_TAB_WIDTH = 110
const MAX_TAB_WIDTH = 190
const CONTROLS_WIDTH = 40   // the "+" button
const OVERFLOW_WIDTH = 62   // the "+N" chip

const stripEl = ref(null)
const stripWidth = ref(0)
let resizeObserver = null

const capacity = computed(() => {
  const total = documents.value.length
  if (!stripWidth.value || total === 0) return total
  const free = stripWidth.value - CONTROLS_WIDTH
  const fitsAll = Math.floor(free / MIN_TAB_WIDTH)
  if (fitsAll >= total) return total
  // Everything doesn't fit, so the overflow chip has to be paid for too.
  return Math.max(1, Math.floor((free - OVERFLOW_WIDTH) / MIN_TAB_WIDTH))
})

const overflowCount = computed(() => Math.max(0, documents.value.length - capacity.value))

/**
 * The first `capacity` documents — except the active one is always shown. If
 * it sits past the cut, it takes the last visible slot so clicking a file in
 * the panel always surfaces it as a tab.
 */
const visibleDocs = computed(() => {
  const docs = documents.value
  const n = capacity.value
  if (n >= docs.length) return docs
  const head = docs.slice(0, n)
  const active = activeDoc.value
  if (active && !head.some(d => d.id === active.id)) head[n - 1] = active
  return head
})

const tabWidth = computed(() => {
  const n = visibleDocs.value.length
  if (!n || !stripWidth.value) return MAX_TAB_WIDTH
  const free = stripWidth.value - CONTROLS_WIDTH - (overflowCount.value ? OVERFLOW_WIDTH : 0)
  return Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, Math.floor(free / n)))
})

function measure() {
  if (stripEl.value) stripWidth.value = stripEl.value.clientWidth
}

onMounted(() => {
  measure()
  resizeObserver = new ResizeObserver(measure)
  if (stripEl.value) resizeObserver.observe(stripEl.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

function handleClose(doc) {
  if (documentHasUnsavedWork(doc.id)) {
    // Edits made since the last save are held in memory only, so closing
    // genuinely discards them.
    const ok = window.confirm(`"${doc.name}" has unsaved edits. Close it anyway?`)
    if (!ok) return
  }
  closeDocument(doc.id)
}

// Middle-click closes, matching every tabbed interface people already use.
function handleAuxClick(e, doc) {
  if (e.button === 1) {
    e.preventDefault()
    handleClose(doc)
  }
}

// ── Inline rename ────────────────────────────────────────────────────────────
const renamingId = ref(null)
const renameDraft = ref('')

function startRename(doc) {
  renamingId.value = doc.id
  renameDraft.value = doc.name
}

function commitRename() {
  if (renamingId.value) renameDocument(renamingId.value, renameDraft.value)
  renamingId.value = null
}

// ── Per-tab status ───────────────────────────────────────────────────────────
// The dot is the whole point of a tab over a plain label: mastered/compliant
// state is visible without opening each file. Definition is shared with the
// files panel, which renders the same state as a text label.
const statusOf = documentStatus
</script>

<template>
  <div
    v-if="documents.length > 0"
    class="h-[36px] flex items-stretch shrink-0 px-2 gap-[3px] border-b border-[rgba(255,255,255,.06)]"
    style="background:linear-gradient(180deg,#12161b,#0f1318)"
  >

    <div ref="stripEl" class="flex-1 min-w-0 flex items-stretch gap-[3px]">
      <div
        v-for="doc in visibleDocs"
        :key="doc.id"
        class="group relative flex items-center gap-[6px] px-[9px] rounded-t-[8px] cursor-pointer select-none transition-colors shrink-0 overflow-hidden"
        :style="{
          width: `${tabWidth}px`,
          background: doc.id === appState.activeDocumentId ? 'rgba(53,211,230,.10)' : 'rgba(255,255,255,.06)',
          boxShadow: doc.id === appState.activeDocumentId
            ? 'inset 0 -2px 0 0 #35d3e6'
            : 'inset 0 0 0 1px rgba(255,255,255,.05)',
        }"
        :title="doc.name"
        @click="setActiveDocument(doc.id)"
        @dblclick.stop="startRename(doc)"
        @auxclick="handleAuxClick($event, doc)"
      >
        <!-- Status dot. The 'edited' state is deliberately excluded: the
             unsaved marker to the right of the name already says it, and two
             dots on one tab for one fact reads as two facts. -->
        <template v-if="statusOf(doc) && statusOf(doc).kind !== 'edited'">
          <div
            v-if="statusOf(doc).kind === 'processing'"
            class="w-[9px] h-[9px] rounded-full shrink-0"
            style="border:1.5px solid rgba(255,255,255,.15);border-top-color:#35d3e6;animation:spin .7s linear infinite"
            title="Processing"
          ></div>
          <div
            v-else
            class="w-[6px] h-[6px] rounded-full shrink-0"
            :style="{ background: statusOf(doc).color }"
            :title="statusOf(doc).title"
          ></div>
        </template>

        <input
          v-if="renamingId === doc.id"
          :ref="focusRenameInput"
          v-model="renameDraft"
          class="flex-1 min-w-0 bg-transparent outline-none text-[11.5px] font-semibold text-[#eaf6f8] border-b border-[#35d3e6]"
          @click.stop
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="renamingId = null"
          @blur="commitRename"
        />
        <span
          v-else
          class="flex-1 min-w-0 truncate text-[11.5px] font-semibold"
          :style="{ color: doc.id === appState.activeDocumentId ? '#eaf6f8' : 'rgba(255,255,255,.5)' }"
        >{{ doc.name }}</span>

        <!-- Unsaved marker. Separate from the status dot on the left, which
             answers a different question (has this been mastered, did it
             certify) and would otherwise have to mean two things at once. -->
        <span
          v-if="documentHasUnsavedWork(doc.id)"
          class="w-[6px] h-[6px] rounded-full shrink-0 group-hover:hidden"
          style="background:#e0b84a"
          title="Unsaved edits"
        ></span>

        <!-- Close — revealed on hover or when active, so idle tabs stay quiet -->
        <button
          class="w-[15px] h-[15px] rounded-[4px] shrink-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[rgba(255,255,255,.12)]"
          :class="{ 'opacity-60': doc.id === appState.activeDocumentId }"
          :aria-label="`Close ${doc.name}`"
          @click.stop="handleClose(doc)"
        >
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" style="color:rgba(255,255,255,.75)" stroke-width="3.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>

        <!-- Processing progress hairline along the tab's bottom edge -->
        <div
          v-if="doc.isProcessing"
          class="absolute bottom-0 left-0 h-[2px] transition-all duration-500"
          style="background:linear-gradient(90deg,#35d3e6,#e0b84a)"
          :style="{ width: `${(doc.processingProgress || 0) * 100}%` }"
        ></div>
      </div>

      <!-- Overflow chip -->
      <button
        v-if="overflowCount > 0"
        class="shrink-0 flex items-center gap-[3px] px-[9px] rounded-t-[8px] text-[11px] font-bold transition-colors hover:bg-[rgba(255,255,255,.06)]"
        style="color:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)"
        :title="`${overflowCount} more file${overflowCount === 1 ? '' : 's'} — open the files panel`"
        @click="appState.filesPanelOpen = true"
      >
        +{{ overflowCount }}
        <svg viewBox="0 0 24 24" class="w-[10px] h-[10px] fill-none stroke-current" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      <!-- Add files — sits directly after the last tab rather than pinned to
           the far right, so it reads as "one more tab" and stays within a
           short mouse trip of the tabs themselves. -->
      <button
        class="w-[30px] shrink-0 flex items-center justify-center rounded-t-[8px] transition-colors bg-[rgba(255,255,255,.06)] hover:bg-[rgba(255,255,255,.15)] cursor-pointer"
        style="color:rgba(255,255,255,.5)"
        title="Add audio files (Ctrl+O)"
        aria-label="Add audio files"
        @click="promptForFiles()"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>

        <!-- Files entry point + active file properties, packed left so the tabs
         start immediately after them. This region sits outside the measured
         strip, so the tab capacity maths accounts for it for free via the
         ResizeObserver.

         Search, rename, bulk close and bulk export used to be reachable only
         via the overflow chip — which does not exist below the overflow
         threshold — or an unadvertised Ctrl+P. -->
    <div class="flex items-center gap-[8px] shrink-0 pr-3">
      <button
        class="flex items-center gap-[5px] px-[9px] py-4 h-[22px] rounded-[7px] text-[12px] font-bold transition-colors hover:bg-[rgba(255,255,255,.09)]"
        style="color:rgba(255,255,255,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)"
        title="All files — search, rename, bulk export (Ctrl+P)"
        @click="appState.filesPanelOpen = true"
      >
        <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
        Files
        <span class="font-['JetBrains_Mono'] text-[10px] font-semibold text-[rgba(255,255,255,.35)]">{{ documents.length }}</span>
      </button>

    </div>
  </div>
</template>
