# Wavely — Browser-Based Audio Editor

## Project Overview

Wavely is a fully browser-based, consumer-grade audio editor. No installation, no plugins, no server-side processing. Target users are everyday people — podcasters, voice memo editors, content creators — not professional audio engineers.

The design reference for all UI work is **`mockup/audio-editor-mockup.html`**. Before writing any UI code, open this file in a browser and study the layout, component structure, colour tokens, and interaction patterns. Match it closely. Do not invent new UI patterns — implement what is shown.

---

## Scope

### Included
- Editing: cut, trim, paste, delete region, silence region, split
- Processing: normalize, noise reduction, dynamic compression
- Waveform display with zoom and scroll
- Selection-based editing with keyboard shortcuts
- Import: WAV, MP3, OGG, M4A
- Export: WAV, OGG (MP3 via lamejs)
- Undo / redo (minimum 50 steps)

### Explicitly Out of Scope
- Live recording or monitoring
- VST / AU / AAX plugin support
- MIDI
- Multi-track mixing
- Real-time effects during playback
- Server-side processing of any kind

---

## Core Data Model

This is a **non-destructive editing model**. Original audio data is never modified until the user exports. All edits are segment pointer manipulations — the same model as professional video editors (EDL).

### Source Buffer Pool

All decoded audio lives in a pool of immutable `AudioBuffer` objects:
- **Original buffers** — decoded from the file the user opened
- **Processed buffers** — output of normalize, noise reduction, etc.

Buffers are **never modified in place**. Processing always produces a new buffer.

### Segment

The fundamental unit of the timeline. A lightweight descriptor that points into a source buffer:

```js
Segment {
  id: string          // UUID
  sourceBuffer: AudioBuffer  // reference into buffer pool
  sourceStart: number // start offset within source (seconds)
  sourceEnd: number   // end offset within source (seconds)
  outputStart: number // position on the timeline (seconds)
}

// Derived — never stored:
// outputEnd = outputStart + (sourceEnd - sourceStart)

// Silence segment (no source audio):
SilenceSegment {
  id: string
  sourceBuffer: null
  duration: number    // length in seconds
  outputStart: number
}
```

### Timeline

Ordered array of Segments. Single source of truth for all edit state.

```js
Timeline {
  segments: Segment[]  // ordered by outputStart
  totalLength: number  // sum of all segment durations (seconds)
}
```

### How Operations Transform the Timeline

| Operation | Timeline Transformation |
|---|---|
| Trim start | Increase `sourceStart` of first segment |
| Trim end | Decrease `sourceEnd` of last segment |
| Delete region | Split at selection boundaries → remove middle segments → recalculate `outputStart` for all following segments |
| Cut to clipboard | Same as delete, save removed segments to clipboard |
| Paste | Insert segment(s) at playhead → shift all following segments right |
| Silence region | Replace selection segments with `SilenceSegment` of equal duration |
| Split at playhead | Divide one segment into two at the playhead position |
| Normalize / Compress / Noise reduce | Render selection to new `AudioBuffer` → replace segment(s) with pointer to new buffer |

**Key rule:** Only processing operations (normalize, compress, noise reduce) create new `AudioBuffer` data. Editing operations (cut, trim, paste, delete) only manipulate the segment array — no audio data is touched.

### Selection

```js
Selection {
  start: number  // seconds from timeline start
  end: number    // seconds from timeline start
}
// null = no active selection
```

### Full Editor State

```js
EditorState {
  timeline: Timeline
  bufferPool: Map<string, AudioBuffer>
  selection: Selection | null
  playhead: number          // seconds
  isPlaying: boolean
  undoStack: TimelineSnapshot[]
  redoStack: TimelineSnapshot[]
  clipboard: Segment[] | null
}
```

---

## Undo / Redo

Implemented as a snapshot stack of the **segment array only** — not the buffer pool.

- Before every operation: deep copy the current segment array onto `undoStack`
- Undo: pop `undoStack`, push current onto `redoStack`, restore snapshot
- Buffer pool grows monotonically — unused buffers are GC'd by the browser
- Stack cap: 50 snapshots minimum
- Each snapshot is cheap — it's just an array of small descriptor objects, no audio data

