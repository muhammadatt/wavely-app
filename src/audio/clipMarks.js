/**
 * Timeline positions where a stage did something audible, for the waveform to
 * mark.
 *
 * WHY THIS IS NOT PART OF THE SOFT CLIPPER. The waveform is the app's most
 * generic component and must not import a plugin's composable to draw itself —
 * the moment it does, every future stage that wants a mark either forks it or
 * adds another import. This is the seam: a stage pushes marks in, the waveform
 * reads them out, and neither knows about the other.
 *
 * WHY IT EXISTS AT ALL, reported from use: the clip lamp says the stage just
 * fired, and nothing on screen says WHERE. On a 35 s narration the stage
 * engages on a couple of percent of blocks, so "it lit up somewhere in the
 * last second" is the entire answer the panel could give. A mark on the
 * waveform turns that into "on that word".
 *
 * MARKS ARE DEDUPED ONTO A TIME GRID, which is what lets them accumulate
 * across playback passes instead of being cleared at every transport start.
 * Replaying the same passage re-reports the same events; without a grid the
 * list would grow without bound on a loop, and clearing per pass would throw
 * away the map the user is trying to build by scrubbing around. The grid keeps
 * the loudest reading for each slot, so a second pass can only sharpen a mark,
 * never duplicate or dilute it.
 *
 * THEY ARE CLEARED BY SETTINGS CHANGES, NOT BY TRANSPORT. A mark records what
 * the CURRENT settings do; the moment Headroom or the knee moves, every
 * existing mark is a claim about a stage that no longer exists. Callers are
 * responsible for calling clearClipMarks() on any parameter change, on bypass,
 * and when the file changes.
 */

/**
 * Grid resolution, seconds. 5 ms is finer than the ~23 ms the kernel's meter
 * message cadence can distinguish anyway, so it never merges two genuinely
 * separate reports, and at 1-4 events per second on real speech it leaves the
 * map sparse.
 */
const GRID_S = 0.005

/**
 * Hard cap on stored marks. At the grid above this is 20 s of continuously
 * clipping audio, far past anything this stage produces on speech — it exists
 * so a pathological setting cannot grow the map without bound while someone
 * loops a passage.
 */
const MAX_MARKS = 4000

/** slot index -> peak reduction dB seen in that slot */
const marks = new Map()

/**
 * Bumped on every change. The waveform overlay redraws on its own schedule and
 * needs a cheap way to tell whether the map moved since it last painted —
 * comparing a Map by content every frame would cost more than the redraw.
 */
let version = 0

/**
 * Record that a stage reduced by `db` at timeline position `t` seconds.
 *
 * Silently ignores non-finite or negative times: the caller derives `t` from an
 * AudioContext clock against a transport origin, and a message that arrives
 * after the transport stopped can produce either.
 */
export function recordClipMark(t, db) {
  if (!Number.isFinite(t) || t < 0 || !(db > 0)) return
  if (marks.size >= MAX_MARKS) return
  const slot = Math.round(t / GRID_S)
  const prev = marks.get(slot)
  if (prev !== undefined && prev >= db) return
  marks.set(slot, db)
  version++
}

/**
 * All marks as [{ t, db }], ascending.
 *
 * Rebuilt per call rather than maintained sorted, because the caller is a
 * canvas that redraws only when `version` moved and the map is a few hundred
 * entries. Sorting on write would pay the cost on the audio-message path
 * instead, which is the one that must stay cheap.
 */
export function getClipMarks() {
  return [...marks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, db]) => ({ t: slot * GRID_S, db }))
}

/** Cheap change token for redraw decisions. */
export function getClipMarksVersion() {
  return version
}

/**
 * Marks are timeline positions in ONE file. Switching files would leave them
 * pointing at seconds that mean something else entirely.
 *
 * Expressed as a scope key the reader asserts on every draw rather than as a
 * watcher the writer has to remember to wire: the waveform already knows which
 * file it is painting, and a stale-mark bug caused by a missing watcher is
 * invisible until someone notices marks in the wrong place.
 */
let scopeKey = null

export function setClipMarksScope(key) {
  if (key === scopeKey) return
  scopeKey = key
  clearClipMarks()
}

export function clearClipMarks() {
  if (marks.size === 0) return
  marks.clear()
  version++
}
