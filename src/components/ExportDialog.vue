<script setup>
import { computed, ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useExport } from '../composables/useExport.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatDuration } from '../utils/format.js'
import { documentStatus } from '../utils/documentStatus.js'
import { focusRenameInput } from '../utils/renameInput.js'
import BaseButton from './ui/BaseButton.vue'

/**
 * Export, with multi-select.
 *
 * This is where multi-file selection lives — deliberately not in the tab strip.
 * The editor already uses "selection" to mean a time range, and a second
 * persistent meaning of the word in the primary navigation confuses more than
 * it helps. Checking files at the moment you export also puts the decision
 * where it's actually being made.
 *
 * The export itself is `useExport`, shared with the files panel, which exports
 * its ticked files where they stand rather than handing them here to be ticked
 * a second time. This dialog is the surface for the other approach — open it
 * with nothing chosen and decide, with sizes and compliance in front of you.
 */

const { appState, documents, renameDocument } = useEditorState()
const {
  isExporting, exportProgress, exportDocuments,
  estimatedBytes, totalBytes, formatSize, exportSizeLimit,
} = useExport()

// Opens on the active document. Nothing pre-checks a wider set any more: the
// only caller that did was the files panel, and it exports its own ticks now.
const checked = ref(new Set([appState.activeDocumentId].filter(Boolean)))

function toggle(docId) {
  const next = new Set(checked.value)
  if (next.has(docId)) next.delete(docId)
  else next.add(docId)
  checked.value = next
}

const allChecked = computed(() =>
  documents.value.length > 0 && documents.value.every(d => checked.value.has(d.id))
)

function toggleAll() {
  checked.value = allChecked.value ? new Set() : new Set(documents.value.map(d => d.id))
}

const selectedDocs = computed(() => documents.value.filter(d => checked.value.has(d.id)))

const selectedBytes = computed(() => totalBytes(selectedDocs.value))
// The refusal carries its own message: what goes over the 4 GB ceiling differs
// between one file and many, and so does what the user should do about it.
const sizeLimit = computed(() => exportSizeLimit(selectedDocs.value))

function close() {
  if (isExporting.value) return
  appState.exportDialogOpen = false
}

// ── Rename before export ─────────────────────────────────────────────────────
// Renaming was reachable only by double-clicking a tab or a row in the files
// panel — both of them somewhere else, and neither advertised. The moment the
// name matters is the moment it becomes a filename on disk, which is this
// dialog, so the same inline rename lives here too. It edits the document's
// real name (the tab strip and files panel follow), and the exported file
// takes it via uniqueNames() in useExport.
const renamingId = ref(null)
const renameDraft = ref('')

function startRename(doc) {
  if (isExporting.value) return
  renamingId.value = doc.id
  renameDraft.value = doc.name
}

function commitRename() {
  if (renamingId.value) renameDocument(renamingId.value, renameDraft.value)
  renamingId.value = null
}

async function handleExport() {
  if (await exportDocuments(selectedDocs.value)) appState.exportDialogOpen = false
}

// ── Per-row compliance signal ────────────────────────────────────────────────
// CLAUDE.md is explicit that the export UI should always show current
// compliance status, so the state of each file is self-evident at the moment it
// matters. No lecturing — just the signal.
//
// ⚠ THIS WAS DELETED ONCE AND THE DIALOG SHIPPED WITHOUT IT, leaving duration
// and size where the ACX verdict should be — on the one screen where a narrator
// decides what to send to ACX. It is back as `documentStatus`, not as the
// private copy it was before: that copy had its own colour table for the same
// four states, which is exactly what documentStatus.js exists to stop. The only
// thing it does not cover is a file nobody has mastered, which is worth saying
// here and nowhere else.
function statusOf(doc) {
  return documentStatus(doc) ?? { label: 'Not mastered', color: 'rgba(255,255,255,.35)' }
}

</script>

