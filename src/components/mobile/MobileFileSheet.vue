<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useFileImport } from '../../composables/useFileImport.js'
import { useFileSave } from '../../composables/useFileSave.js'
import { useMobileSheets, useSheetDrag } from '../../composables/useMobileSheets.js'
import { getTimelineDuration } from '../../audio/operations.js'
import { exportSettingsFor } from '../../audio/exportPlan.js'
import { FORMATS } from '../../audio/saveFormat.js'
import { formatDuration } from '../../utils/format.js'
import { documentStatus } from '../../utils/documentStatus.js'
import { focusRenameInput } from '../../utils/renameInput.js'
import Icon from '../ui/Icon.vue'

/**
 * The phone's file switcher, in place of the desktop's tabs: the open files as
 * a bottom sheet, opened from the file's name in the header.
 *
 * A row's tap switches to that file and closes the sheet; that is the row's
 * ONLY gesture. Everything else a file can do — Save, Save as, Rename, Close —
 * is a labelled button behind the row's ⋯, never a double-tap or a swipe (the
 * desktop Files panel shipped three bugs from hidden gestures). Rename is an
 * inline field with its own Done. Open audio adds files; "Export several"
 * hands over to the Files panel, which is still the one export surface.
 */
const {
  appState, documents, activeDoc, setActiveDocument, closeDocument,
  documentHasUnsavedWork, renameDocument,
} = useEditorState()
const { promptForFiles } = useFileImport()
const { saveDocument, saveDocumentAs } = useFileSave()
const { closeFileSheet } = useMobileSheets()
const { dragY, handle } = useSheetDrag(closeFileSheet)

const expandedId = ref(null)
const renamingId = ref(null)
const renameDraft = ref('')

// Nothing left to switch between closes the sheet.
watch(() => documents.value.length, n => { if (!n) closeFileSheet() })

