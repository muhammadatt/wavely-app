/**
 * HF Softener activity scope — the data side, kept free of Vue and the audio
 * graph so it can be tested in node.
 *
 * The kernel reports one point per process() call (SCOPE_STRIDE floats: input
 * peak, output peak after Duck and EQ, dB the lisp guard held back, plosive
 * burst weight). The wrapper appends them to a ring; the scope component reads
 * the ring each frame and draws the OUTPUT waveform with what was removed
 * around it, the way Pro-DS paints treated regions on the waveform itself.
 *
 * ⚠ THE WAVEFORM IS THE PEAK AFTER DUCK AND EQ, BEFORE AIR AND RESO. Air is a
 * lift, so drawing after it would show "removed" energy going negative on
 * vowels; Reso is a separate stage 512 samples later and is reported in the
 * readout instead. The EQ is a band cut, so on a full-band peak it barely
 * registers — the scope is mostly a picture of the Duck, which is the stage
 * the ear reads as "the s got quieter".
 */

import { SCOPE_STRIDE } from './hfSoftenerProcessor.js'

export { SCOPE_STRIDE }

/** Seconds of history — half the face; the other half is the lookahead. */
export const HF_SCOPE_SECONDS = 2

/** A column counts as treated when output sits this far under input, dB. */
export const TREATED_DB = 0.75

/** A column counts as a plosive when the burst window weight reached this. */
export const PLOSIVE_WEIGHT = 0.5

/**
 * Ring of scope points, oldest-to-newest from `head`, wrapping.
 * Sized for `seconds` of 128-sample quanta at `sampleRate`.
 */
export function createScopeRing(sampleRate, seconds = HF_SCOPE_SECONDS) {
  const capacity = Math.ceil((seconds * sampleRate) / 128)
  const inPeak = new Float32Array(capacity)
  const outPeak = new Float32Array(capacity)
  const held = new Float32Array(capacity)
  const burst = new Float32Array(capacity)
  let head = 0
  let filled = 0
  const view = { inPeak, outPeak, held, burst, capacity, head: 0, filled: 0 }
  return {
    /** Append a batch of interleaved points from the kernel's meter message. */
    push(batch) {
      if (!batch) return
      for (let i = 0; i + SCOPE_STRIDE - 1 < batch.length; i += SCOPE_STRIDE) {
        inPeak[head] = batch[i]
        outPeak[head] = batch[i + 1]
        held[head] = batch[i + 2]
        burst[head] = batch[i + 3]
        head = head + 1 === capacity ? 0 : head + 1
        if (filled < capacity) filled++
      }
    },
    /** The live arrays — read them, do not retain them. */
    view() {
      view.head = head
      view.filled = filled
      return view
    },
    clear() {
      head = 0
      filled = 0
    },
  }
}

/**
 * Classify one column: 0 untouched, 1 treated (de-essed), 2 plosive.
 * Treated means the output sits at least TREATED_DB under the input; plosive
 * means it was treated inside a burst window.
 */
export function columnKind(inPk, outPk, burstW) {
  if (!(inPk > 0) || !(outPk < inPk * Math.pow(10, -TREATED_DB / 20))) return 0
  return burstW >= PLOSIVE_WEIGHT ? 2 : 1
}

/**
 * Runs of columns of one kind, as inclusive [from, to] index pairs over
 * `kinds[0..n)`. One polygon per run is what the scope draws — a single path
 * across the band would join runs through the untreated gaps between them.
 */
export function kindRuns(kinds, n, kind) {
  const runs = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    const on = i < n && kinds[i] === kind
    if (on && start < 0) start = i
    else if (!on && start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  }
  return runs
}

/** dB a column's shaded depth may fall per column (~2.9 ms at 44.1 kHz). */
export const SHADE_FALL_DB = 0.4

/**
 * The scope's SHADING: per column, how deep the cut was (dB), what kind it
 * was, and whether the lisp guard held back — smoothed so a treated "s" reads
 * as one block, not a comb.
 *
 * The raw per-quantum cut flickers across the threshold inside one "s" (the
 * Duck and EQ follow the waveform's own ripple), so drawn as-is the shading
 * broke into slivers. Depth here falls at most SHADE_FALL_DB per column — an
 * instant attack and a ~40 ms release from 6 dB — which bridges those gaps
 * without moving the start of a treated region. Kind and guard ride the same
 * envelope: a column is treated while its smoothed depth is ≥ TREATED_DB, a
 * plosive while a burst window was open within the region, guarded while the
 * guard held ≥ 0.5 dB anywhere in it.
 *
 * Writes `depth`, `kind` (0/1/2 as columnKind) and `guard` (0/1) for [0, n).
 */
export function shadeColumns(inPeak, outPeak, burst, held, n, depth, kind, guard, fallDb = SHADE_FALL_DB) {
  let d = 0
  let plosive = false
  let guarded = false
  for (let i = 0; i < n; i++) {
    const a = inPeak[i]
    const b = outPeak[i]
    const raw = a > 0 && b > 0 ? Math.max(0, 20 * Math.log10(a / b)) : 0
    const fresh = raw >= TREATED_DB
    d = Math.max(raw, d - fallDb)
    const on = d >= TREATED_DB
    if (!on) {
      plosive = false
      guarded = false
    } else if (fresh) {
      if (burst[i] >= PLOSIVE_WEIGHT) plosive = true
      if (held[i] >= 0.5) guarded = true
    }
    depth[i] = on ? d : 0
    kind[i] = on ? (plosive ? 2 : 1) : 0
    guard[i] = on && guarded ? 1 : 0
  }
}
