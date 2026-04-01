import { reactive, computed, shallowRef, ref, toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import {
  cloneSegments,
  recalcOutputStarts,
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
import { getDefaultCompliance, isComplianceLocked } from '../audio/presets.js'

const UNDO_STACK_CAP = 50

// Singleton state
const state = reactive({
  // Timeline
  segments: [],

  // Selection
  selection: null, // { start, end } or null

  // Playhead
  playhead: 0,
  isPlaying: false,

  // Clipboard
  clipboard: null,

  // File info
  currentFile: null, // { name, duration, sampleRate, channels }

  // UI state
  activeTool: null, // 'split' | 'trim' | 'fade' | 'silence' | 'effects' | 'presets' | null
  selectedPreset: 'general_clean',
  selectedCompliance: 'standard',
  processingReport: null,
  isProcessing: false,
  processingMessage: '',
  processingProgress: 0,
  contextPanelOpen: false,
  toasts: [],
})

// Buffer pool — Map<string, AudioBuffer>
// Using a plain Map since AudioBuffers can't be reactive (transferable objects)
const bufferPool = new Map()

// Peak caches — Map<string, { samplesPerPx, peaks }>
const peakCaches = new Map()
// Incremented every time a new peak cache entry is stored so watchers can react
const peakCacheVersion = ref(0)

// Undo/Redo stacks — plain arrays; reactive counters drive canUndo/canRedo
const undoStack = []
const redoStack = []
const undoCount = ref(0)
const redoCount = ref(0)

// AudioContext — created on first user gesture
let audioContext = null

export function useEditorState() {
  // Computed
  const totalDuration = computed(() => getTimelineDuration(state.segments))
  const hasSelection = computed(() => state.selection !== null)
  const hasClipboard = computed(() => state.clipboard !== null && state.clipboard.length > 0)
  const canUndo = computed(() => undoCount.value > 0)
  const canRedo = computed(() => redoCount.value > 0)
  const hasFile = computed(() => state.currentFile !== null)

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

  // Undo support
  function pushUndo() {
    undoStack.push(cloneSegments(state.segments))
    if (undoStack.length > UNDO_STACK_CAP) {
      undoStack.shift()
    }
    // Clear redo on new action
    redoStack.length = 0
    undoCount.value = undoStack.length
    redoCount.value = 0
  }

  function undo() {
    if (undoStack.length === 0) return
    redoStack.push(cloneSegments(state.segments))
    state.segments = undoStack.pop()
    state.selection = null
    undoCount.value = undoStack.length
    redoCount.value = redoStack.length
  }

  function redo() {
    if (redoStack.length === 0) return
    undoStack.push(cloneSegments(state.segments))
    state.segments = redoStack.pop()
    state.selection = null
    undoCount.value = undoStack.length
    redoCount.value = redoStack.length
  }

  // Buffer pool management
  function addBuffer(id, buffer) {
    bufferPool.set(id, buffer)
  }

  function getBuffer(id) {
    return bufferPool.get(id)
  }

  // Peak cache management
  function setPeakCache(bufferId, cache) {
    peakCaches.set(bufferId, cache)
    peakCacheVersion.value++
  }

  function getPeakCache(bufferId) {
    return peakCaches.get(bufferId)
  }

  // File loading
  function loadFile(name, audioBuffer) {
    const bufferId = uuidv4()
    addBuffer(bufferId, audioBuffer)

    const segment = {
      id: uuidv4(),
      sourceBuffer: audioBuffer,
      sourceBufferId: bufferId,
      sourceStart: 0,
      sourceEnd: audioBuffer.duration,
      outputStart: 0,
    }

    state.segments = [segment]
    state.selection = null
    state.playhead = 0
    state.isPlaying = false
    state.clipboard = null
    state.currentFile = {
      name,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
    }
    state.activeTool = null
    state.contextPanelOpen = false
    state.selectedPreset = 'general_clean'
    state.selectedCompliance = 'standard'
    state.processingReport = null

    // Clear undo/redo
    undoStack.length = 0
    redoStack.length = 0
    undoCount.value = 0
    redoCount.value = 0

    return bufferId
  }

  // Edit operations — all push undo first
  function performDelete() {
    if (!state.selection) return
    pushUndo()
    const { start, end } = state.selection
    state.segments = deleteRegion(state.segments, start, end)
    state.selection = null
    if (state.playhead > getTimelineDuration(state.segments)) {
      state.playhead = getTimelineDuration(state.segments)
    }
  }

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

  function performCut() {
    if (!state.selection) return
    pushUndo()
    const { start, end } = state.selection
    // Split at both boundaries to isolate selection segments
    let split = splitSegmentsAtTime(state.segments, start)
    split = splitSegmentsAtTime(split, end)
    // Save inner segments to clipboard (cloned, outputStart relative to selection start)
    const inner = split.filter(seg => {
      const segEnd = seg.outputStart + (seg.sourceBuffer === null ? seg.duration : seg.sourceEnd - seg.sourceStart)
      return seg.outputStart >= start && segEnd <= end
    })
    state.clipboard = inner.map(seg => ({ ...seg, outputStart: seg.outputStart - start }))
    // Delete the region from timeline
    state.segments = deleteRegion(state.segments, start, end)
    state.selection = null
  }

  function performCopy() {
    if (!state.selection) return
    const { start, end } = state.selection
    let split = splitSegmentsAtTime(state.segments, start)
    split = splitSegmentsAtTime(split, end)
    const inner = split.filter(seg => {
      const segEnd = seg.outputStart + (seg.sourceBuffer === null ? seg.duration : seg.sourceEnd - seg.sourceStart)
      return seg.outputStart >= start && segEnd <= end
    })
    state.clipboard = inner.map(seg => ({ ...seg, outputStart: seg.outputStart - start }))
  }

  function performPaste(position) {
    if (!state.clipboard) return
    pushUndo()
    state.segments = insertSegments(state.segments, position, state.clipboard)
  }

  function replaceRegion(start, end, newBuffer) {
    pushUndo()
    const bufferId = uuidv4()
    addBuffer(bufferId, newBuffer)
    state.segments = replaceRegionWithBuffer(
      state.segments, start, end, newBuffer, bufferId
    )
    return bufferId
  }

  // Selection
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

  // Playhead
  function setPlayhead(time) {
    state.playhead = Math.max(0, Math.min(time, getTimelineDuration(state.segments)))
  }

  // Tool
  function setActiveTool(tool) {
    if (state.activeTool === tool) {
      state.activeTool = null
      state.contextPanelOpen = false
    } else {
      state.activeTool = tool
      state.contextPanelOpen = true
    }
  }

  // Processing state
  function startProcessing(message) {
    state.isProcessing = true
    state.processingMessage = message
    state.processingProgress = 0
  }

  function updateProcessingProgress(progress) {
    state.processingProgress = progress
  }

  function endProcessing() {
    state.isProcessing = false
    state.processingMessage = ''
    state.processingProgress = 0
  }

  // Preset / Compliance
  function setPreset(presetId) {
    state.selectedPreset = presetId
    state.selectedCompliance = getDefaultCompliance(presetId)
    state.processingReport = null
  }

  function setCompliance(complianceId) {
    if (isComplianceLocked(state.selectedPreset)) return
    state.selectedCompliance = complianceId
  }

  function setProcessingReport(report) {
    state.processingReport = report
  }

  // Toast
  let toastId = 0
  function showToast(message, duration = 3000) {
    const id = ++toastId
    state.toasts.push({ id, message })
    setTimeout(() => {
      state.toasts = state.toasts.filter(t => t.id !== id)
    }, duration)
  }

  return {
    state,
    bufferPool,
    peakCaches,

    // Computed
    totalDuration,
    hasSelection,
    hasClipboard,
    canUndo,
    canRedo,
    hasFile,

    // AudioContext
    getAudioContext,

    // Undo/Redo
    undo,
    redo,

    // Buffer pool
    addBuffer,
    getBuffer,
    setPeakCache,
    getPeakCache,

    // File
    loadFile,

    // Edit operations
    performDelete,
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

    // Peak cache version (reactive trigger for watchers)
    peakCacheVersion,

    // Tool
    setActiveTool,

    // Processing
    startProcessing,
    updateProcessingProgress,
    endProcessing,

    // Preset / Compliance
    setPreset,
    setCompliance,
    setProcessingReport,

    // Toast
    showToast,
  }
}
