/**
 * Whether Apply may run, and the one line that says why not — first reason
 * wins, in the order the user can act on them. '' when it may.
 *
 * Nothing applies over a file that is already being processed: two renders of
 * the same selection would each commit, the later one overwriting the earlier
 * (a solo plugin opened while the chain was applying could do exactly that).
 * A LOCKED Apply is not blocked — clicking it asks for the plan.
 */
export function applyGate({
  inChain, busy, applyDisabled, applyDisabledHint, requiresSelection, hasSelection, locked, lockedHint, offline,
}) {
  const blocked = !!inChain || busy || !!applyDisabled || (requiresSelection && !hasSelection)
  let title = ''
  if (inChain) title = 'This plugin is in the Effect Chain — apply it from the chain'
  else if (busy) title = 'This file is still being processed — wait for it to finish'
  else if (applyDisabled) title = applyDisabledHint
  else if (requiresSelection && !hasSelection) title = 'Select audio to apply this effect to'
  // An offline process has no preview to offer, so it does not promise one.
  else if (locked) title = lockedHint + (offline ? '' : ' — preview is free')
  return { blocked, title }
}
