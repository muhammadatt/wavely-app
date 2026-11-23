/**
 * The selection's quick actions — Cut, Copy, Paste, Silence, Trim, Split — shared by
 * the desktop SelectionBar and the mobile shell's action bar, so both run the
 * same operation with the same toast. Each is a no-op without its
 * precondition, and the toast fires only once the operation has run. Silence
 * and Trim run the registry's `quick` action, which the Trim / Silence panels
 * and the right-click menu use too.
 */
import { computed, ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useOperationDispatch } from './useOperationDispatch.js'
import { getOperation } from '../ui/registry.js'
import { nudgeStep, nudgedSelection } from '../audio/selectionDrag.js'

// The waveform's zoom, which the nudge step follows: WaveformArea announces
// every view change as `wavely:view-update`. One listener for the app.
const viewPps = ref(100)
if (typeof window !== 'undefined') {
  window.addEventListener('wavely:view-update', (e) => {
    const pps = e.detail?.pixelsPerSecond
    if (Number.isFinite(pps) && pps > 0) viewPps.value = pps
  })
}

export function useSelectionActions() {
  const {
    state, hasSelection, hasClipboard, performCut, performCopy, performPaste, showToast,
    totalDuration, performSplit, performSplitAtSelectionEdges,
  } = useEditorState()
  const { dispatch } = useOperationDispatch()

  // Cut, Paste, Silence and Trim change the timeline, which the editor refuses
  // while this file renders an apply.
  const busy = computed(() => !!state.isProcessing)

  function copy() {
    if (!hasSelection.value) return
    performCopy()
    showToast('Copied to clipboard')
  }

  function cut() {
    if (!hasSelection.value) return
    if (performCut()) showToast('Cut to clipboard')
  }

  function paste() {
    if (!hasClipboard.value) return
    if (performPaste(state.playhead)) showToast('Pasted at playhead')
  }

  function silence() {
    dispatch(getOperation('silence'), { quick: true })
  }

  function trim() {
    dispatch(getOperation('trim'), { quick: true })
  }

  /**
   * Split where the user is pointing: at both edges of the selection when
   * there is one, else at the playhead — the Split panel's two modes, picked
   * by what is on screen.
   */
  function split() {
    if (hasSelection.value) {
      if (performSplitAtSelectionEdges()) showToast('Split at selection edges')
    } else if (performSplit()) {
      showToast('Split at playhead')
    }
  }

  /** Seconds one nudge moves an edge: ~3 px at the current zoom, a round number. */
  const nudgeSeconds = computed(() => nudgeStep(viewPps.value))

  /** Move the selection's `edge` ('start' | 'end') one step, `direction` −1 or +1. */
  function nudge(edge, direction) {
    if (!state.selection) return
    state.selection = nudgedSelection(state.selection, edge, direction * nudgeSeconds.value, totalDuration.value)
  }

  return { busy, copy, cut, paste, silence, trim, split, nudge, nudgeSeconds }
}
