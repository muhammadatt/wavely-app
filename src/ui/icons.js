/**
 * Icon paths, in one place.
 *
 * Every icon in the app used to be either an inline <svg> or a raw path string
 * `v-html`'d from whichever component happened to need it, which meant the same
 * glyph was redrawn slightly differently in three files. These are the inner
 * contents of a 24x24 stroked viewBox; render them through Icon.vue.
 */
export const ICONS = {
  // Categories — these carry the toolbar at 15px, so each is kept to three or
  // four strokes and chosen to be unmistakable from the other three at a glance.
  //
  // Split: a dashed cut line with the halves moving apart. The old glyph was a
  // line with chevrons above and below, which read as "expand vertically".
  split: '<path d="M12 3v3M12 10.5v3M12 18v3"/><path d="M7.5 8.5L4 12l3.5 3.5"/><path d="M16.5 8.5L20 12l-3.5 3.5"/>',
  // Edit: pencil. Kept, but `trim` no longer duplicates it (see below).
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  // Effects: channel faders. The old concentric arcs read as wifi/broadcast;
  // faders say "parameters you move", which is what every effect window is.
  effects: '<path d="M5 21v-6M5 11V3M12 21v-9M12 8V3M19 21v-4M19 13V3"/><path d="M2.5 15h5M9.5 12h5M16.5 17h5"/>',
  // Master: a VU-style gauge. The old glyph was a star, which reads as
  // "favourite" everywhere else in software, not "final, measured output".
  master: '<path d="M3.5 18a9 9 0 1117 0"/><path d="M12 18l4.5-5"/><circle cx="12" cy="18" r="1.3"/>',

  // Edit operations
  // Trim: crop marks. Was a byte-identical copy of the `edit` pencil, so the
  // category and its first row drew the same glyph.
  trim: '<path d="M6 2v14a2 2 0 002 2h14"/><path d="M18 22V8a2 2 0 00-2-2H2"/>',
  silence: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  fade: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  volume: '<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/>',

  // Clipboard verbs
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  paste: '<path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
  selectAll: '<path d="M3 8V5a2 2 0 012-2h3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M8 21H5a2 2 0 01-2-2v-3"/><rect x="8" y="8" width="8" height="8" rx="1"/>',

  // Effects
  normalize: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  opto: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  fet: '<polyline points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>',
  // Tube saturation: light-bulb silhouette to suggest analog tube glow.
  saturation: '<path d="M12 3a6 6 0 00-3.6 10.8c1 .8 1.6 1.8 1.8 3.2h3.6c.2-1.4.8-2.4 1.8-3.2A6 6 0 0012 3z"/><path d="M9 17h6"/><path d="M9.5 20h5"/><path d="M10 11l2 2 2-2"/>',
  // A rising shelf: flat, then a gentle knee up to a plateau — the air curve.
  air: '<path d="M2 17c5 0 8 0 11-5s5-5 9-5"/><path d="M2 21h20" opacity=".35"/>',
  noise: '<path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 23h8"/>',
  // Waveform, flat stretch, waveform — the gap being targeted. Was a second
  // copy of the `cut` scissors, which is the clipboard verb's glyph.
  removeSilence: '<path d="M3 6v12M7 9v6"/><path d="M9.5 12h5"/><path d="M17 9v6M21 6v12"/>',

  // Presets — keyed by preset id so PresetsPanel can look them up directly
  acx_audiobook: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
  podcast_ready: '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  voice_ready: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/>',
  general_clean: '<path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/>',
  noise_eraser: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/><path d="M19 2l-7 7M5 22l7-7" stroke-width="2.5"/>',
  clearervoice_eraser: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>',

  // Transport
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',

  // History
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-4"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h4"/>',

  // UI
  check: '<polyline points="20 6 9 17 4 12"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>',
}

export function getIcon(name) {
  return ICONS[name] ?? ''
}
