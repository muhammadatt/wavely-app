import { reactive, computed, ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import {
  cloneSegments,
  getTimelineDuration,
  deleteRegion,
  trimToSelection,
  trimBefore,
  trimAfter,
  silenceRegion,
  splitAtPlayhead,
  splitSegmentsAtTime,
  insertSegments,
  replaceRegionWithBuffer,
} from '../audio/operations.js'
import { stopPlayback } from '../audio/playback.js'
import { getDefaultOutputProfile, isOutputProfileLocked } from '../audio/presets.js'

const UNDO_STACK_CAP = 50

/**
 * Multi-document model.
 *
 * A *document* is one timeline over one or more source buffers, with its own
 * selection, playhead, undo history, preset choice and processing job. The app
 * holds an ordered list of documents plus one active id.
 *
 * `state` (exported below) is a Proxy that forwards per-document fields to the
 * active document and everything else to `appState`. That keeps the shape every
 * component already reads — `state.segments`, `state.currentFile`, … — working
 * unchanged while the data underneath became per-document.
 */

// Fields that live on a document rather than on the app.
const DOC_FIELDS = new Set([
  'segments', 'selection', 'playhead', 'isPlaying', 'isLooping',
  'currentFile', 'selectedPreset', 'selectedOutputProfile', 'processingReport',
  'isProcessing', 'processingMessage', 'processingStage', 'processingProgress',
  'undoCount', 'redoCount', 'status', 'name',
])

// Returned for document fields when no document is open. The empty segments
// array is shared and never mutated — handing out a fresh [] on every read
// would retrigger every watcher that depends on it.
const EMPTY_SEGMENTS = Object.freeze([])
const DOC_FIELD_FALLBACKS = {
  segments: EMPTY_SEGMENTS,
  selection: null,
  playhead: 0,
  isPlaying: false,
  isLooping: false,
  currentFile: null,
  selectedPreset: 'general_clean',
  selectedOutputProfile: 'podcast',
  processingReport: null,
  isProcessing: false,
  processingMessage: '',
  processingStage: '',
  processingProgress: 0,
  undoCount: 0,
  redoCount: 0,
  status: 'empty',
  name: '',
}

// App-level state — everything that is not per-document.
const appState = reactive({
  documents: [],
  activeDocumentId: null,

  // Clipboard is deliberately app-level: copying a region in one document and
  // pasting it into another is a real workflow (lifting room tone between
  // chapters), and it falls out for free by keeping this global.
  clipboard: null,

  // UI chrome — persists across document switches
  // Category id from src/ui/registry.js, or null. Also *is* "rail is open" —
  // there is no separate flag. Never compare against a literal here; the
  // registry owns the set of ids.
  activeTool: null,
  // Operation id the rail has drilled into, or null for the category list.
  railOperation: null,
  commandPaletteOpen: false,
  // Viewport coords of an open waveform context menu, or null. Position is
  // state rather than a component ref because the menu renders at the app root,
  // above the rail and the floating windows.
  contextMenu: null,
  exportDialogOpen: false,
  // Document ids the export dialog should open with pre-checked. Set when
  // export is invoked from a bulk selection; null means "just the active one".
  exportPreselection: null,
  filesPanelOpen: false,
  toasts: [],
})

// Buffer pool — Map<bufferId, AudioBuffer>. App-level and shared across
// documents; ownership is tracked separately so closing a document can free
// the buffers no other document still references.
const bufferPool = new Map()

// Peak caches — Map<bufferId, { samplesPerPx, peaks }>
const peakCaches = new Map()
const peakCacheVersion = ref(0)

// Map<docId, Set<bufferId>> — which buffers each document brought into the pool.
const docBuffers = new Map()

// Map<docId, { undo: Segment[][], redo: Segment[][] }>
// Held outside the reactive tree: these are up to 50 full segment-array clones
// per document, and deep-reactive wrapping them is pure cost — nothing renders
// from history directly. The reactive `undoCount`/`redoCount` on the document
// are what drive canUndo/canRedo.
const docHistory = new Map()

// Sticky preset choice. A narrator mastering 20 chapters wants one preset
// across all of them, so a new document inherits the last explicit choice
// rather than resetting to the global default.
let lastPreset = 'general_clean'
let lastOutputProfile = 'podcast'

// AudioContext — created on first user gesture
let audioContext = null

const activeDocument = computed(
  () => appState.documents.find(d => d.id === appState.activeDocumentId) ?? null
)

// The compatibility proxy described above.
const state = new Proxy({}, {
  get(_target, key) {
    if (DOC_FIELDS.has(key)) {
      const doc = activeDocument.value
      return doc ? doc[key] : DOC_FIELD_FALLBACKS[key]
    }
    return appState[key]
  },
  set(_target, key, value) {
    if (DOC_FIELDS.has(key)) {
      const doc = activeDocument.value
      if (doc) doc[key] = value
      return true
    }
    appState[key] = value
    return true
  },
  has(_target, key) {
    return DOC_FIELDS.has(key) || key in appState
  },
  ownKeys() {
    return [...new Set([...Object.keys(appState), ...DOC_FIELDS])]
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true }
  },
})

