/**
 * Clip-gain envelope renderer (JS).
 *
 * Pure-JS port of the cosine-fade envelope renderer in
 * server/scripts/clip_gain_deesser.py. Given a list of treated sibilant events
 * (as emitted by applyClipGainDeEsser into ctx.results.clipGainDeEsser),
 * synthesises a per-sample linear gain multiplier ready to drop into a mix
 * loop. Used by parallelCompression.js to reuse the clip-gain decision on the
 * wet branch instead of running a second sidechain de-esser.
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
 * @returns {{ multiplier: Float32Array, eventCount: number, maxReductionDb: number }}
 */
export function buildClipGainEnvelope(numSamples, sampleRate, treatedEvents, fades = {}) {
  const multiplier = new Float32Array(numSamples)
  multiplier.fill(1.0)

  if (!treatedEvents || treatedEvents.length === 0) {
    return { multiplier, eventCount: 0, maxReductionDb: 0 }
  }

  const f = { ...DEFAULT_FADES, ...(fades || {}) }
  let maxReductionDb = 0

  for (const ev of treatedEvents) {
    const s = resolveStart(ev, sampleRate)
    const e = resolveEnd(ev, sampleRate)
    if (s == null || e == null) continue

    const sClamp = Math.max(0, s)
    const eClamp = Math.min(numSamples - 1, e)
    if (eClamp <= sClamp) continue

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
    const absDb = Math.abs(ev.gainDb)
    if (absDb > maxReductionDb) maxReductionDb = absDb
  }

  return { multiplier, eventCount: treatedEvents.length, maxReductionDb }
}

function resolveStart(ev, sampleRate) {
  if (Number.isInteger(ev.startSample)) return ev.startSample
  if (typeof ev.startSec === 'number')  return Math.round(ev.startSec * sampleRate)
  return null
}

function resolveEnd(ev, sampleRate) {
  if (Number.isInteger(ev.endSample))  return ev.endSample
  if (typeof ev.endSec === 'number')   return Math.round(ev.endSec * sampleRate) - 1
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
