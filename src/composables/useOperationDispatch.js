import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'

/**
 * Runs a registry operation, and answers whether it can run right now.
 *
 * Every surface that can launch an operation — the rail's list, the command
 * palette, the waveform context menu — goes through here, so "what does
 * clicking this do" has exactly one answer no matter where the click came from.
 */
export function useOperationDispatch() {
  const editor = useEditorState()
  const { openWindow } = useWindows()

  /** Whether an operation's precondition is currently satisfied. */
  function isAvailable(op) {
    if (!op) return false
    switch (op.requires) {
      case 'selection': return editor.hasSelection.value
      case 'clipboard': return editor.hasClipboard.value
      case 'file': return editor.hasFile.value
      default: return true
    }
  }

  /**
   * Whether a row for this operation should render as unavailable.
   *
   * Deliberately narrower than !isAvailable: only the parameterless verbs can
   * be dead. Anything that opens a panel or a window stays live, because the
   * thing it opens states the requirement and gates its own Apply button.
   * Dimming those too meant every Effects row looked broken until you'd made a
   * selection, and made "needs a selection" look the same as "can't click this".
   */
  function isDisabled(op) {
    return op?.surface === 'immediate' && !isAvailable(op)
  }

  /** Why an operation can't run, for the notice shown in its panel. */
  function unmetMessage(op) {
    switch (op?.requires) {
      case 'selection': return 'Make a selection on the waveform first'
      case 'clipboard': return 'Copy or cut something first'
      case 'file': return 'Open a file first'
      default: return ''
    }
  }

  /**
   * Launch an operation. Returns true if something happened — callers use this
   * to decide whether to close themselves.
   *
   * Immediate operations are the only ones gated here: opening a panel or a
   * window without a selection is fine and arguably useful, because the panel
   * explains what's missing. Running a verb without one is just a no-op.
   */
  function dispatch(op) {
    if (!op) return false

    if (op.surface === 'immediate') {
      if (!isAvailable(op)) return false
      op.action?.(editor)
      return true
    }

    if (op.surface === 'window') {
      openWindow(op.id)
      return true
    }

    editor.openRailOperation(op.category, op.id)
    return true
  }

  return { dispatch, isAvailable, isDisabled, unmetMessage }
}
