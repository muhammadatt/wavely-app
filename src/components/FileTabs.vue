<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileImport } from '../composables/useFileImport.js'
import { useFileSave } from '../composables/useFileSave.js'
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

// ── Per-tab status ───────────────────────────────────────────────────────────
// The dot is the whole point of a tab over a plain label: mastered/compliant
// state is visible without opening each file. Definition is shared with the
// files panel, which renders the same state as a text label.
const statusOf = documentStatus
</script>

<template>
  <div
    v-if="documents.length > 0"
    class="tab-row h-[40px] compact:h-[34px] flex items-stretch shrink-0 px-5 compact:px-2 gap-[3px]"
  >

    <div ref="stripEl" class="flex-1 min-w-0 flex items-stretch gap-[3px]">
      <div
        v-for="doc in visibleDocs"
        :key="doc.id"
        class="tab group relative flex items-center gap-[6px] px-[9px] rounded-t-[8px] cursor-pointer select-none transition-colors shrink-0 overflow-hidden"
        :class="doc.id === appState.activeDocumentId ? 'tab-active' : 'tab-idle'"
        :style="{ width: `${tabWidth}px` }"
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
          class="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] font-semibold text-[#eaf6f8] border-b border-[#35d3e6]"
          @click.stop
          @keydown.enter.prevent.stop="commitRename"
          @keydown.esc.prevent.stop="renamingId = null"
          @blur="commitRename"
        />
        <span
          v-else
          class="flex-1 min-w-0 truncate text-[12.5px] font-semibold"
          :style="{ color: doc.id === appState.activeDocumentId ? '#eaf6f8' : 'rgba(255,255,255,.48)' }"
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
          class="w-[15px] h-[15px] pointer-coarse:w-[26px] pointer-coarse:h-[26px] rounded-[4px] shrink-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100 hover:bg-[rgba(255,255,255,.12)]"
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
        class="shrink-0 flex items-center gap-[3px] px-[9px] rounded-t-[8px] text-[11px] font-bold transition-colors bg-[rgba(255,255,255,.04)] hover:bg-[rgba(255,255,255,.07)]"
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
        class="w-[30px] shrink-0 flex items-center justify-center rounded-t-[8px] transition-colors bg-[rgba(255,255,255,.04)] hover:bg-[rgba(255,255,255,.07)] hover:text-[rgba(255,255,255,.8)] cursor-pointer"
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
      class="flex items-center gap-[14px] shrink-0 pl-3 max-sm:hidden"
      :title="activeDoc ? activeDoc.name : ''"
    >
      <!-- Label / value pairs: the label names the property, so the format
           needs no badge and the line reads as words rather than a code. -->
      <span class="meta"><span class="meta-k">Format</span> {{ fileMeta.format }}</span>
      <span class="meta"><span class="meta-k">Length</span> {{ fileMeta.duration }}</span>
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
        <div class="relative flex items-stretch" data-save-menu @keydown.esc="saveMenuOpen = false">
          <button
            class="tb-save tb-save-main"
            :disabled="!hasFile || isSaving"
            :title="isDirty ? 'Save — unsaved edits (Ctrl+S)' : 'Save (Ctrl+S)'"
            @click="saveDocument()"
          >
            <span>{{ isSaving ? 'Saving…' : 'Save' }}</span>
            <span
              v-if="isDirty && !isSaving"
              class="tb-dirty"
              aria-label="Unsaved changes"
            ></span>
          </button>
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
/* The active tab opens into the workspace (its fill IS the workspace colour)
   with the brightest name and a faint outline — no marker line (a cyan
   underline, then a top edge, were both tried and dropped, owner). The others
   keep a light tint so they still read as tabs, not floating text (owner:
   unfilled they looked like loose labels); hover lifts it a step. */
.tab-active {
  background: var(--color-workspace);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, .07), inset -1px 0 0 rgba(255, 255, 255, .07), inset 0 1px 0 rgba(255, 255, 255, .07);
}
.tab-idle { background: rgba(255, 255, 255, .04); }
.tab-idle:hover { background: rgba(255, 255, 255, .07); }
.meta {
  font-size: 12px;
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

/* A pill split button in the accent TINT, not a solid fill (owner, November
   2026: no bright cyan block on the chrome — Chain got the same treatment).
   The pill shape and the cyan still mark it as the row's action. The seam is
   a short line inset from the edges, so the two halves read as one button. */
.tb-save {
  height: 30px;
  display: flex;
  align-items: center;
  background: rgba(53, 211, 230, .12);
  color: #7fe9f6;
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: .01em;
  transition: background-color .12s, opacity .12s;
}
.tb-save:hover:not(:disabled) { background: rgba(53, 211, 230, .2); }
.tb-save:disabled { opacity: .4; cursor: default; }
/* Each half outlines only its outer sides, so the pair has one outline and
   the seam stays the short inset line, not a doubled border. */
.tb-save-main {
  gap: 7px;
  padding: 0 12px 0 16px;
  border-radius: 999px 0 0 999px;
  box-shadow: inset 1px 0 0 rgba(53, 211, 230, .32), inset 0 1px 0 rgba(53, 211, 230, .32), inset 0 -1px 0 rgba(53, 211, 230, .32);
}
.tb-save-caret {
  position: relative;
  width: 30px;
  padding-right: 3px;
  justify-content: center;
  border-radius: 0 999px 999px 0;
  box-shadow: inset -1px 0 0 rgba(53, 211, 230, .32), inset 0 1px 0 rgba(53, 211, 230, .32), inset 0 -1px 0 rgba(53, 211, 230, .32);
}
.tb-save-caret::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: rgba(127, 233, 246, .3);
}
@media (max-width: 639px) {
  .tb-save-main { padding: 0 10px 0 13px; }
  .tb-save-caret { width: 26px; }
}
/* Amber, as on the tab — the app's one colour for "not on disk yet". */
.tb-dirty {
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: #e0b84a;
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
