export default {
  summary: 'Runs every plugin you have turned on in series, in an order you set, and applies them all in one step',

  whenToUse: [
    'You are building a sound from more than one plugin and want to hear them together before committing',
    'The order matters — compressing before or after an EQ, de-essing before or after saturation',
    'You want the whole chain written to the selection as one edit, with one undo',
  ],

  steps: [
    'Open an effect and turn it on — it joins the end of the chain',
    'Close its window when you are done tuning it; it keeps playing in the chain',
    'Reorder, bypass or remove slots here, then select a region and press Apply',
  ],

  controls: [
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
    'A plugin’s own Apply still writes that plugin alone',
  ],
}