<template>
  <div
    class="fixed inset-0 z-[450] flex items-start justify-center pt-[10vh] px-4"
    style="background:rgba(5,7,9,.6);backdrop-filter:blur(5px)"
    @click.self="close"
  >
    <div
      class="w-full max-w-[520px] max-h-[76vh] flex flex-col rounded-[18px] overflow-hidden font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07);animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
    >
      <!-- Header -->
      <div class="px-5 pt-[18px] pb-[14px] border-b border-[rgba(255,255,255,.07)]">
        <div class="text-[15px] font-bold text-[#eaf6f8]">Export</div>
        <div class="mt-[3px] text-[11.5px] text-[rgba(255,255,255,.42)]">
          WAV 16-bit · choose which files to include · double-click a name to rename
        </div>
      </div>

      <!-- Select all -->
      <div class="flex items-center gap-[10px] px-5 py-[10px] border-b border-[rgba(255,255,255,.05)]">
        <button
          class="w-[16px] h-[16px] rounded-[5px] shrink-0 flex items-center justify-center transition-all"
          :style="allChecked
            ? 'background:#35d3e6;box-shadow:inset 0 0 0 1px #35d3e6'
            : 'box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.18)'"
          aria-label="Select all files"
          :aria-pressed="allChecked"
          @click="toggleAll"
        >
          <svg v-if="allChecked" viewBox="0 0 24 24" class="w-[10px] h-[10px] fill-none stroke-current" style="color:#08161a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </button>
        <span class="text-[11.5px] font-bold text-[rgba(255,255,255,.5)]">
          {{ allChecked ? 'Deselect all' : 'Select all' }}
        </span>
      </div>

      <!-- File list -->
      <div class="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-[2px] min-h-0">
        <div
          v-for="doc in documents"
          :key="doc.id"
          class="group flex items-center gap-[10px] px-2 py-[9px] rounded-[9px] cursor-pointer transition-colors"
          :style="checked.has(doc.id) ? 'background:rgba(53,211,230,.07)' : ''"
          @click="toggle(doc.id)"
        >
          <button
            class="w-[16px] h-[16px] rounded-[5px] shrink-0 flex items-center justify-center transition-all"
            :style="checked.has(doc.id)
              ? 'background:#35d3e6;box-shadow:inset 0 0 0 1px #35d3e6'
              : 'box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.18)'"
            :aria-label="`Include ${doc.name}`"
            :aria-pressed="checked.has(doc.id)"
            @click.stop="toggle(doc.id)"
          >
            <svg v-if="checked.has(doc.id)" viewBox="0 0 24 24" class="w-[10px] h-[10px] fill-none stroke-current" style="color:#08161a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          </button>

          <div class="flex-1 min-w-0">
            <input
              v-if="renamingId === doc.id"
              :ref="focusRenameInput"
              v-model="renameDraft"
              class="w-full bg-transparent outline-none text-[12.5px] font-bold text-[#eaf6f8] border-b border-[#35d3e6]"
              aria-label="File name"
              @click.stop
              @keydown.enter.prevent.stop="commitRename"
              @keydown.esc.prevent.stop="renamingId = null"
              @blur="commitRename"
            />
            <div v-else class="flex items-center gap-[6px] min-w-0">
              <!-- Clicks on the name are stopped, not just the double-click:
                   a double-click delivers two click events first, and the row's
                   handler is a toggle, so renaming from here flipped the file's
                   include state on and back off with a visible flash. The name
                   is the rename target rather than a second hit area for the
                   checkbox — the meta line, the status and the rest of the row
                   still toggle. -->
              <span
                class="text-[12.5px] font-bold truncate text-[#eaf6f8] cursor-text"
                :title="`${doc.name} — double-click to rename`"
                @click.stop
                @dblclick.stop="startRename(doc)"
              >{{ doc.name }}</span>
              <!-- Double-click works on the name itself; the pencil is there so
                   the rename is visible rather than something you have to know
                   about. -->
              <button
                class="w-[18px] h-[18px] rounded-[5px] shrink-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[rgba(255,255,255,.12)]"
                style="color:rgba(255,255,255,.6)"
                :disabled="isExporting"
                :aria-label="`Rename ${doc.name}`"
                title="Rename before export"
                @click.stop="startRename(doc)"
              >
                <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
              </button>
            </div>
            <div class="flex items-center gap-[6px] mt-[2px]">
              <span class="font-['JetBrains_Mono'] text-[10.5px] font-semibold text-[rgba(255,255,255,.35)]">
                {{ formatDuration(getTimelineDuration(doc.segments)) }}
              </span>
              <span class="text-[rgba(255,255,255,.15)] text-[10px]">·</span>
              <span class="font-['JetBrains_Mono'] text-[10.5px] font-semibold text-[rgba(255,255,255,.35)]">
                {{ formatSize(estimatedBytes(doc)) }}
              </span>
            </div>
          </div>

          <span
            class="text-[10.5px] font-bold shrink-0"
            :style="{ color: statusOf(doc).color }"
            :title="statusOf(doc).title"
          >{{ statusOf(doc).label }}</span>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-[13px] border-t border-[rgba(255,255,255,.07)]">
        <div v-if="sizeLimit" class="mb-[10px] text-[11px] font-bold leading-snug text-[#ff8a80]">
          {{ sizeLimit.message }}
        </div>

        <div v-if="isExporting" class="mb-[10px]">
          <div class="flex justify-between text-[11px] font-bold text-[rgba(255,255,255,.5)] mb-[6px]">
            <span>Rendering {{ exportProgress.done + 1 }} of {{ exportProgress.total }}…</span>
            <span class="font-['JetBrains_Mono']">{{ Math.round((exportProgress.done / exportProgress.total) * 100) }}%</span>
          </div>
          <div class="w-full h-[6px] rounded-md overflow-hidden" style="background:rgba(255,255,255,.06)">
            <div
              class="h-full rounded transition-all duration-300"
              style="background:linear-gradient(90deg,#35d3e6,#e0b84a)"
              :style="{ width: `${(exportProgress.done / exportProgress.total) * 100}%` }"
            ></div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <span class="text-[11.5px] font-bold text-[rgba(255,255,255,.45)]">
            <template v-if="selectedDocs.length === 0">Nothing selected</template>
            <template v-else>
              {{ selectedDocs.length }} file{{ selectedDocs.length === 1 ? '' : 's' }}
              · {{ formatSize(selectedBytes) }}
              <span v-if="selectedDocs.length > 1" class="text-[rgba(255,255,255,.3)]"> · zip</span>
            </template>
          </span>
          <div class="flex-1"></div>
          <BaseButton size="sm" color="ghost" :pill="false" :disabled="isExporting" @click="close">Cancel</BaseButton>
          <BaseButton
            size="md" :pill="false"
            :disabled="selectedDocs.length === 0 || isExporting || !!sizeLimit"
            @click="handleExport"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>
            {{ isExporting ? 'Exporting…' : 'Export' }}
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
