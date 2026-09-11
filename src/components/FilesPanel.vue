<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { useFileSave } from '../composables/useFileSave.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatDuration } from '../utils/format.js'
import { documentStatus } from '../utils/documentStatus.js'
import { focusRenameInput } from '../utils/renameInput.js'
import WaveformThumbnail from './WaveformThumbnail.vue'
import BaseButton from './ui/BaseButton.vue'

/**
 * Transient overlay for finding and managing documents.
 *
 * Deliberately not a permanent sidebar: in a waveform editor, width *is* time
 * resolution, so navigation chrome that lives on the left costs the user
 * detail on every file forever. This appears on demand instead — tabs remain
 * the surface for the few files you're actively holding.
 *
 * ⚠ EVERY ACTION HERE IS A LABELLED BUTTON, and that is a correction, not a
 * style preference. The first version had exactly one visible per-row control —
 * an ✕ — and hid the rest behind gestures: the row click switched documents,
 * a double-click on the name renamed, and there was no way to save at all. Two
 * of those failed outright. The ✕ sat where a dialog's dismiss button sits, so
 * it read as "close the panel" and actually closed the *file*. And a
 * double-click delivers two clicks first, so renaming fired the row's own
 * handler twice — the panel dismissed itself and switched documents before the
 * rename input could mount. The gesture could not win a fight with the primary
 * click action, so it does not have to have one: the name still takes a
 * double-click, but every action it shares a row with is reachable by a button
 * with a name on it.
 */

const {
  appState, documents, setActiveDocument, closeDocument, closeDocuments,
  documentHasUnsavedWork, renameDocument,
} = useEditorState()
const { promptForFiles } = useFileImport()
const { saveDocument, saveDocumentAs, isSaving } = useFileSave()

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

// Save and Save As both take a document id, so neither has to make the file
// active first — saving from here leaves you looking at the file you were
// already on, and the panel stays open because the toast is the confirmation.
function handleSave(doc) {
  saveDocument(doc.id)
}