function meta(doc) {
  const f = doc.currentFile
  if (!f) return ''
  const ch = f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`
  return [
    FORMATS[exportSettingsFor(doc).format].label,
    formatDuration(getTimelineDuration(doc.segments)),
    ch,
    `${+(f.sampleRate / 1000).toFixed(1)} kHz`,
  ].join(' · ')
}

const rows = computed(() => documents.value.map(doc => ({
  doc,
  active: doc.id === activeDoc.value?.id,
  unsaved: documentHasUnsavedWork(doc.id),
  processing: documentStatus(doc)?.kind === 'processing' ? documentStatus(doc).label : '',
})))

function go(doc) {
  if (renamingId.value) return
  setActiveDocument(doc.id)
  closeFileSheet()
}

function toggleActions(doc) {
  renamingId.value = null
  expandedId.value = expandedId.value === doc.id ? null : doc.id
}

function save(doc) { saveDocument(doc.id) }
function saveAs(doc) { saveDocumentAs(doc.id) }

function startRename(doc) {
  renamingId.value = doc.id
  renameDraft.value = doc.name
}
function commitRename() {
  if (renamingId.value) renameDocument(renamingId.value, renameDraft.value)
  cancelRename()
}
// A finished rename closes the row's actions too: the row reads as it did.
function cancelRename() {
  renamingId.value = null
  expandedId.value = null
}

function close(doc) {
  if (documentHasUnsavedWork(doc.id) &&
      !window.confirm(`"${doc.name}" has unsaved edits. Close it anyway?`)) return
  expandedId.value = null
  closeDocument(doc.id)
}

function openAudio() {
  closeFileSheet()
  promptForFiles()
}

function exportSeveral() {
  closeFileSheet()
  appState.filesPanelOpen = true
}
</script>

<template>
  <section
    class="m-files"
    :class="{ 'is-dragging': dragY > 0 }"
    :style="dragY ? { transform: `translateY(${dragY}px)` } : null"
    data-testid="mobile-file-sheet"
    aria-label="Open files"
  >
    <div class="m-files-handle" aria-hidden="true" v-on="handle"><span /></div>

    <header class="m-files-head">
      <h2 class="m-files-title">Files <span class="m-files-count">{{ documents.length }} open</span></h2>
      <button type="button" class="m-files-x" aria-label="Close" data-testid="mobile-file-sheet-close" @click="closeFileSheet">
        <Icon name="close" :size="12" :stroke-width="2.5" />
      </button>
    </header>

    <div class="m-files-body">
      <div
        v-for="row in rows"
        :key="row.doc.id"
        class="m-file-row"
        :class="{ 'is-active': row.active, 'is-open': expandedId === row.doc.id }"
      >
        <div class="m-file-main">
          <button
            v-if="renamingId !== row.doc.id"
            type="button"
            class="m-file-go"
            :aria-current="row.active ? 'true' : undefined"
            :data-testid="`mobile-file-${row.doc.id}`"
            @click="go(row.doc)"
          >
            <span class="m-file-name">
              <span class="truncate">{{ row.doc.name }}</span>
              <span v-if="row.unsaved" class="m-dot" title="Unsaved edits" />
            </span>
            <span class="m-file-meta">
              <span v-if="row.processing" class="m-file-busy">{{ row.processing }}</span>
              <span v-else>{{ meta(row.doc) }}</span>
            </span>
          </button>
          <form v-else class="m-rename" @submit.prevent="commitRename">
            <input
              :ref="focusRenameInput"
              v-model="renameDraft"
              class="m-rename-input"
              :aria-label="`New name for ${row.doc.name}`"
              data-testid="mobile-file-rename-input"
              @keydown.esc.prevent.stop="cancelRename"
            />
            <button type="submit" class="m-rename-done" data-testid="mobile-file-rename-done">Done</button>
          </form>
          <button
            v-if="renamingId !== row.doc.id"
            type="button"
            class="m-file-more"
            :aria-label="`Actions for ${row.doc.name}`"
            :aria-expanded="expandedId === row.doc.id"
            :data-testid="`mobile-file-actions-${row.doc.id}`"
            @click="toggleActions(row.doc)"
          >
            <Icon name="moreHorizontal" :size="16" />
          </button>
        </div>

        <div v-if="expandedId === row.doc.id && renamingId !== row.doc.id" class="m-file-actions">
          <button type="button" :disabled="!row.unsaved" @click="save(row.doc)">
            <Icon name="save" :size="15" />Save
          </button>
          <button type="button" @click="saveAs(row.doc)"><Icon name="saveAs" :size="15" />Save as</button>
          <button type="button" data-testid="mobile-file-rename" @click="startRename(row.doc)">
            <Icon name="pencil" :size="15" />Rename
          </button>
          <button type="button" class="is-close" data-testid="mobile-file-close" @click="close(row.doc)">
            <Icon name="close" :size="13" :stroke-width="2.5" />Close
          </button>
        </div>
      </div>
    </div>

    <footer class="m-files-foot">
      <button type="button" class="m-files-open" data-testid="mobile-file-open" @click="openAudio">
        <Icon name="plus" :size="15" :stroke-width="2.5" />Add audio
      </button>
      <button v-if="documents.length > 1" type="button" class="m-files-export" @click="exportSeveral">
        Export several…
      </button>
    </footer>
  </section>
</template>

<style scoped>
.m-files {
  position: absolute;
  inset: auto 0 0 0;
  /* Above the plugin windows (WindowLayer: 500 + n): a window's sheet is only
     as tall as its panel, so the file name stays tappable above a short one,
     and the switcher it opens must not slide up behind that window. Under
     the account screen (600) and the dialogs. */
  z-index: 560;
  max-height: 78%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #141922, #0e1116);
  border-top: 1px solid rgba(255,255,255,.08);
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -12px 32px rgba(0,0,0,.55);
  transition: transform .18s ease;
}
.m-files.is-dragging { transition: none; }
.m-files-handle { flex: none; display: grid; place-items: center; height: 18px; touch-action: none; }
.m-files-handle span { width: 36px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); }
.m-files-head {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 12px 10px 16px;
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.m-files-title { flex: 1; margin: 0; font: 800 16px 'Inter', sans-serif; color: #eef2f6; }
.m-files-count { margin-left: 6px; font: 600 12px 'Inter', sans-serif; color: rgba(255,255,255,.45); }
.m-files-x {
  width: 30px; height: 30px; display: grid; place-items: center;
  border: none; border-radius: 8px; background: rgba(255,255,255,.06); color: rgba(255,255,255,.75);
}
.m-files-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-file-row {
  border: 1px solid rgba(255,255,255,.06);
  border-radius: 12px;
  background: rgba(255,255,255,.03);
}
.m-file-row.is-active { border-color: rgba(232,163,61,.45); background: rgba(232,163,61,.07); }
.m-file-main { display: flex; align-items: center; min-height: 56px; }
.m-file-go {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 8px 4px 8px 14px;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
}
.m-file-name { display: flex; align-items: center; gap: 7px; min-width: 0; font: 700 14px 'Inter', sans-serif; color: #eef2f6; }
.is-active .m-file-name { color: #f6c46e; }
.m-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: #e0b84a; }
.m-file-meta {
  font: 500 11px 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,.45);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.m-file-busy { color: #7fe9f6; }
.m-file-more {
  width: 44px; height: 44px; flex: none; margin-right: 6px;
  display: grid; place-items: center;
  border: none; border-radius: 10px; background: none; color: rgba(255,255,255,.6);
}
.m-file-more[aria-expanded='true'] { background: rgba(255,255,255,.07); color: #eef2f6; }
.m-file-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  padding: 0 8px 8px;
}
.m-file-actions button {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 7px 0 6px;
  border: none; border-radius: 10px;
  background: rgba(255,255,255,.05); color: rgba(255,255,255,.8);
  font: 600 10.5px 'Inter', sans-serif;
}
.m-file-actions button:disabled { opacity: .35; }
.m-file-actions .is-close { color: #ff9b8f; }
.m-rename { flex: 1; min-width: 0; display: flex; gap: 6px; padding: 8px; }
.m-rename-input {
  flex: 1; min-width: 0;
  padding: 8px 10px;
  border: 1px solid rgba(232,163,61,.5); border-radius: 9px;
  background: #0b0e12; color: #eef2f6;
  font: 600 16px 'Inter', sans-serif; /* 16 px: iOS zooms the page on a smaller field */
}
.m-rename-done {
  padding: 0 14px; border: none; border-radius: 9px;
  background: #e8a33d; color: #1b1205; font: 700 13px 'Inter', sans-serif;
}
.m-files-foot {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 8px 12px calc(10px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid rgba(255,255,255,.06);
}
.m-files-foot button {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 42px;
  border: none; border-radius: 11px;
  font: 700 13px 'Inter', sans-serif;
}
.m-files-open { background: rgba(53,211,230,.14); color: #7fe9f6; }
.m-files-export { background: rgba(255,255,255,.06); color: rgba(255,255,255,.75); }

@media (max-height: 500px) {
  .m-files { max-height: 92%; }
  .m-file-main { min-height: 46px; }
}
</style>
