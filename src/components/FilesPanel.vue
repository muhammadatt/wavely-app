<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatDuration } from '../utils/format.js'
import { documentStatus } from '../utils/documentStatus.js'
import WaveformThumbnail from './WaveformThumbnail.vue'
import BaseButton from './ui/BaseButton.vue'

/**
 * Transient overlay for finding and managing documents.
 *
 * Deliberately not a permanent sidebar: in a waveform editor, width *is* time
 * resolution, so navigation chrome that lives on the left costs the user
 * detail on every file forever. This appears on demand instead — tabs remain
 * the surface for the few files you're actively holding.
 */

const {
  appState, documents, setActiveDocument, closeDocument, closeDocuments,
  documentHasUnsavedWork, renameDocument,
} = useEditorState()
const { promptForFiles } = useFileImport()

const query = ref('')
const searchInput = ref(null)
// Bulk selection lives here, not in the tab strip — the editor already uses
// "selection" to mean a time range, and a second persistent meaning of the
// word in the primary navigation is a reliable way to confuse people.
const marked = ref(new Set())

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return documents.value
  return documents.value.filter(d => d.name.toLowerCase().includes(q))
})

const markedCount = computed(() => marked.value.size)

function toggleMark(docId) {
  const next = new Set(marked.value)
  if (next.has(docId)) next.delete(docId)
  else next.add(docId)
  marked.value = next
}

function clearMarks() {
  marked.value = new Set()
}

function open(docId) {
  setActiveDocument(docId)
  close()
}

function close() {
  appState.filesPanelOpen = false
  clearMarks()
  query.value = ''
}

function docDuration(doc) {
  return formatDuration(getTimelineDuration(doc.segments))
}

function handleClose(doc) {
  if (documentHasUnsavedWork(doc.id) &&
      !window.confirm(`"${doc.name}" has unsaved edits. Close it anyway?`)) return
  closeDocument(doc.id)
}

function closeMarked() {
  const ids = [...marked.value]
  const dirty = ids.filter(documentHasUnsavedWork)
  if (dirty.length > 0 && !window.confirm(
    `${dirty.length} of these ${ids.length} files ${dirty.length === 1 ? 'has' : 'have'} unsaved edits. Close them anyway?`
  )) return
  closeDocuments(ids)
  clearMarks()
}

function exportMarked() {
  // Hand the marked set to the export dialog as its initial checked state.
  appState.exportPreselection = [...marked.value]
  appState.filesPanelOpen = false
  appState.exportDialogOpen = true
  clearMarks()
}

// ── Rename ───────────────────────────────────────────────────────────────────
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

function focusInput(el) {
  if (el) { el.focus(); el.select() }
}

// ── Status ───────────────────────────────────────────────────────────────────
// Same definition the tab strip renders as a dot.
const statusLabel = documentStatus

onMounted(() => nextTick(() => searchInput.value?.focus()))

function onKeydown(e) {
  if (e.key === 'Escape') { e.stopPropagation(); close() }
}

// Closing the last document from inside the panel should dismiss it rather
// than leave an empty overlay floating over the empty state.
watch(documents, docs => { if (docs.length === 0) close() })
</script>