function historyFor(docId) {
  let h = docHistory.get(docId)
  if (!h) {
    h = { undo: [], redo: [] }
    docHistory.set(docId, h)
  }
  return h
}

function buffersFor(docId) {
  let s = docBuffers.get(docId)
  if (!s) {
    s = new Set()
    docBuffers.set(docId, s)
  }
  return s
}

export function useEditorState() {
  // Computed
  const totalDuration = computed(() => getTimelineDuration(state.segments))
  const hasSelection = computed(() => state.selection !== null)
  const hasClipboard = computed(() => appState.clipboard !== null && appState.clipboard.length > 0)
  const canUndo = computed(() => state.undoCount > 0)
  const canRedo = computed(() => state.redoCount > 0)
  const hasFile = computed(() => state.currentFile !== null)

  const documents = computed(() => appState.documents)
  const documentCount = computed(() => appState.documents.length)
  const activeDoc = activeDocument

  // AudioContext management
  function getAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume()
    }
    return audioContext
  }

  // ── Undo/Redo ──────────────────────────────────────────────────────────────
  function pushUndo() {
    const doc = activeDocument.value
    if (!doc) return
    const h = historyFor(doc.id)
    h.undo.push(cloneSegments(doc.segments))
    if (h.undo.length > UNDO_STACK_CAP) h.undo.shift()
    h.redo.length = 0
    doc.undoCount = h.undo.length
    doc.redoCount = 0
  }

  function undo() {
    const doc = activeDocument.value
    if (!doc) return
    const h = historyFor(doc.id)
    if (h.undo.length === 0) return
    h.redo.push(cloneSegments(doc.segments))
    doc.segments = h.undo.pop()
    doc.selection = null
    doc.undoCount = h.undo.length
    doc.redoCount = h.redo.length
  }

  function redo() {
    const doc = activeDocument.value
    if (!doc) return
    const h = historyFor(doc.id)
    if (h.redo.length === 0) return
    h.undo.push(cloneSegments(doc.segments))
    doc.segments = h.redo.pop()
    doc.selection = null
    doc.undoCount = h.undo.length
    doc.redoCount = h.redo.length
  }

  // ── Buffer pool ────────────────────────────────────────────────────────────
  /**
   * Add a buffer to the pool, owned by `docId` (defaults to the active
   * document). Ownership decides who can free it on close.
   */
  function addBuffer(id, buffer, docId = appState.activeDocumentId) {
    bufferPool.set(id, buffer)
    if (docId) buffersFor(docId).add(id)
  }

  function getBuffer(id) {
    return bufferPool.get(id)
  }

  function setPeakCache(bufferId, cache) {
    peakCaches.set(bufferId, cache)
    peakCacheVersion.value++
  }

  function getPeakCache(bufferId) {
    return peakCaches.get(bufferId)
  }

  // ── Documents ──────────────────────────────────────────────────────────────
  function makeDocument(name, audioBuffer) {
    const docId = uuidv4()
    const bufferId = uuidv4()

    const segment = {
      id: uuidv4(),
      sourceBuffer: audioBuffer,
      sourceBufferId: bufferId,
      sourceStart: 0,
      sourceEnd: audioBuffer.duration,
      outputStart: 0,
    }

    return {
      id: docId,
      bufferId,
      name,
      status: 'ready', // 'ready' | 'processing' | 'error'
      segments: [segment],
      selection: null,
      playhead: 0,
      isPlaying: false,
      isLooping: false,
      currentFile: {
        name,
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        channels: audioBuffer.numberOfChannels,
      },
      selectedPreset: lastPreset,
      selectedOutputProfile: lastOutputProfile,
      processingReport: null,
      isProcessing: false,
      processingMessage: '',
      processingStage: '',
      processingProgress: 0,
      undoCount: 0,
      redoCount: 0,
    }
  }

  /**
   * Create a document from a decoded buffer and make it active.
   * @returns {{ docId: string, bufferId: string }}
   */
  function createDocument(name, audioBuffer, { activate = true } = {}) {
    const doc = makeDocument(name, audioBuffer)
    appState.documents.push(doc)

    bufferPool.set(doc.bufferId, audioBuffer)
    buffersFor(doc.id).add(doc.bufferId)
    historyFor(doc.id)

    if (activate) setActiveDocument(doc.id)
    return { docId: doc.id, bufferId: doc.bufferId }
  }

  function getDocument(docId) {
    return appState.documents.find(d => d.id === docId) ?? null
  }

  function setActiveDocument(docId) {
    if (appState.activeDocumentId === docId) return
    // Playback is a module singleton keyed to whatever segments were scheduled;
    // leaving it running would play the old document over the new one.
    stopPlayback()
    const prev = activeDocument.value
    if (prev) prev.isPlaying = false
    appState.activeDocumentId = docId
  }

  /** True when the document has edits that closing it would discard. */
  function documentHasUnsavedWork(docId) {
    const h = docHistory.get(docId)
    return !!h && h.undo.length > 0
  }

  function closeDocument(docId) {
    const idx = appState.documents.findIndex(d => d.id === docId)
    if (idx === -1) return

    // Free buffers this document owns that no *other* document references.
    // Checking the other documents' sets directly rather than keeping a
    // refcount avoids a second structure that could drift out of sync, and the
    // scan is trivial at these document counts.
    const owned = docBuffers.get(docId)
    if (owned) {
      for (const bufferId of owned) {
        let stillUsed = false
        for (const [otherDocId, set] of docBuffers) {
          if (otherDocId !== docId && set.has(bufferId)) { stillUsed = true; break }
        }
        if (!stillUsed) {
          bufferPool.delete(bufferId)
          peakCaches.delete(bufferId)
        }
      }
    }
    docBuffers.delete(docId)
    docHistory.delete(docId)

    const wasActive = appState.activeDocumentId === docId
    appState.documents.splice(idx, 1)

    if (wasActive) {
      stopPlayback()
      // Prefer the tab that slid into this slot, else the one before it.
      const next = appState.documents[idx] ?? appState.documents[idx - 1] ?? null
      appState.activeDocumentId = next?.id ?? null
    }
    peakCacheVersion.value++
  }

  function closeDocuments(docIds) {
    for (const id of [...docIds]) closeDocument(id)
  }

  function renameDocument(docId, name) {
    const doc = getDocument(docId)
    if (!doc || !name.trim()) return
    doc.name = name.trim()
    if (doc.currentFile) doc.currentFile.name = name.trim()
  }

  function reorderDocument(fromIndex, toIndex) {
    const docs = appState.documents
    if (fromIndex < 0 || fromIndex >= docs.length) return
    const clamped = Math.max(0, Math.min(toIndex, docs.length - 1))
    const [moved] = docs.splice(fromIndex, 1)
    docs.splice(clamped, 0, moved)
  }

  /** Step through documents by offset, wrapping at both ends. */
  function cycleDocument(offset) {
    const docs = appState.documents
    if (docs.length < 2) return
    const idx = docs.findIndex(d => d.id === appState.activeDocumentId)
    if (idx === -1) return
    const next = (idx + offset + docs.length) % docs.length
    setActiveDocument(docs[next].id)
  }

  // ── Edit operations — all push undo first ──────────────────────────────────
  function performTrimToSelection() {
    if (!state.selection) return
    pushUndo()
    const { start, end } = state.selection
    state.segments = trimToSelection(state.segments, start, end)
    state.selection = null
    state.playhead = 0
  }

  function performTrimBefore() {
    if (!state.selection) return
    pushUndo()
    state.segments = trimBefore(state.segments, state.selection.start)
    state.selection = null
    state.playhead = 0
  }

  function performTrimAfter() {
    if (!state.selection) return
    pushUndo()
    state.segments = trimAfter(state.segments, state.selection.end)
    const dur = getTimelineDuration(state.segments)
    state.selection = null
    if (state.playhead > dur) state.playhead = dur
  }

  function performSilence() {
    if (!state.selection) return
    pushUndo()
    const { start, end } = state.selection
    state.segments = silenceRegion(state.segments, start, end)
  }

  function performSplit() {
    pushUndo()
    state.segments = splitAtPlayhead(state.segments, state.playhead)
  }

  function performSplitAtSelectionEdges() {
    if (!state.selection) return
    pushUndo()
    let segs = splitAtPlayhead(state.segments, state.selection.start)
    segs = splitAtPlayhead(segs, state.selection.end)
    state.segments = segs
  }

  function segmentsInRange(segments, start, end) {
    let split = splitSegmentsAtTime(segments, start)
    split = splitSegmentsAtTime(split, end)
    return split.filter(seg => {
      const segEnd = seg.outputStart + (seg.sourceBuffer === null ? seg.duration : seg.sourceEnd - seg.sourceStart)
      return seg.outputStart >= start && segEnd <= end
    })
  }

  function performCut() {
    if (!state.selection) return
    pushUndo()
    const { start, end } = state.selection
    const inner = segmentsInRange(state.segments, start, end)
    appState.clipboard = inner.map(seg => ({ ...seg, outputStart: seg.outputStart - start }))
    state.segments = deleteRegion(state.segments, start, end)
    state.selection = null
    // Cutting the tail can leave the playhead past the end of the shortened
    // timeline — clamp it back onto the timeline.
    const dur = getTimelineDuration(state.segments)
    if (state.playhead > dur) state.playhead = dur
  }

  function performCopy() {
    if (!state.selection) return
    const { start, end } = state.selection
    const inner = segmentsInRange(state.segments, start, end)
    appState.clipboard = inner.map(seg => ({ ...seg, outputStart: seg.outputStart - start }))
  }

  function performPaste(position) {
    const doc = activeDocument.value
    if (!appState.clipboard || !doc) return
    pushUndo()
    // Pasting across documents brings in segments whose buffers belong to the
    // source document. Claim shared ownership so closing that document doesn't
    // free a buffer this one is now rendering from.
    const owned = buffersFor(doc.id)
    for (const seg of appState.clipboard) {
      if (!seg.sourceBufferId) continue
      owned.add(seg.sourceBufferId)
      if (!bufferPool.has(seg.sourceBufferId) && seg.sourceBuffer) {
        bufferPool.set(seg.sourceBufferId, seg.sourceBuffer)
      }
    }
    state.segments = insertSegments(state.segments, position, appState.clipboard)
  }

  function replaceRegion(start, end, newBuffer, docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc) return null
    // Undo must land on the document being modified, which is not necessarily
    // the active one — a preset job can finish after the user switched tabs.
    const h = historyFor(doc.id)
    h.undo.push(cloneSegments(doc.segments))
    if (h.undo.length > UNDO_STACK_CAP) h.undo.shift()
    h.redo.length = 0
    doc.undoCount = h.undo.length
    doc.redoCount = 0

    const bufferId = uuidv4()
    addBuffer(bufferId, newBuffer, doc.id)
    doc.segments = replaceRegionWithBuffer(doc.segments, start, end, newBuffer, bufferId)
    return bufferId
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function setSelection(start, end) {
    if (start === end) {
      state.selection = null
      return
    }
    const s = Math.min(start, end)
    const e = Math.max(start, end)
    state.selection = { start: s, end: e }
  }

  function clearSelection() {
    state.selection = null
  }

  function selectAll() {
    const dur = getTimelineDuration(state.segments)
    if (dur <= 0) return
    state.selection = { start: 0, end: dur }
  }

  // ── Playhead ───────────────────────────────────────────────────────────────
  function setPlayhead(time) {
    state.playhead = Math.max(0, Math.min(time, getTimelineDuration(state.segments)))
  }

  function toggleLoop() {
    state.isLooping = !state.isLooping
  }

  // ── Tool ───────────────────────────────────────────────────────────────────
  // `activeTool` alone says whether the rail is open — a separate
  // contextPanelOpen flag was a second way to express the same thing, and the
  // two could disagree.
  function setActiveTool(tool) {
    const next = appState.activeTool === tool ? null : tool
    appState.activeTool = next
    // Switching categories always lands on that category's list, never on a
    // detail view left over from last time.
    appState.railOperation = null
  }

  function closeRail() {
    appState.activeTool = null
    appState.railOperation = null
  }

  /** Drill into an operation's detail view inside the rail. */
  function setRailOperation(operationId) {
    appState.railOperation = operationId
  }

  /**
   * Open the rail directly at one operation, switching category if needed.
   * Used by the command palette, which addresses operations, not categories.
   */
  function openRailOperation(categoryId, operationId) {
    appState.activeTool = categoryId
    appState.railOperation = operationId
  }

  // ── Command palette ────────────────────────────────────────────────────────
  function openCommandPalette() {
    appState.commandPaletteOpen = true
  }

  function closeCommandPalette() {
    appState.commandPaletteOpen = false
  }

  // ── Waveform context menu ──────────────────────────────────────────────────
  function openContextMenu(x, y) {
    appState.contextMenu = { x, y }
  }

  function closeContextMenu() {
    appState.contextMenu = null
  }

  // ── Processing (per document) ──────────────────────────────────────────────
  function startProcessing(message, docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc) return
    doc.isProcessing = true
    doc.status = 'processing'
    doc.processingMessage = message
    doc.processingStage = ''
    doc.processingProgress = 0
  }

  function updateProcessingProgress(progress, docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (doc) doc.processingProgress = progress
  }

  function updateProcessingStage(stage, docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (doc) doc.processingStage = stage
  }

  function endProcessing(docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (!doc) return
    doc.isProcessing = false
    doc.status = 'ready'
    doc.processingMessage = ''
    doc.processingStage = ''
    doc.processingProgress = 0
  }

  /** True while any document has a job in flight. */
  const anyProcessing = computed(() => appState.documents.some(d => d.isProcessing))

  // ── Preset / Output Profile ────────────────────────────────────────────────
  function setPreset(presetId) {
    state.selectedPreset = presetId
    state.selectedOutputProfile = getDefaultOutputProfile(presetId)
    state.processingReport = null
    lastPreset = presetId
    lastOutputProfile = state.selectedOutputProfile
  }

  function setOutputProfile(outputProfileId) {
    if (isOutputProfileLocked(state.selectedPreset)) return
    state.selectedOutputProfile = outputProfileId
    lastOutputProfile = outputProfileId
  }

  function setProcessingReport(report, docId = appState.activeDocumentId) {
    const doc = getDocument(docId)
    if (doc) doc.processingReport = report
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastId = 0
  function showToast(message, duration = 3000) {
    const id = ++toastId
    appState.toasts.push({ id, message })
    setTimeout(() => {
      appState.toasts = appState.toasts.filter(t => t.id !== id)
    }, duration)
  }

  return {
    state,
    appState,
    bufferPool,
    peakCaches,

    // Computed
    totalDuration,
    hasSelection,
    hasClipboard,
    canUndo,
    canRedo,
    hasFile,
    documents,
    documentCount,
    activeDoc,
    anyProcessing,

    // AudioContext
    getAudioContext,

    // Undo/Redo
    undo,
    redo,
    pushUndo,

    // Buffer pool
    addBuffer,
    getBuffer,
    setPeakCache,
    getPeakCache,
    peakCacheVersion,

    // Documents
    createDocument,
    getDocument,
    setActiveDocument,
    closeDocument,
    closeDocuments,
    renameDocument,
    reorderDocument,
    cycleDocument,
    documentHasUnsavedWork,

    // Edit operations
    performTrimToSelection,
    performTrimBefore,
    performTrimAfter,
    performSilence,
    performSplit,
    performSplitAtSelectionEdges,
    performCut,
    performCopy,
    performPaste,
    replaceRegion,

    // Selection / Playhead
    setSelection,
    clearSelection,
    selectAll,
    setPlayhead,
    toggleLoop,

    // Tool
    setActiveTool,
    closeRail,
    setRailOperation,
    openRailOperation,
    openCommandPalette,
    closeCommandPalette,
    openContextMenu,
    closeContextMenu,

    // Processing
    startProcessing,
    updateProcessingProgress,
    updateProcessingStage,
    endProcessing,

    // Preset / Output Profile
    setPreset,
    setOutputProfile,
    setProcessingReport,

    // Toast
    showToast,
  }
}
