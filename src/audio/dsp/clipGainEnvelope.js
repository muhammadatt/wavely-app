/**
 * Clip-gain envelope renderer (client copy).
 *
 * Pure-JS port of the cosine-fade envelope renderer in
 * server/scripts/clip_gain_deesser.py. Given a list of treated sibilant events
 * (as emitted by applyClipGainDeEsser into ctx.results.clipGainDeEsser),
 * synthesises a per-sample linear gain multiplier ready to drop into a mix
 * loop.
 *
 * Verbatim copy of server/pipeline/clipGainEnvelope.js, which was already
 * dependency-free. The realtime de-esser rebuilds its envelope on the main
 * thread whenever a knob moves and posts the Float32Array to the worklet, so
 * both sides share one definition of the envelope shape.
 *
 * KEEP IN SYNC with the server copy, which parallelCompression.js uses to reuse
 * the clip-gain decision on its wet branch.
 *
 * No I/O, no Python spawn, no allocation beyond the returned Float32Array.
 */

const DEFAULT_FADES = {
  fricativeInMs:  3.0,
  fricativeOutMs: 4.0,
  affricateInMs:  1.5,
  affricateOutMs: 4.5,
}

/**
 * @param {number}   numSamples
 * @param {number}   sampleRate
 * @param {Array<{startSample?:number, endSample?:number, startSec?:number,
 *                endSec?:number, gainDb:number, eventType?:string}>} treatedEvents
 *   From ctx.results.clipGainDeEsser.treatedEvents.
 *   startSample/endSample preferred; falls back to startSec/endSec * sampleRate.
 * @param {Partial<typeof DEFAULT_FADES>} [fades]
 *   Per-preset fade timings. Falls back to the same defaults the Python script
 *   uses when keys are absent.
 * @returns {{ multiplier: Float32Array, eventCount: number, inputCount: number,
 *            maxReductionDb: number, skipped: Array<{index:number,reason:string}> }}
 *   eventCount is how many events were RENDERED. Compare with inputCount to
 *   detect events that could not be placed; `skipped` says why for each.
 */
export function buildClipGainEnvelope(numSamples, sampleRate, treatedEvents, fades = {}) {
  const multiplier = new Float32Array(numSamples)
  multiplier.fill(1.0)

  if (!treatedEvents || treatedEvents.length === 0) {
    return {
      multiplier, eventCount: 0, inputCount: 0, maxReductionDb: 0, skipped: [],
    }
  }

  const f = { ...DEFAULT_FADES, ...(fades || {}) }
  let maxReductionDb = 0
  let eventCount = 0
  const skipped = []

  for (let i = 0; i < treatedEvents.length; i++) {
    const ev = treatedEvents[i]
    const s = resolveStart(ev, sampleRate)
    const e = resolveEnd(ev, sampleRate)

    // Malformed: no usable bounds at all.
    if (s == null || e == null) {
      skipped.push({ index: i, reason: 'unresolved-bounds' })
      continue
    }
    // Malformed: zero-length or inverted before any clamping.
    if (e <= s) {
      skipped.push({ index: i, reason: 'degenerate' })
      continue
    }

    const sClamp = Math.max(0, s)
    const eClamp = Math.min(numSamples - 1, e)
    // Expected, not malformed: the envelope covers a sub-region and this event
    // lies outside it. Recorded, but not something to warn about.
    if (eClamp <= sClamp) {
      skipped.push({ index: i, reason: 'outside-buffer' })
      continue
    }

    const gainLinear  = Math.pow(10, ev.gainDb / 20)
    const isAffricate = ev.eventType === 'affricate'
    const fadeInMs    = isAffricate ? f.affricateInMs  : f.fricativeInMs
    const fadeOutMs   = isAffricate ? f.affricateOutMs : f.fricativeOutMs

    let fadeIn  = Math.max(1, Math.round((fadeInMs  / 1000) * sampleRate))
    let fadeOut = Math.max(1, Math.round((fadeOutMs / 1000) * sampleRate))
    const eventLen = eClamp - sClamp + 1
    if (fadeIn + fadeOut > eventLen) {
      const scale = eventLen / (fadeIn + fadeOut)
      fadeIn  = Math.max(1, Math.floor(fadeIn  * scale))
      fadeOut = Math.max(1, Math.floor(fadeOut * scale))
    }

    renderEventEnvelope(multiplier, sClamp, eClamp, gainLinear, fadeIn, fadeOut)
    eventCount++
    const absDb = Math.abs(ev.gainDb)
    if (absDb > maxReductionDb) maxReductionDb = absDb
  }

  // Bad input should say so. Out-of-buffer events are routine when the envelope
  // spans a sub-region; unusable bounds are a producer bug and used to vanish
  // without a trace anywhere.
  const malformed = skipped.filter(x => x.reason !== 'outside-buffer')
  if (malformed.length > 0) {
    console.warn(
      `[clipGainEnvelope] ${malformed.length} of ${treatedEvents.length} events ` +
      `could not be rendered: ` +
      malformed.map(x => `#${x.index} ${x.reason}`).join(', '),
    )
  }

  return {
    multiplier,
    /** Events actually rendered — NOT the number handed in. */
    eventCount,
    inputCount: treatedEvents.length,
    maxReductionDb,
    skipped,
  }
}