<template>
  <div
    class="fixed inset-0 z-[400] flex items-start justify-center pt-[12vh] px-4"
    style="background:rgba(5,7,9,.6);backdrop-filter:blur(5px)"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="w-full max-w-[560px] max-h-[70vh] flex flex-col rounded-[18px] overflow-hidden font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07);animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
    >
      <!-- Search -->
      <div class="flex items-center gap-[10px] px-4 py-[13px] border-b border-[rgba(255,255,255,.07)]">
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" style="color:rgba(255,255,255,.35)" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input
          ref="searchInput"
          v-model="query"
          placeholder="Search open files…"
          class="flex-1 bg-transparent outline-none text-[13px] font-medium text-[#eaf6f8] placeholder:text-[rgba(255,255,255,.3)]"
        />
        <span class="font-['JetBrains_Mono'] text-[10.5px] font-semibold text-[rgba(255,255,255,.3)] shrink-0">
          {{ filtered.length }}/{{ documents.length }}
        </span>
      </div>

      <!-- List -->
      <div class="flex-1 overflow-y-auto p-2 flex flex-col gap-[3px] min-h-0">
        <div
          v-for="doc in filtered"
          :key="doc.id"
          class="group flex items-center gap-[10px] p-2 rounded-[10px] cursor-pointer transition-colors"
          :style="doc.id === appState.activeDocumentId
            ? 'background:rgba(53,211,230,.10);box-shadow:inset 0 0 0 1px rgba(53,211,230,.28)'
            : 'background:rgba(255,255,255,.02)'"
          @click="open(doc.id)"
        >
          <!-- Bulk-select checkbox -->
          <button
            class="w-[16px] h-[16px] rounded-[5px] shrink-0 flex items-center justify-center transition-all"
            :style="marked.has(doc.id)
              ? 'background:#35d3e6;box-shadow:inset 0 0 0 1px #35d3e6'
              : 'box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.18)'"
            :aria-label="`Select ${doc.name}`"
            :aria-pressed="marked.has(doc.id)"
            @click.stop="toggleMark(doc.id)"
          >
            <svg v-if="marked.has(doc.id)" viewBox="0 0 24 24" class="w-[10px] h-[10px] fill-none stroke-current" style="color:#08161a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>

          <WaveformThumbnail
            :doc="doc"
            :width="104"
            :height="28"
            :color="doc.id === appState.activeDocumentId ? 'rgba(127,233,246,.7)' : 'rgba(255,255,255,.3)'"
            class="shrink-0"
          />

          <div class="flex-1 min-w-0">
            <input
              v-if="renamingId === doc.id"
              :ref="focusInput"
              v-model="renameDraft"
              class="w-full bg-transparent outline-none text-[12.5px] font-bold text-[#eaf6f8] border-b border-[#35d3e6]"
              @click.stop
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingId = null"
              @blur="commitRename"
            />
            <div
              v-else
              class="text-[12.5px] font-bold truncate text-[#eaf6f8]"
              :title="doc.name"
              @dblclick.stop="startRename(doc)"
            >{{ doc.name }}</div>

            <div class="flex items-center gap-[6px] mt-[2px]">
              <span class="font-['JetBrains_Mono'] text-[10.5px] font-semibold text-[rgba(255,255,255,.35)]">{{ docDuration(doc) }}</span>
              <template v-if="statusLabel(doc)">
                <span class="text-[rgba(255,255,255,.15)] text-[10px]">·</span>
                <span class="text-[10.5px] font-bold truncate" :style="{ color: statusLabel(doc).color }">{{ statusLabel(doc).label }}</span>
              </template>
            </div>
          </div>

          <button
            class="w-[22px] h-[22px] rounded-[6px] shrink-0 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-[rgba(255,255,255,.1)]"
            :aria-label="`Close ${doc.name}`"
            @click.stop="handleClose(doc)"
          >
            <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" style="color:rgba(255,255,255,.6)" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div v-if="filtered.length === 0" class="py-10 text-center text-[12px] font-semibold text-[rgba(255,255,255,.3)]">
          No files match “{{ query }}”
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center gap-2 px-3 py-[11px] border-t border-[rgba(255,255,255,.07)]">
        <BaseButton size="sm" color="ghost" :pill="false" @click="promptForFiles()">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          Upload
        </BaseButton>

        <div class="flex-1"></div>

        <template v-if="markedCount > 0">
          <span class="text-[11px] font-bold text-[rgba(255,255,255,.45)]">{{ markedCount }} selected</span>
          <BaseButton size="sm" color="ghost" :pill="false" @click="closeMarked">Close</BaseButton>
          <BaseButton size="sm" :pill="false" @click="exportMarked">Export</BaseButton>
        </template>
        <span v-else class="text-[11px] font-semibold text-[rgba(255,255,255,.28)]">
          Double-click a name to rename
        </span>
      </div>
    </div>
  </div>
</template>
