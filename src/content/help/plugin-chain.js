export default {
  summary: 'Runs every plugin you have turned on in series, in an order you set, and applies them all in one step',

  whenToUse: [
    'You are building a sound from more than one plugin and want to hear them together before committing',
    'The order matters — compressing before or after an EQ, de-essing before or after saturation',
    'You want the whole chain written to the selection as one edit, with one undo',
  ],

  steps: [
    'Press + Add plugin and pick an effect — it joins the end of the chain and opens so you can tune it',
    'Close its window when you are done tuning it; it keeps playing in the chain',
    'Reorder, bypass or remove slots here, then select a region and press Apply',
  ],

  controls: [
    { label: '+ Add plugin', text: 'Opens a search of every effect that can run in the chain — type to filter, then press Enter or click. It joins the end, starting from its default settings, and its window opens beside this one. An effect already in the chain is marked and cannot be added twice' },
    { label: 'ON / BYPASS (header)', text: 'Takes the whole chain out of circuit at once so you can hear the file as it is; each slot keeps its own state' },
    { label: 'ON / BYPASS (slot)', text: 'The plugin’s own power switch — the same one as in its window. A bypassed slot keeps its place and is skipped by Apply' },
    { label: 'Arrows and drag', text: 'Move a slot earlier or later. The top slot processes first' },
    { label: 'Edit', text: 'Opens the plugin’s window to change its settings' },
    { label: '×', text: 'Takes the plugin out of the chain' },
    { label: 'Clear', text: 'Takes every plugin out of the chain' },
    { label: 'Apply', text: 'Renders every live slot over the selection in chain order and commits the result as one undo step, then bypasses the whole chain so the processing is not heard twice. Each plugin keeps its own ON / BYPASS, so turning the chain back on is one switch. Apply is off while the chain is bypassed, since it would write processing you cannot hear. It is the only Apply for a plugin in the chain — their own windows say In chain instead' },
  ],

  notes: [
    'Each plugin renders what the slot before it produced, exactly as if you had applied them one at a time in that order',
    'Measured values such as auto makeup are re-measured on what actually reaches each plugin, so a plugin late in the chain can land a little differently from the preview, which measures the unprocessed file',
    'Opening an effect from the toolbar or the search does not add it to the chain: it opens on its own, closing this window and the chain’s effect windows, and the chain pauses until you close it, even while that effect is bypassed — so it previews, and compares against, exactly what its own Apply writes. The toolbar’s Chain button reads BYPASSED meanwhile, just as it does when you bypass the chain yourself',
    'This window and the effects in the chain can all be open together. The Spectrum Analyzer can stay open beside anything',
    'Peak and Loudness Normalize measure and set level in one step, so they cannot run in the chain and are not in the list',
    'An effect in the chain is a separate copy from the same effect opened from the toolbar or the search. Each has its own settings, so you can use an effect on its own — with its own Apply — while it also sits in the chain, and neither changes the other',
    'An effect opened on its own still has its own Apply, which writes that effect alone',
  ],
}
