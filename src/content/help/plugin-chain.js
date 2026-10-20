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
    { label: '+ Add plugin', text: 'Lists every effect that can run in the chain. Picking one adds it to the end and opens its window. An effect already in the chain is marked and cannot be added twice' },
    { label: 'ON / BYPASS (header)', text: 'Takes the whole chain out of circuit at once so you can hear the file as it is; each slot keeps its own state' },
    { label: 'ON / BYPASS (slot)', text: 'The plugin’s own power switch — the same one as in its window. A bypassed slot keeps its place and is skipped by Apply' },
    { label: 'Arrows and drag', text: 'Move a slot earlier or later. The top slot processes first' },
    { label: 'Edit', text: 'Opens the plugin’s window to change its settings' },
    { label: '×', text: 'Takes the plugin out of the chain' },
    { label: 'Clear', text: 'Takes every plugin out of the chain' },
    { label: 'Apply', text: 'Renders every live slot over the selection in chain order and commits the result as one undo step, then bypasses those slots so the processing is not heard twice' },
  ],

  notes: [
    'Each plugin renders what the slot before it produced, exactly as if you had applied them one at a time in that order',
    'Measured values such as auto makeup are re-measured on what actually reaches each plugin, so a plugin late in the chain can land a little differently from the preview, which measures the unprocessed file',
    'Opening an effect from the toolbar or the search does not add it to the chain: it plays on its own, after the chain, until you close it — press + CHAIN in its window to add it',
    'Only one effect window is open at a time; opening another replaces it. This window and the Spectrum Analyzer stay open beside it',
    'Peak and Loudness Normalize measure and set level in one step, so they cannot run in the chain and are not in the list',
    'A plugin’s own Apply still writes that plugin alone',
  ],
}
