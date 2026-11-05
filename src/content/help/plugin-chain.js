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
    { label: '+ Add plugin', text: 'Opens a search of every effect that can run in the chain — type to filter, then press Enter or click. It joins the end, starting from its default settings, and its window opens beside this one. An effect can be added more than once — each slot has its own settings, and the slots are numbered (LA Vintage 2A 1, LA Vintage 2A 2)' },
    { label: 'ON / BYPASS (header)', text: 'Takes the whole chain out of circuit at once so you can hear the file as it is; each slot keeps its own state' },
    { label: 'ON / BYPASS (slot)', text: 'The plugin’s own power switch — the same one as in its window. A bypassed slot keeps its place and is skipped by Apply' },
    { label: 'Arrows and drag', text: 'Move a slot earlier or later. The top slot processes first' },
    { label: 'Edit', text: 'Opens the plugin’s window to change its settings' },
    { label: '×', text: 'Takes the plugin out of the chain. Its settings go with it: adding it again starts from its defaults' },
    { label: 'Clear', text: 'Takes every plugin out of the chain' },
    { label: 'Calibrate', text: 'Plays the chain through, offline, over the selection (or the whole file with nothing selected), so each plugin measures what the plugins above it actually hand it — its makeup, its input level, its ceiling — exactly as Apply will. Shown when two or more plugins are on. On a long file with nothing selected it takes about as long as applying the chain' },
    { label: 'MANUAL / AUTO', text: 'MANUAL calibrates when you press Calibrate. AUTO calibrates by itself, a moment after anything above a plugin changes — handy on a short selection, slow on a whole long file. Your choice is remembered' },
    { label: 'STALE', text: 'Shown on a plugin that is measuring audio it will not hear: something above it changed since the last calibration. Until you calibrate it keeps the last calibration’s measurements (or, after an edit or a new selection, the unprocessed file’s)' },
    { label: 'Apply', text: 'Renders every live slot over the selection in chain order and commits the result as one undo step, then bypasses the whole chain so the processing is not heard twice. Each plugin keeps its own ON / BYPASS, so turning the chain back on is one switch. Apply is off while the chain is bypassed, since it would write processing you cannot hear. It is the only Apply for a plugin in the chain — their own windows say In chain instead' },
  ],

  notes: [
    'Each plugin renders what the slot before it produced, exactly as if you had applied them one at a time in that order',
    'Measured values such as auto makeup are taken on what actually reaches each plugin — on Apply always, and in the preview once the chain is calibrated. Until then a plugin after another one that changes level (a compressor after another compressor that adds makeup, say) measures the unprocessed file and can sound different on Apply; it is marked STALE. For now the compressors (LA Vintage 2A, LA Classic 76, Scheps Parallel) and the Soft Clipper follow calibration in the preview; the other plugins still measure the unprocessed file there',
    'Opening an effect from the toolbar or the search does not add it to the chain: it opens on its own, closing this window and the chain’s effect windows, and the chain is bypassed, even while that effect is bypassed — so it previews, and compares against, exactly what its own Apply writes. The chain stays bypassed after you close the effect, and the toolbar’s Chain button reads BYPASSED, until you turn it back on here',
    'This window and the effects in the chain can all be open together. The Spectrum Analyzer can stay open beside anything',
    'Peak and Loudness Normalize measure and set level in one step, so they cannot run in the chain and are not in the list',
    'An effect in the chain is a separate copy from the same effect opened from the toolbar or the search. Each has its own settings, so you can use an effect on its own — with its own Apply — while it also sits in the chain, and neither changes the other',
    'An effect opened on its own still has its own Apply, which writes that effect alone',
  ],
}
