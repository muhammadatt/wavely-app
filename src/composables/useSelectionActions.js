/**
 * The selection's quick actions — Cut, Copy, Paste, Silence, Trim — shared by
 * the desktop SelectionBar and the mobile shell's action bar, so both run the
 * same operation with the same toast. Each is a no-op without its
 * precondition, and the toast fires only once the operation has run. Silence
 * and Trim run the registry's `quick` action, which the Trim / Silence panels
 * and the right-click menu use too.
 */
import { computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useOperationDispatch } from './useOperationDispatch.js'
import { getOperation } from '../ui/registry.js'

export function useSelectionActions() {
  const {
    state, hasSelection, hasClipboard, performCut, performCopy, performPaste, showToast,
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

  return { busy, copy, cut, paste, silence, trim }
}