---

## Playback Engine

Uses Web Audio API `AudioBufferSourceNode`. Walks the segment array and schedules each segment at the correct time with sample-accurate scheduling:

```js
function schedulePlayback(timeline, startTime, audioContext) {
  const now = audioContext.currentTime;
  for (const segment of timeline.segments) {
    if (segment.outputStart + duration(segment) < startTime) continue;
    const node = audioContext.createBufferSource();
    node.buffer = segment.sourceBuffer;
    node.connect(audioContext.destination);
    const scheduleAt = now + Math.max(0, segment.outputStart - startTime);
    const offset = Math.max(0, startTime - segment.outputStart) + segment.sourceStart;
    const playLen = segment.sourceEnd - offset;
    node.start(scheduleAt, offset, playLen);
  }
}
```

Stop: call `stop()` on all active source nodes and cancel pending scheduled nodes.

---

## Waveform Renderer

### Peak Cache

Pre-computed per `AudioBuffer`. Stores min/max sample values per pixel column at base zoom. Computed once (on load or after processing) in a Web Worker:

```js
PeakCache {
  bufferID: string
  samplesPerPx: number       // at base zoom level
  peaks: Float32Array        // interleaved [min0, max0, min1, max1, ...]
}
```

### Rendering

- Canvas 2D API (WebGL optional for very long files)
- Renderer walks segment array, draws each segment's peaks at the correct horizontal position
- Zoom: sample the peak cache at higher/lower density
- Renderer is **read-only** — never modifies the data model
- Redraw triggered on: timeline change, zoom change, scroll, window resize
- Three canvas layers: waveform, selection overlay, playhead

---

## Processing Pipeline

All processing follows the same pattern:
1. Render affected region from timeline to flat PCM buffer
2. Apply algorithm
3. Produce new `AudioBuffer`
4. Insert into buffer pool
5. Replace affected segment(s) with new segment pointing to result
6. All processing runs in a **Web Worker** with progress callback

### Normalize
- Scan selection for peak amplitude
- Gain factor = targetPeak (e.g. -1 dBFS) / currentPeak
- Multiply all samples by gain factor
- Pure JS — no WASM

### Dynamic Compression
- Use `OfflineAudioContext` + native `DynamicsCompressorNode`
- Expose threshold, ratio, attack, release as UI sliders
- No WASM

### Noise Reduction
- **Production:** RNNoise WASM, process in 10ms frames
- **PoC stub:** Simple spectral subtraction in pure JS — acceptable for proving the architecture
- Always run in Web Worker with chunked progress updates
- Set clear UI expectations — show a progress bar

### Export / Render
- Concatenate all segments in order to produce flat PCM
- **WAV:** Manual encoding — 44-byte header + raw PCM, no library needed
- **OGG:** Browser native `MediaRecorder` or encoder library
- **MP3:** lamejs (pure JS, no server required)

---

## Application Architecture

```
┌─────────────────────────────────────────────┐
│ UI Layer                                    │
│ Canvas waveform · Toolbar · Selection       │
│ Keyboard shortcuts · Progress indicators    │
└─────────────────┬───────────────────────────┘
                  │ dispatches actions
┌─────────────────▼───────────────────────────┐
│ Editor State                                │
│ Timeline · Selection · Playhead · UndoStack │
│ Pure data — no side effects                 │
└─────────────────┬───────────────────────────┘
                  │ reads / writes
┌─────────────────▼───────────────────────────┐
│ Operation Layer                             │
│ cut() · trim() · paste() · silence()        │
│ Pure functions: (state, params) => newState │
└──────────┬──────────────────┬───────────────┘
           │                  │ dispatches jobs
┌──────────▼──────────┐  ┌────▼───────────────────┐
│ Audio Engine        │  │ Processing Workers      │
│ Web Audio API       │  │ normalize · compress    │
│ Source scheduling   │  │ noise reduce · export   │
└──────────┬──────────┘  └────┬───────────────────┘
           │                  │
┌──────────▼──────────────────▼───────────────┐
│ Source Buffer Pool                          │
│ Immutable AudioBuffers · Peak caches        │
│ (OPFS for large files in production)        │
└─────────────────────────────────────────────┘
```

