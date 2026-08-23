<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { useFileSave } from '../composables/useFileSave.js'
import BaseButton from './ui/BaseButton.vue'
import Icon from './ui/Icon.vue'
import FileTabs from './FileTabs.vue'


const {
  state, appState, hasFile, documentCount, undo, redo, canUndo, canRedo,
  activeDoc, documentHasUnsavedWork,
} = useEditorState()
const { promptForFiles } = useFileImport()
const { saveDocument, saveDocumentAs, isSaving } = useFileSave()

// The dot on the Save button. It is the only place the app says "you have work
// that isn't on disk yet", so it tracks the same predicate the close guard and
// the beforeunload handler use rather than a second idea of dirtiness.
const isDirty = computed(() => !!activeDoc.value && documentHasUnsavedWork(activeDoc.value.id))

// Save As lives behind a caret rather than as a second full button: this row
// runs out of width the moment the tab strip fills, and Save As is the rarer
// of the two by a wide margin once a document has a destination.
const saveMenuOpen = ref(false)

function toggleSaveMenu() {
  saveMenuOpen.value = !saveMenuOpen.value
}

function runSaveAs() {
  saveMenuOpen.value = false
  saveDocumentAs()
}

function closeSaveMenu(e) {
  if (!e.target.closest?.('[data-save-menu]')) saveMenuOpen.value = false
}

onMounted(() => window.addEventListener('click', closeSaveMenu))
onUnmounted(() => window.removeEventListener('click', closeSaveMenu))

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// The tab strip names the active file, so this row carries the properties a
// tab has no room for instead of repeating the filename.
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
</script>

<template>
  <div
    class="h-[56px] flex items-center px-5 gap-[13px] shrink-0 z-10 border-b border-[rgba(255,255,255,.06)]"
    style="background:linear-gradient(rgb(20, 25, 34), rgb(14, 17, 22));"
  >
    <!-- Logo -->
    <div class="flex items-center gap-[13px] shrink-0">
      <div
        class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center"
        style="background:linear-gradient(135deg,#7ef0ff,#25b6d0);box-shadow:0 0 16px rgba(53,211,230,.5)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#08161a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h3l2-6 3 13 3-16 2 9h5"/></svg>
      </div>
      <span class="font-['Inter'] text-[15px] font-extrabold tracking-[0.2em] text-[#eaf6f8]">WAVELY</span>
    </div>

    <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)]"></div>

    <!-- Active file properties -->
    <div class="flex-1 flex items-center gap-[8px] overflow-hidden" v-if="fileMeta">
      <span
        class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px] whitespace-nowrap shrink-0"
        style="color:#7fe9f6;background:rgba(53,211,230,.14);border:1px solid rgba(53,211,230,.3)"
      >{{ fileMeta.format }}</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.duration }}</span>
      <span class="text-[rgba(255,255,255,.15)] shrink-0">·</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.channels }}</span>
      <span class="text-[rgba(255,255,255,.15)] shrink-0">·</span>
      <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] whitespace-nowrap shrink-0">{{ fileMeta.sampleRate }}</span>
    </div>
    <div v-else class="flex-1"></div>

        <FileTabs />

    <!-- Actions -->
    <div class="flex items-center gap-2">
      <!-- History. Icon-only: the arrows are unambiguous and the labels were
           costing width this row doesn't have once the tab strip fills up. -->
      <BaseButton
        size="md" color="ghost" :pill="false"
        :disabled="!canUndo"
        @click="undo"
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <Icon name="undo" :size="15" /> Undo
      </BaseButton>
      <BaseButton
        size="md" color="ghost" :pill="false"
        :disabled="!canRedo"
        @click="redo"
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
      >
        <Icon name="redo" :size="15" /> Redo
      </BaseButton>

      <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] mx-1"></div>

      <!-- Save + Save As. The caret's menu is a single item today; it exists
           because a Save that silently retargets is worse than one extra
           click, and "save a copy somewhere else" has to be reachable. -->
      <div class="flex items-center" data-save-menu>
        <BaseButton
          size="md" color="ghost" :pill="false"
          :disabled="!hasFile || isSaving"
          @click="saveDocument()"
          :title="isDirty ? 'Save — unsaved edits (Ctrl+S)' : 'Save (Ctrl+S)'"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          {{ isSaving ? 'Saving…' : 'Save' }}
          <span
            v-if="isDirty && !isSaving"
            class="w-[6px] h-[6px] rounded-full shrink-0"
            style="background:#e0b84a"
            aria-label="Unsaved changes"
          ></span>
        </BaseButton>
        <div class="relative">
          <button
            class="h-[30px] w-[18px] flex items-center justify-center rounded-[7px] transition-colors hover:bg-[rgba(255,255,255,.09)] disabled:opacity-40"
            style="color:rgba(255,255,255,.55)"
            :disabled="!hasFile || isSaving"
            title="Save As… (Ctrl+Shift+S)"
            aria-label="Save As"
            @click.stop="toggleSaveMenu"
          >
            <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div
            v-if="saveMenuOpen"
            class="absolute right-0 top-[34px] z-[400] min-w-[150px] rounded-[10px] overflow-hidden py-1"
            style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 16px 40px rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08)"
          >
            <button
              class="w-full text-left px-3 py-[7px] text-[12px] font-semibold transition-colors hover:bg-[rgba(255,255,255,.08)]"
              style="color:#eaf6f8"
              @click="runSaveAs"
            >Save As…</button>
          </div>
        </div>
      </div>

      <BaseButton
        size="md" :pill="false"
        :disabled="!hasFile"
        @click="appState.exportDialogOpen = true"
        :title="documentCount > 1 ? 'Export files (Ctrl+E)' : 'Export as WAV (Ctrl+E)'"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
        Export
      </BaseButton>
    </div>
  </div>
</template>
