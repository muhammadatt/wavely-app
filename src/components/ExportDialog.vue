<script setup>
import { computed, ref } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { getTimelineDuration } from '../audio/operations.js'
import { renderTimelineToWav, toWavFileName, downloadBlob } from '../audio/export.js'
import { createZip, ZIP_SIZE_LIMIT } from '../audio/zip.js'
import { formatDuration } from '../utils/format.js'
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
 */

const { appState, documents, showToast, renameDocument } = useEditorState()

// Pre-check whatever the caller asked for, else just the active document.
const initial = appState.exportPreselection?.length
  ? appState.exportPreselection
  : [appState.activeDocumentId].filter(Boolean)
const checked = ref(new Set(initial))
appState.exportPreselection = null

const isExporting = ref(false)
const exportProgress = ref({ done: 0, total: 0 })

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

/** 16-bit PCM: bytes = samples × channels × 2, plus a 44-byte header. */
function estimatedBytes(doc) {
  const dur = getTimelineDuration(doc.segments)
  const f = doc.currentFile
  if (!f || !dur) return 0
  return Math.round(dur * f.sampleRate) * f.channels * 2 + 44
}

const totalBytes = computed(() =>
  selectedDocs.value.reduce((sum, d) => sum + estimatedBytes(d), 0)
)

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

const overZipLimit = computed(() =>
  selectedDocs.value.length > 1 && totalBytes.value > ZIP_SIZE_LIMIT
)

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
// takes it via uniqueNames() below.
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

/** Disambiguate names that collide once extensions are normalised to .wav. */
function uniqueNames(docs) {
  const seen = new Map()
  return docs.map(doc => {
    const base = toWavFileName(doc.name)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    if (count === 0) return base
    return base.replace(/\.wav$/, ` (${count + 1}).wav`)
  })
}

async function handleExport() {
  const docs = selectedDocs.value
  if (docs.length === 0 || isExporting.value) return

  isExporting.value = true
  exportProgress.value = { done: 0, total: docs.length }

  try {
    const names = uniqueNames(docs)
    const rendered = []
    const failed = []

    for (const [i, doc] of docs.entries()) {
      // Yield to the browser between files so the progress readout actually
      // paints — rendering is synchronous and would otherwise freeze the UI
      // solid until every file was done.
      await new Promise(r => setTimeout(r, 0))
      try {
        const wav = renderTimelineToWav(
          doc.segments, doc.currentFile.sampleRate, doc.currentFile.channels
        )
        if (wav) rendered.push({ name: names[i], data: wav })
        else failed.push(doc.name)
      } catch (err) {
        console.error(`Failed to render ${doc.name}:`, err)
        failed.push(doc.name)
      }
      exportProgress.value = { done: i + 1, total: docs.length }
    }

    if (rendered.length === 0) {
      showToast('Nothing to export')
      return
    }

    if (rendered.length === 1) {
      downloadBlob(new Blob([rendered[0].data], { type: 'audio/wav' }), rendered[0].name)
      showToast(`Exported ${rendered[0].name}`)
    } else {
      const stamp = new Date().toISOString().slice(0, 10)
      downloadBlob(createZip(rendered), `wavely-export-${stamp}.zip`)
      showToast(`Exported ${rendered.length} files as a zip`)
    }

    if (failed.length > 0) {
      showToast(`Skipped ${failed.length} file${failed.length === 1 ? '' : 's'} that failed to render`)
    }
    appState.exportDialogOpen = false
  } finally {
    isExporting.value = false
  }
}

// ── Per-row compliance signal ────────────────────────────────────────────────
// CLAUDE.md is explicit that the export UI should always show current
// compliance status, so the state of each file is self-evident at the moment
// it matters. No lecturing — just the signal.
function complianceOf(doc) {
  const cert = doc.processingReport?.acx_certification
  if (cert) {
    return cert.certificate === 'pass'
      ? { text: 'ACX pass', color: '#5fd39a' }
      : { text: 'ACX fail', color: '#ff8a80' }
  }
  if (doc.processingReport) return { text: 'Mastered', color: '#7fe9f6' }
  return { text: 'Not mastered', color: 'rgba(255,255,255,.35)' }
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
              @keydown.enter.prevent="commitRename"
              @keydown.esc.prevent="renamingId = null"
              @blur="commitRename"
            />
            <div v-else class="flex items-center gap-[6px] min-w-0">
              <span
                class="text-[12.5px] font-bold truncate text-[#eaf6f8]"
                :title="doc.name"
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
            v-if="doc.isProcessing"
            class="text-[10.5px] font-bold shrink-0"
            style="color:#7fe9f6"
          >Processing…</span>
          <span
            v-else
            class="text-[10.5px] font-bold shrink-0"
            :style="{ color: complianceOf(doc).color }"
          >{{ complianceOf(doc).text }}</span>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-[13px] border-t border-[rgba(255,255,255,.07)]">
        <div v-if="overZipLimit" class="mb-[10px] text-[11px] font-bold leading-snug text-[#ff8a80]">
          This selection is {{ formatSize(totalBytes) }} — over the 4 GB zip limit. Export in smaller batches.
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
              · {{ formatSize(totalBytes) }}
              <span v-if="selectedDocs.length > 1" class="text-[rgba(255,255,255,.3)]"> · zip</span>
            </template>
          </span>
          <div class="flex-1"></div>
          <BaseButton size="sm" color="ghost" :pill="false" :disabled="isExporting" @click="close">Cancel</BaseButton>
          <BaseButton
            size="md" :pill="false"
            :disabled="selectedDocs.length === 0 || isExporting || overZipLimit"
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
