<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { useFileSave } from '../composables/useFileSave.js'
import { formatDuration } from '../utils/format.js'
import { splitTabName, sharedTabWidth, TAB_MIN_WIDTH, TAB_FONT } from '../ui/tabName.js'
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
  documentHasUnsavedWork, renameDocument, hasFile,
} = useEditorState()
const { promptForFiles } = useFileImport()
const { saveDocument, saveDocumentAs, isSaving } = useFileSave()

// The dot on the Save button tracks the same predicate the close guard and the
// beforeunload handler use rather than a second idea of dirtiness.
const isDirty = computed(() => !!activeDoc.value && documentHasUnsavedWork(activeDoc.value.id))

// Save As lives behind a caret rather than as a second full button: this row
// gives its width to tabs, and Save As is the rarer of the two by a wide margin
// once a document has a destination.
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

// The tab names the active file, so this readout carries the properties a tab
// has no room for instead of repeating the filename.
const fileMeta = computed(() => {
  const f = state.currentFile
  if (!f) return null
  return {
    format: f.name.split('.').pop().toUpperCase(),
    duration: formatDuration(f.duration),
    channels: f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`,
    sampleRate: `${+(f.sampleRate / 1000).toFixed(1)} kHz`,
  }
})

const MIN_TAB_WIDTH = TAB_MIN_WIDTH
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

// ── Tab width and label ──────────────────────────────────────────────────────
// Every tab shares ONE width: the widest name's natural width (110–280 px),
// shrinking evenly when crowded, so switching files never moves a tab. Text
// is measured on a canvas in the tab's own font; `fontsReady` re-measures
// once Inter has loaded (the fallback font measures narrower).
let measureCtx = null
function textWidth(text) {
  if (typeof document === 'undefined') return text.length * 7
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = TAB_FONT
  return measureCtx.measureText(text).width
}
const fontsReady = ref(0)
onMounted(() => { document.fonts?.ready?.then(() => { fontsReady.value++ }) })

const naturalTabWidth = computed(() => {
  void fontsReady.value
  return sharedTabWidth(documents.value.map(d => d.name), textWidth)
})

const tabWidth = computed(() => {
  const n = visibleDocs.value.length
  if (!n || !stripWidth.value) return naturalTabWidth.value
  const free = stripWidth.value - CONTROLS_WIDTH - (overflowCount.value ? OVERFLOW_WIDTH : 0) - 3 * n
  return Math.max(MIN_TAB_WIDTH, Math.min(naturalTabWidth.value, Math.floor(free / n)))
})

const tabLabel = (doc) => splitTabName(doc.name)

// ── Keyboard (a real tablist) ────────────────────────────────────────────────
function focusTab(id) {
  nextTick(() => stripEl.value?.querySelector(`[data-tab-id="${id}"]`)?.focus())
}

// ⚠ A CLICK MUST NOT LEAVE FOCUS ON A TAB (the tab's @mousedown.prevent).
// The waveform canvas cannot take focus, so a focused tab kept it while the
// user went on to select audio — and their Delete closed the FILE instead of
// deleting the selection (caught by the screenshot run, which lost a tab that
// way). These keys therefore act only on a tab reached with the keyboard.
function onTabKey(e) {
  if (renamingId.value || e.target?.getAttribute?.('role') !== 'tab') return
  const docs = visibleDocs.value
  const i = docs.findIndex(d => d.id === appState.activeDocumentId)
  if (i < 0) return
  let j = null
  if (e.key === 'ArrowRight') j = (i + 1) % docs.length
  else if (e.key === 'ArrowLeft') j = (i - 1 + docs.length) % docs.length
  else if (e.key === 'Home') j = 0
  else if (e.key === 'End') j = docs.length - 1
  else if (e.key === 'Delete') {
    e.preventDefault(); e.stopPropagation()
    handleClose(docs[i])
    if (appState.activeDocumentId) focusTab(appState.activeDocumentId)
    return
  } else if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault(); e.stopPropagation()
    startRename(docs[i])
    return
  }
  if (j === null) return
  e.preventDefault(); e.stopPropagation()
  setActiveDocument(docs[j].id)
  focusTab(docs[j].id)
}

function measure() {
  if (stripEl.value) stripWidth.value = stripEl.value.clientWidth
}

// ⚠ OBSERVE THE STRIP WHENEVER IT MOUNTS, not once in onMounted: the row is
// `v-if`'d on there being documents, so on a fresh page the strip does not
// exist at mount, nothing was ever observed, and stripWidth stayed 0 — which
// reads as "unmeasured, show every tab at full width". Two files on a 390 px
// phone ran their tabs under the Files and Save buttons.
onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
})
watch(stripEl, (el, prev) => {
  if (prev) resizeObserver?.unobserve(prev)
  if (el) { resizeObserver?.observe(el); measure() }
}, { flush: 'post' })

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

// The mastered / ACX status dot is gone from the tab (design 1a): the amber
// unsaved dot is a tab's one marker. Status still shows in the Files panel.
</script>

<template>
  <div
    v-if="documents.length > 0"
    class="tab-row h-[40px] compact:h-[34px] flex items-stretch shrink-0 px-5 compact:px-2 gap-[3px]"
  >

    <!-- Real tabs (design 1a, owner, November 2026): a tablist with a roving
         tabindex — Tab reaches the active tab, ← → Home End move, Delete
         closes. Keys are stopped here: the editor's own window handler reads
         the arrows as the playhead and Delete as "delete the selection". -->
    <div
      ref="stripEl"
      role="tablist"
      aria-label="Open files"
      class="flex-1 min-w-0 flex items-stretch gap-[3px]"
      @keydown="onTabKey"
    >
      <div
        v-for="doc in visibleDocs"
        :key="doc.id"
        role="tab"
        :data-tab-id="doc.id"
        :tabindex="doc.id === appState.activeDocumentId ? 0 : -1"
        :aria-selected="doc.id === appState.activeDocumentId ? 'true' : 'false'"
        class="tab group relative flex items-center gap-[6px] pl-[11px] pr-[4px] rounded-t-[8px] cursor-pointer select-none transition-colors shrink-0 overflow-hidden outline-none"
        :class="doc.id === appState.activeDocumentId ? 'tab-active' : 'tab-idle'"
        :style="{ width: `${tabWidth}px` }"
        :title="doc.name"
        @mousedown.prevent
        @click="setActiveDocument(doc.id)"
        @dblclick.stop="startRename(doc)"
        @auxclick="handleAuxClick($event, doc)"
      >
        <input
          v-if="renamingId === doc.id"
          :ref="focusRenameInput"
          v-model="renameDraft"
          class="flex-1 min-w-0 bg-transparent outline-none text-[12px] font-semibold text-[#eaf6f8] border-b border-[#35d3e6]"
          @click.stop
          @keydown.stop
          @keydown.enter.prevent.stop="commitRename"
          @keydown.esc.prevent.stop="renamingId = null"
          @blur="commitRename"
        />
        <!-- No extension (Format says it) and a middle cut that keeps the
             last six characters, so takes that differ only at the end stay
             tellable apart. The full name is the tab's tooltip. -->
        <span v-else class="tab-name flex-1 min-w-0 flex whitespace-nowrap text-[12px] font-semibold">
          <span class="min-w-0 overflow-hidden text-ellipsis">{{ tabLabel(doc).head }}</span><span class="shrink-0">{{ tabLabel(doc).tail }}</span>
        </span>

        <!-- One 24 px slot at the end: the amber unsaved dot is the tab's only
             marker and sits here, active or not, swapping to the close button
             on hover. A tab with nothing unsaved shows the close button (faint
             on the active tab, hidden on the others until hovered). -->
        <span class="w-[24px] h-[24px] shrink-0 flex items-center justify-center">
          <span
            v-if="documentHasUnsavedWork(doc.id)"
            class="tab-dirty"
            title="Unsaved edits"
          ></span>
          <button
            class="tab-close"
            :class="{ 'has-dirty': documentHasUnsavedWork(doc.id) }"
            tabindex="-1"
            :aria-label="`Close ${doc.name}`"
            @click.stop="handleClose(doc)"
          >
            <svg viewBox="0 0 24 24" class="w-[12px] h-[12px] fill-none stroke-current" stroke-width="3.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </span>

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
        class="tab-idle shrink-0 flex items-center gap-[3px] px-[9px] rounded-t-[8px] text-[11px] font-bold transition-colors cursor-pointer"
        style="color:rgba(255,255,255,.55)"
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
        class="w-[30px] shrink-0 flex items-center justify-center rounded-t-[8px] tab-plus transition-colors cursor-pointer"
        style="color:rgba(255,255,255,.5)"
        title="Add audio files (Ctrl+O)"
        aria-label="Add audio files"
        @click="promptForFiles()"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>

    <!-- Active file properties, at the far end of the row the active tab sits
         in (moved down from the top bar, where they floated a row away from
         the file they describe). Outside the measured strip, so the tab
         capacity maths makes room for them via the ResizeObserver. -->
    <div
      v-if="fileMeta"
      class="w-[260px] flex items-center justify-end gap-[14px] shrink-0 pl-3 max-sm:hidden"
      :title="activeDoc ? activeDoc.name : ''"
    >
      <!-- Label / value pairs: the label names the property, so the format
           needs no badge and the line reads as words rather than a code. -->
      <span class="meta"><span class="meta-k">Format</span> {{ fileMeta.format }}</span>
      <span class="meta tabular-nums"><span class="meta-k">Length</span> {{ fileMeta.duration }}</span>
      <span class="meta"><span class="meta-k">{{ fileMeta.channels }}</span> {{ fileMeta.sampleRate }}</span>
    </div>
    <div v-if="fileMeta" class="w-px h-[18px] self-center bg-[rgba(255,255,255,.12)] mx-3 shrink-0 max-sm:hidden"></div>

    <!-- File actions, beside the files they act on. -->
    <div class="flex items-center gap-[8px] shrink-0">
        <!-- Files: every open document — switch, rename, save, close, and
             EXPORT. Export used to be its own filled button (and its own dialog,
             a second list of the same files with the same checkboxes). Since
             Save writes a file back in its own format, Export's one remaining
             job is several files at once, and that is a files-panel job: tick,
             then Export. Ctrl+E opens the panel with the active file ticked. -->
        <button
          class="tb-files"
          :disabled="documents.length === 0"
          title="Files — switch, rename, export several (Ctrl+P)"
          aria-label="Files"
          @click="appState.filesPanelOpen = true"
        >
          <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          <span><span class="compact:hidden">Files </span>({{ documents.length }})</span>
        </button>

        <!-- Save is THE way edited audio goes back to the user, so it is the one
             filled, primary-coloured button on screen: a split button, Save on
             the left and Save As behind the caret. It sits at the end of the
             tab row because it saves the active tab — and the tab's own amber
             dot is the unsaved state it clears. -->
        <!-- Quiet until there is something to save (design 1a): a neutral
             outline when the file is on disk, the cyan tint and the amber dot
             once it has unsaved edits. The dot's slot is always reserved, so
             the button never changes width and nothing on the row moves. -->
        <div
          class="tb-save-group relative flex items-stretch"
          :class="{ 'is-dirty': isDirty }"
          data-save-menu
          @keydown.esc="saveMenuOpen = false"
        >
          <button
            class="tb-save tb-save-main"
            :disabled="!hasFile || isSaving"
            :title="isDirty ? 'Save — unsaved edits (Ctrl+S)' : 'Saved — nothing new to write (Ctrl+S)'"
            @click="saveDocument()"
          >
            <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] fill-none stroke-current shrink-0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
            <span>{{ isSaving ? 'Saving…' : 'Save' }}</span>
            <span
              class="tb-dirty"
              :class="{ 'is-on': isDirty && !isSaving }"
              :aria-label="isDirty ? 'Unsaved changes' : undefined"
            ></span>
          </button>
          <span class="tb-save-seam" aria-hidden="true"></span>
          <button
            class="tb-save tb-save-caret"
            :disabled="!hasFile || isSaving"
            title="Save As… (Ctrl+Shift+S)"
            aria-label="More save options"
            aria-haspopup="menu"
            :aria-expanded="saveMenuOpen"
            @click.stop="toggleSaveMenu"
          >
            <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>

          <div
            v-if="saveMenuOpen"
            class="absolute right-0 top-[36px] z-[400] w-[268px] rounded-[10px] overflow-hidden py-1 menu-surface"
            role="menu"
          >
            <button class="tb-menu-item" role="menuitem" @click="runSaveAs">
              <span class="flex-1 min-w-0">
                <span class="tb-menu-title">Save As…</span>
                <span class="tb-menu-sub">New name, format or location</span>
              </span>
              <kbd class="tb-kbd">Ctrl+Shift+S</kbd>
            </button>
          </div>
        </div>
    </div>
  </div>
</template>

<style scoped>
/* The last row of the chrome: the one hairline between the chrome and the
   workspace is drawn here, as an inset shadow — the active tab's opaque fill
   paints over it, so that tab opens into the waveform area below the way a
   browser tab does, while the others sit on the line. */
.tab-row {
  background: var(--color-chrome);
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, .08);
}
/* Design 1a (owner, November 2026). The active tab opens into the workspace
   (its fill IS the workspace colour) with the brightest name and a faint
   outline on three sides. The others are a faint wash with a fainter outline,
   one step off the (darker) chrome, so they read as tabs and never as the
   selected one; hover lifts the wash a step. No marker line (a cyan underline
   and a top edge were both tried and dropped, owner). */
.tab-active {
  background: var(--color-workspace);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, .09), inset -1px 0 0 rgba(255, 255, 255, .09), inset 0 1px 0 rgba(255, 255, 255, .09);
}
.tab-idle {
  background: rgba(255, 255, 255, .025);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, .05), inset -1px 0 0 rgba(255, 255, 255, .05), inset 0 1px 0 rgba(255, 255, 255, .05);
}
.tab-idle:hover { background: rgba(255, 255, 255, .045); }
.tab:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.tab-name { color: rgba(255, 255, 255, .5); }
.tab-idle:hover .tab-name { color: rgba(255, 255, 255, .8); }
.tab-active .tab-name { color: var(--color-text); }
.tab-plus {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05);
}
.tab-plus:hover { background: rgba(255, 255, 255, .04); color: rgba(255, 255, 255, .8); }

/* The end slot: the unsaved dot, or the close button (24 px target; it was
   15). The dot gives way to the close button on hover. */
.tab-dirty {
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  background: #e0b84a;
}
.tab:hover .tab-dirty { display: none; }
.tab-close {
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, .75);
  opacity: 0;
  transition: opacity .12s, background-color .12s;
}
.tab-active .tab-close { opacity: .6; }
.tab:hover .tab-close { opacity: 1; }
.tab-close:hover { background: rgba(255, 255, 255, .12); }
.tab-close.has-dirty { display: none; }
.tab:hover .tab-close.has-dirty { display: flex; }
/* Touch has no hover: the active tab always offers its close button (a tab
   with unsaved edits still marks them on Save and in the Files panel). */
@media (pointer: coarse) {
  .tab-close { opacity: 1; }
  .tab-active .tab-dirty { display: none; }
  .tab-active .tab-close.has-dirty { display: flex; }
}

/* 11.5 px: reference text, a step under the tab names (12) and the row's
   buttons (12.5), so the row reads actions → files → details (owner,
   November 2026). */
.meta {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-soft);
  white-space: nowrap;
}
.meta-k {
  font-weight: 500;
  color: rgba(255, 255, 255, .42);
  margin-right: 2px;
}

/* Quiet: a text button, no fill or outline until hovered — Save beside it is
   the one thing on the row that asks to be pressed. */
.tb-files {
  cursor: pointer;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-soft);
  transition: background-color .12s, color .12s;
}
.tb-files:hover:not(:disabled) { background: rgba(255, 255, 255, .07); color: var(--color-text); }
.tb-files:disabled { opacity: .4; cursor: default; }
@media (max-width: 639px) { .tb-files { padding: 0 7px; } }
.tb-files:focus-visible,
.tb-save:focus-visible,
.tb-menu-item:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

/* A pill split button. ONE outline on the group (the halves carry none), and
   a short seam inset from the edges between them. Neutral while the file is
   saved; the accent tint once it has unsaved edits (design 1a, owner,
   November 2026: Save lights up when there is something to save). */
.tb-save-group {
  border-radius: 999px;
  background: rgba(255, 255, 255, .03);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1);
  color: rgba(255, 255, 255, .65);
  transition: background-color .15s, color .15s, box-shadow .15s;
}
.tb-save-group.is-dirty {
  background: rgba(53, 211, 230, .12);
  box-shadow: inset 0 0 0 1px rgba(53, 211, 230, .32);
  color: #7fe9f6;
}
.tb-save {
  cursor: pointer;
  height: 30px;
  display: flex;
  align-items: center;
  color: inherit;
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: .01em;
  transition: background-color .12s, opacity .12s;
}
.tb-save:hover:not(:disabled) { background: rgba(255, 255, 255, .06); }
.tb-save:disabled { opacity: .4; cursor: default; }
.tb-save-main {
  gap: 7px;
  padding: 0 12px 0 16px;
  border-radius: 999px 0 0 999px;
}
.tb-save-caret {
  width: 30px;
  padding-right: 3px;
  justify-content: center;
  border-radius: 0 999px 999px 0;
}
.tb-save-seam {
  width: 1px;
  margin: 8px 0;
  background: rgba(255, 255, 255, .12);
}
.tb-save-group.is-dirty .tb-save-seam { background: rgba(127, 233, 246, .3); }
@media (max-width: 639px) {
  .tb-save-main { padding: 0 10px 0 13px; }
  .tb-save-caret { width: 26px; }
}
/* Amber, as on the tab — the app's one colour for "not on disk yet". Its slot
   is kept while hidden so the button never changes width. */
.tb-dirty {
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: #e0b84a;
  opacity: 0;
}
.tb-dirty.is-on { opacity: 1; }

.tb-menu-item {
  cursor: pointer;
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
