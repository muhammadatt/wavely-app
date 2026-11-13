export default {
  summary: 'Runs several effects in series, in an order you set, so you hear them together and apply them all as one edit.',

  intro: [
    'The Effect Chain runs several effects in series, in an order you choose, so you hear them working together before anything is written. When it sounds right, Apply renders the whole chain onto the selection as a single edit with a single undo.',
    'Use it whenever a sound takes more than one effect, when the order matters, compressing before or after an EQ, de-essing before or after saturation, or to save a chain you like and load it on the next file.',
  ],

  quickStart: [
    'Press Add your first effect and pick one — it joins the end of the chain and its window opens so you can tune it.',
    'Add the next effects the same way; each window can stay open beside the chain.',
    'Reorder, bypass or remove slots until the chain sounds right while you play.',
    'Select a region and press Apply — it reads Apply chain to selection, or Apply 3 effects to selection with three live slots.',
  ],

  controls: [
    {
      label: 'Add effect',
      shot: 'add-effect',
      text: 'Opens a list of every effect that can run in the chain and adds the one you pick to the end.',
      details: [
        'It reads Add your first effect while the chain is empty. The list is grouped by toolbar category; type to filter, use the arrow keys and press Enter, or click.',
        'An effect can be added more than once. Each slot is a separate copy with its own settings, numbered when there are several (LA Vintage 2A 1, LA Vintage 2A 2), and a new slot starts from the effect’s defaults.',
        'Its window opens beside this one so you can tune it, and the slot keeps playing in the chain when you close it.',
      ],
    },
    {
      label: 'Slot row',
      text: 'Each row is one effect in the chain, numbered in processing order — the top row runs first.',
      details: [
        'Drag a row by its grip onto another row to move it there.',
      ],
    },
    {
      label: 'ON / BYPASS',
      text: 'The slot’s lamp is the effect’s own power switch, the same one as in its window.',
      details: [
        'A bypassed slot keeps its place and settings and is skipped by Apply. Turning a slot on also turns the whole chain back on if it was bypassed.',
      ],
      range: 'ON, BYPASS',
      default: 'ON',
    },
    {
      label: '↑ / ↓',
      text: 'Move the slot one place earlier or later in the chain.',
    },
    {
      label: 'Edit',
      text: 'Opens the slot’s window to change its settings.',
    },
    {
      label: '×',
      text: 'Takes the slot out of the chain.',
      details: [
        'Its settings go with it: adding the effect again starts from its defaults.',
      ],
    },
    {
      label: 'Clear',
      text: 'Takes every slot out of the chain.',
    },
    {
      label: 'Status line',
      text: 'Says how many slots are live, or that the chain or every slot is bypassed.',
    },
    {
      label: 'Presets',
      text: 'The preset browser in the window header saves and loads whole chains — every slot, its ON / BYPASS and its settings.',
      details: [
        'Loading a chain replaces the one in the rack. Values an effect measures from the file, such as auto makeup, are never saved; they are measured again on the next file.',
      ],
    },
  ],

  notes: [
    'Use the ON / BYPASS in the window header to hear the file without the chain. Each slot keeps its own setting.',
    'After Apply the whole chain is bypassed so the processing is not heard twice. Turn it back on with the header switch.',
    'Apply needs a selection and at least one live slot. Effects in the chain have no Apply of their own.',
    'Opening an effect from the toolbar or search opens a separate copy with its own Apply, and bypasses the chain until you turn it back on.',
    'Peak and Loudness Normalize cannot go in the chain. Run them before or after it.',
  ],
}