---

## Technology Choices

| Concern | Technology |
|---|---|
| UI framework | Vanilla JS + Canvas for PoC; Vue 3 for production |
| Audio decode / playback | Web Audio API (native) |
| Waveform rendering | Canvas 2D API |
| Processing workers | Web Workers (postMessage job queue) |
| Noise reduction | RNNoise WASM (stub with spectral subtraction for PoC) |
| MP3 export | lamejs (pure JS) |
| WAV export | Manual PCM encoding (no library) |
| Large file scratch | OPFS — production only, not needed for PoC |
| State management | Plain JS module with reducer-style functions |

**Export note:** Use the traditional download-blob approach for PoC export. The File System Access API is Chrome/Edge only — don't use it until production.

---

## File Structure

```
audio-editor/
├── index.html          # Entry point
├── mockup/
│   └── audio-editor-mockup.html  # UI design reference — read this first
├── css/
│   └── editor.css
├── js/
│   ├── main.js         # App init, event wiring
│   ├── state.js        # EditorState, undo/redo
│   ├── operations.js   # cut, trim, delete, silence, split
│   ├── playback.js     # AudioContext scheduling
│   ├── renderer.js     # Canvas waveform drawing
│   ├── peakWorker.js   # Web Worker — peak cache computation
│   ├── processing.js   # normalize, compress (calls processWorker)
│   ├── processWorker.js # Web Worker — audio processing
│   └── export.js       # WAV encoding, file download
└── lib/
    └── lamejs/         # MP3 encoder (production)
```

No build step required for PoC. Serve as static assets. Use ES modules (`type="module"`).

---

## PoC Build Scope

### Must-Haves
- Load WAV or MP3 from disk via file input
- Display a zoomable, scrollable waveform on Canvas
- Click-and-drag to make a selection
- Delete selected region (proves segment model works)
- Trim: remove audio before/after selection
- Playback from any point with moving playhead
- Normalize the selected region
- Export as WAV
- Undo / redo (10+ steps for PoC)

### Nice-to-Haves
- Silence region operation
- Basic compression via `OfflineAudioContext` + `DynamicsCompressorNode`
- Keyboard shortcuts: Space = play/pause, Ctrl+Z = undo, Delete = delete selection
- Zoom in/out controls

### Deferred to Production
- Noise reduction (RNNoise WASM)
- MP3 / OGG export
- Cut and paste between positions
- OPFS scratch disk for long files
- File System Access API (save-in-place)
- Waveform rendering optimizations for files > 30 minutes

---

## Critical Implementation Rules

These are the most common sources of bugs. Read carefully.

**`outputStart` recalculation**
After any delete, trim, or paste, recalculate `outputStart` for **every** segment in the array from scratch by summing durations. Do not attempt to update only the affected segments — it is error-prone and the full recalculation is cheap. The segment array is the single source of truth. If something looks wrong in the waveform or playback, the bug is almost certainly here.

**Selection spanning multiple segments**
When a user selection spans multiple segments (which will happen after any cut), the operation must split at both ends of the selection first, then operate on the middle segments. Always normalise the selection against the timeline before operating.

**AudioContext must be created on user gesture**
Browsers block `AudioContext` creation until the user has interacted with the page. Create it on the first button click or file load — never on page load.

**Peak cache in Web Worker**
Computing the peak cache on the main thread will freeze the UI for large files. Always run it in a Web Worker and post the result back. Show a loading indicator during computation.

**Canvas pixel ratio**
Multiply canvas `width`/`height` attributes by `window.devicePixelRatio`. Scale the 2D context by the same factor. Set CSS `width`/`height` to the logical (unscaled) size. Skipping this produces blurry waveforms on retina displays.

**Float32Array throughout**
The Web Audio API uses 32-bit float samples in range `[-1.0, 1.0]`. Use `Float32Array` everywhere internally. Never use integer sample formats.

**Debugging tip**
Add `console.log(state.timeline.segments)` after every operation during development. Nearly all bugs are visible here immediately.