/**
 * Sample bounds from an event, in samples.
 *
 * Any finite number is accepted as a sample index and rounded. It used to
 * require Number.isInteger, which meant a fractional index — trivially produced
 * by arithmetic like `2.2 * 44100`, which is 97020.00000000001 — matched
 * neither branch and returned null, and the event was then dropped by a bare
 * `continue`. Nothing logged, nothing counted, the envelope just quietly had a
 * hole in it.
 */
function resolveStart(ev, sampleRate) {
  if (Number.isFinite(ev.startSample)) return Math.round(ev.startSample)
  if (Number.isFinite(ev.startSec))    return Math.round(ev.startSec * sampleRate)
  return null
}

function resolveEnd(ev, sampleRate) {
  if (Number.isFinite(ev.endSample))  return Math.round(ev.endSample)
  if (Number.isFinite(ev.endSec))     return Math.round(ev.endSec * sampleRate) - 1
  return null
}

// Half-Hann ramp of `length` samples: 0->1 (rising) or 1->0 (falling). Zero
// derivative at both endpoints — matches the Python implementation, which
// uses linspace(0, π, length, endpoint=True) + (1 - cos)/2.
function cosineFade(length, rising) {
  const out = new Float32Array(length)
  if (length <= 0) return out
  const denom = length - 1 || 1
  for (let i = 0; i < length; i++) {
    const t = (i / denom) * Math.PI
    const v = (1 - Math.cos(t)) * 0.5
    out[i] = rising ? v : 1 - v
  }
  return out
}

// Accumulate one event's gain envelope into the file-wide multiplier array.
// Shape: unity → cosine fade → flat body at gainLinear → cosine fade → unity.
// Overlapping events compound multiplicatively (matches Python behaviour).
function renderEventEnvelope(multiplier, eventStart, eventEnd, gainLinear, fadeIn, fadeOut) {
  const n = multiplier.length
  const bodyStart = Math.min(n, eventStart + fadeIn)
  const bodyEnd   = Math.max(bodyStart, eventEnd - fadeOut + 1)

  // Fade-in: unity at eventStart → gainLinear at bodyStart.
  if (fadeIn > 0 && eventStart < n) {
    const a = Math.max(0, eventStart)
    const b = Math.min(n, eventStart + fadeIn)
    if (b > a) {
      const ramp = cosineFade(b - a, true)
      for (let i = 0; i < b - a; i++) {
        const r   = ramp[i]
        const seg = (1 - r) + r * gainLinear
        multiplier[a + i] *= seg
      }
    }
  }

  // Flat body.
  if (bodyEnd > bodyStart) {
    const a = Math.max(0, bodyStart)
    const b = Math.min(n, bodyEnd)
    for (let i = a; i < b; i++) multiplier[i] *= gainLinear
  }

  // Fade-out: gainLinear at bodyEnd → unity at eventEnd+1.
  if (fadeOut > 0 && eventEnd + 1 <= n) {
    const a = Math.max(0, eventEnd - fadeOut + 1)
    const b = Math.min(n, eventEnd + 1)
    if (b > a) {
      const ramp = cosineFade(b - a, true)
      for (let i = 0; i < b - a; i++) {
        const r   = ramp[i]
        const seg = (1 - r) * gainLinear + r
        multiplier[a + i] *= seg
      }
    }
  }
}
