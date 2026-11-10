<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileSave } from '../composables/useFileSave.js'
import Icon from './ui/Icon.vue'
import AccountMenu from './AccountMenu.vue'

const {
  state, appState, hasFile, documentCount, undo, redo, canUndo, canRedo,
  activeDoc, documentHasUnsavedWork,
} = useEditorState()
const { saveDocument, saveDocumentAs, isSaving } = useFileSave()

// The dot on the Save button. It is the only place the app says "you have work
// that isn't on disk yet", so it tracks the same predicate the close guard and
// the beforeunload handler use rather than a second idea of dirtiness.
const isDirty = computed(() => !!activeDoc.value && documentHasUnsavedWork(activeDoc.value.id))

// Save As and Export live behind a caret rather than as full buttons: this row
// runs out of width on a narrow window, and both are rarer than Save by a wide
// margin once a document has a destination.
const saveMenuOpen = ref(false)

function toggleSaveMenu() {
  saveMenuOpen.value = !saveMenuOpen.value
}

function runSaveAs() {
  saveMenuOpen.value = false
  saveDocumentAs()
}

function runExport() {
  saveMenuOpen.value = false
  appState.exportDialogOpen = true
}

// Says what Export is FOR, since next to Save As that is the whole question.
const exportHint = computed(() => documentCount.value > 1
  ? `Several of the ${documentCount.value} open files, as WAV`
  : 'Several open files at once, as WAV')

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
    class="h-[56px] compact:h-[44px] flex items-center px-5 compact:px-2 gap-[13px] compact:gap-2 shrink-0 z-10 border-b border-[rgba(255,255,255,.06)]"
    style="background:linear-gradient(rgb(20, 25, 34), rgb(14, 17, 22));"
  >
    <!-- Logo -->
    <div class="flex items-center shrink-0">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[26px] compact:h-[20px] max-sm:h-[17px] w-auto select-none" draggable="false" />
    </div>

    <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] compact:hidden"></div>

    <!-- Active file properties -->
    <div class="flex-1 min-w-0 flex items-center gap-[8px] overflow-hidden compact:invisible" v-if="fileMeta">
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

    <!-- Actions -->
    <div class="flex items-center gap-2 compact:gap-1">
      <!-- History. Icon-only and borderless: the arrows are unambiguous, and
           as bordered, labelled buttons they weighed as much as Save beside
           them — which they are not. -->
      <div class="flex items-center">
        <button
          class="tb-icon"
          :disabled="!canUndo"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          @click="undo"
        ><Icon name="undo" :size="16" /></button>
        <button
          class="tb-icon"
          :disabled="!canRedo"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          @click="redo"
        ><Icon name="redo" :size="16" /></button>
      </div>

      <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] mx-1 compact:mx-0 max-sm:hidden"></div>

      <!-- Save is THE way edited audio goes back to the user, so it is the one
           primary-coloured action on this row: a split button, Save on the
           left, everything else that writes files behind the caret.

           Export used to sit here as its own filled button. Since Save writes
           the file back in its own format, Export's one remaining job is
           several files at once (one WAV, or a zip of many) — so it lives in
           this menu, named for that job, and on the files panel, where files
           are ticked. Ctrl+E still opens it. -->
      <div class="relative flex items-stretch" data-save-menu @keydown.esc="saveMenuOpen = false">
        <button
          class="tb-save tb-save-main"
          :disabled="!hasFile || isSaving"
          :title="isDirty ? 'Save — unsaved edits (Ctrl+S)' : 'Save (Ctrl+S)'"
          @click="saveDocument()"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          <span class="compact:hidden">{{ isSaving ? 'Saving…' : 'Save' }}</span>
          <span
            v-if="isDirty && !isSaving"
            class="tb-dirty"
            aria-label="Unsaved changes"
          ></span>
        </button>
        <button
          class="tb-save tb-save-caret"
          :disabled="!hasFile || isSaving"
          title="Save As, Export…"
          aria-label="More save options"
          aria-haspopup="menu"
          :aria-expanded="saveMenuOpen"
          @click.stop="toggleSaveMenu"
        >
          <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>

        <div
          v-if="saveMenuOpen"
          class="absolute right-0 top-[40px] z-[400] w-[268px] rounded-[10px] overflow-hidden py-1 menu-surface"
          role="menu"
        >
          <button class="tb-menu-item" role="menuitem" @click="runSaveAs">
            <span class="flex-1 min-w-0">
              <span class="tb-menu-title">Save As…</span>
              <span class="tb-menu-sub">New name, format or location</span>
            </span>
            <kbd class="tb-kbd">Ctrl+Shift+S</kbd>
          </button>
          <div class="my-1 h-px bg-[rgba(255,255,255,.08)]"></div>
          <button class="tb-menu-item" role="menuitem" @click="runExport">
            <span class="flex-1 min-w-0">
              <span class="tb-menu-title">Export files…</span>
              <span class="tb-menu-sub">{{ exportHint }}</span>
            </span>
            <kbd class="tb-kbd">Ctrl+E</kbd>
          </button>
        </div>
      </div>

      <AccountMenu />
    </div>
  </div>
</template>

<style scoped>
.tb-icon {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: var(--color-text-softer);
  transition: background-color .12s, color .12s;
}
.tb-icon:hover:not(:disabled) { background: rgba(255, 255, 255, .08); color: var(--color-text); }
.tb-icon:disabled { opacity: .3; cursor: default; }
.tb-icon:focus-visible,
.tb-save:focus-visible,
.tb-menu-item:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.tb-save {
  height: 34px;
  display: flex;
  align-items: center;
  background: var(--color-accent-solid);
  color: #08161a;
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: .02em;
  transition: background-color .12s, opacity .12s;
}
.tb-save:hover:not(:disabled) { background: #9beeff; }
.tb-save:disabled { opacity: .4; cursor: default; }
.tb-save-main {
  gap: 7px;
  padding: 0 14px;
  border-radius: 10px 0 0 10px;
}
.tb-save-caret {
  width: 26px;
  justify-content: center;
  border-radius: 0 10px 10px 0;
  /* The seam that makes it a split button rather than one wide button. */
  box-shadow: inset 1px 0 0 rgba(8, 22, 26, .25);
}
@media (max-width: 639px) {
  .tb-save-main { padding: 0 10px; }
  .tb-save-caret { width: 22px; }
}
/* Amber, as on the tab — the app's one colour for "not on disk yet" — ringed
   in the button's ink so it holds up on the cyan fill. */
.tb-dirty {
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: #e0b84a;
  box-shadow: 0 0 0 1.5px #08161a;
}

.tb-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  text-align: left;
  transition: background-color .12s;
}
.tb-menu-item:hover { background: rgba(255, 255, 255, .08); }
.tb-menu-title { display: block; font-size: 12px; font-weight: 600; color: var(--color-text); }
.tb-menu-sub { display: block; margin-top: 1px; font-size: 10.5px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-kbd {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--color-text-muted);
}
</style>