function handleSaveAs(doc) {
  saveDocumentAs(doc.id)
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
      class="w-full max-w-[660px] max-h-[74vh] flex flex-col rounded-[18px] overflow-hidden font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07);animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      aria-label="Files"
    >
      <!-- Title bar. The ✕ up here is the panel's own dismiss, which is the
           whole reason the per-file close moved into a labelled button below:
           one ✕ per screen, and it means what its position says it means. -->
      <div class="flex items-center gap-[9px] px-4 py-[11px] border-b border-[rgba(255,255,255,.07)]">
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current shrink-0" style="color:rgba(255,255,255,.45)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
        <span class="text-[12.5px] font-bold text-[#eaf6f8]">Files</span>
        <span class="font-['JetBrains_Mono'] text-[10.5px] font-semibold text-[rgba(255,255,255,.32)]">{{ documents.length }} open</span>
        <div class="flex-1"></div>
        <button
          class="w-[24px] h-[24px] rounded-[7px] shrink-0 flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.1)]"
          title="Close this panel (Esc)"
          aria-label="Close files panel"
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-[12px] h-[12px] fill-none stroke-current" style="color:rgba(255,255,255,.6)" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Search -->
      <div class="flex items-center gap-[10px] px-4 py-[11px] border-b border-[rgba(255,255,255,.07)]">
        <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" style="color:rgba(255,255,255,.35)" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input
          ref="searchInput"
          v-model="query"
          placeholder="Search open files…"
          aria-label="Search open files"
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
          class="group flex items-center gap-[10px] p-2 rounded-[10px] transition-colors"
          :style="doc.id === appState.activeDocumentId
            ? 'background:rgba(53,211,230,.10);box-shadow:inset 0 0 0 1px rgba(53,211,230,.28)'
            : 'background:rgba(255,255,255,.02)'"
        >
          <!-- Bulk-select checkbox -->
          <button
            class="w-[16px] h-[16px] rounded-[5px] shrink-0 flex items-center justify-center transition-all"
            :style="marked.has(doc.id)
              ? 'background:#35d3e6;box-shadow:inset 0 0 0 1px #35d3e6'
              : 'box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.18)'"
            :aria-label="`Select ${doc.name}`"
            :aria-pressed="marked.has(doc.id)"
            @click="toggleMark(doc.id)"
          >
            <svg v-if="marked.has(doc.id)" viewBox="0 0 24 24" class="w-[10px] h-[10px] fill-none stroke-current" style="color:#08161a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>

          <WaveformThumbnail
            :doc="doc"
            :width="80"
            :height="28"
            :color="doc.id === appState.activeDocumentId ? 'rgba(127,233,246,.7)' : 'rgba(255,255,255,.3)'"
            class="shrink-0 hidden sm:block"
          />

          <div class="flex-1 min-w-0">
            <input
              v-if="renamingId === doc.id"
              :ref="focusRenameInput"
              v-model="renameDraft"
              aria-label="File name"
              class="w-full bg-transparent outline-none text-[12.5px] font-bold text-[#eaf6f8] border-b border-[#35d3e6]"
              @click.stop
              @keydown.enter.prevent.stop="commitRename"
              @keydown.esc.prevent.stop="renamingId = null"
              @blur="commitRename"
            />
            <!-- Double-click still renames, but it is now a shortcut on top of
                 the pencil rather than the only way in, and the name is no
                 longer inside a click target that would fire first. -->
            <div
              v-else
              class="text-[12.5px] font-bold truncate text-[#eaf6f8] cursor-text"
              :title="`${doc.name} — double-click to rename`"
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

          <!-- Per-file actions. Present at rest rather than revealed on hover:
               a panel whose entire purpose is managing files should not hide
               what it can do to them, and hover-only controls are unreachable
               on touch. -->
          <div class="flex items-center gap-[3px] shrink-0 opacity-70 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              v-if="doc.id !== appState.activeDocumentId"
              class="px-[8px] h-[24px] rounded-[6px] text-[10.5px] font-bold transition-colors hover:bg-[rgba(255,255,255,.12)] focus-visible:bg-[rgba(255,255,255,.12)]"
              style="color:rgba(255,255,255,.72)"
              :title="`Switch to ${doc.name}`"
              @click="open(doc.id)"
            >Go to</button>
            <span
              v-else
              class="px-[8px] h-[24px] flex items-center text-[10.5px] font-bold"
              style="color:rgba(127,233,246,.75)"
            >Current</span>

            <button
              class="w-[24px] h-[24px] rounded-[6px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.12)] focus-visible:bg-[rgba(255,255,255,.12)]"
              style="color:rgba(255,255,255,.6)"
              :aria-label="`Rename ${doc.name}`"
              title="Rename"
              @click="startRename(doc)"
            >
              <svg viewBox="0 0 24 24" class="w-[12px] h-[12px] fill-none stroke-current" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
            </button>

            <button
              class="px-[8px] h-[24px] rounded-[6px] text-[10.5px] font-bold transition-colors hover:bg-[rgba(255,255,255,.12)] focus-visible:bg-[rgba(255,255,255,.12)] disabled:opacity-40 disabled:cursor-default"
              :style="documentHasUnsavedWork(doc.id) ? 'color:#e0b84a' : 'color:rgba(255,255,255,.72)'"
              :disabled="isSaving"
              :title="documentHasUnsavedWork(doc.id) ? 'Save — unsaved edits' : 'Save'"
              @click="handleSave(doc)"
            >Save</button>

            <button
              class="px-[8px] h-[24px] rounded-[6px] text-[10.5px] font-bold transition-colors hover:bg-[rgba(255,255,255,.12)] focus-visible:bg-[rgba(255,255,255,.12)] disabled:opacity-40 disabled:cursor-default"
              style="color:rgba(255,255,255,.72)"
              :disabled="isSaving"
              title="Save As… — write a copy to a new file"
              @click="handleSaveAs(doc)"
            >Save As…</button>

            <button
              class="w-[24px] h-[24px] rounded-[6px] flex items-center justify-center transition-colors hover:bg-[rgba(255,138,128,.18)] focus-visible:bg-[rgba(255,138,128,.18)]"
              style="color:rgba(255,255,255,.6)"
              :aria-label="`Close ${doc.name}`"
              title="Close this file"
              @click="handleClose(doc)"
            >
              <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
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
          Tick files to export or close together · Esc dismisses
        </span>
      </div>
    </div>
  </div>
</template>
