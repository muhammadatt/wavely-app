/**
 * Run with:  npm test
 *
 * THE SOFT CLIPPER'S AUTO MAKEUP. Peak-referenced like the compressors', and
 * for the same reason — makeup means handing back what came off the peaks —
 * but structurally simpler in one way that these tests exist to pin.
 *
 * `outputTrimDb` is the kernel's FINAL multiply, so the measurement is EXACT IN
 * ONE PASS rather than iterated toward. The compressors have to iterate because
 * their makeup sits before a nonlinearity and moves the operating point it was
 * measured at; nothing here does. If that ever stops being true — if a
 * nonlinearity is added after the trim, or the trim moves earlier — the
 * round-trip test fails rather than the makeup quietly under-delivering.
 *
 * ⚠ EVERY TEST PINS `limiter` AND `shape` EXPLICITLY. Both have defaults that
 * have moved before, and a probe that cares about a default states it — the
 * convention this suite already follows after 18 curve tests silently began
 * measuring the limiter.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  processSoftClipperBuffer,
  computeSoftClipperAutoMakeupDb,
  softClipperLatencySamples,
  SOFT_CLIPPER_MAKEUP_MAX_DB,
} from '../../src/audio/softClipperProcessor.js'
import { measurePeakCeilingDb } from '../../src/audio/ceilingPresets.js'

const SR = 44100

/**
 * Voice-like material with SPARSE TRANSIENTS, which is the case the whole
 * feature turns on: a clipper takes a lot of peak off rare events while taking
 * almost no energy, and that gap is the loudness the makeup recovers. Plain
 * `speechLike` has no such events — the recorded trap of synthetic material
 * being too clean to answer the question asked of it.
 */
function material(seconds = 4, scale = 0.22) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * t)) ** 2
    const k = i % SR
    const transient = k < 200 ? 0.9 * Math.exp(-k / 40) : 0
    x[i] = scale * env * (
      Math.sin(2 * Math.PI * 140 * t)
      + 0.5 * Math.sin(2 * Math.PI * 420 * t)
      + 0.25 * Math.sin(2 * Math.PI * 3000 * t)
    ) + transient
  }
  return x
}

const peak = (channels, skip = 0) => {
  let p = 0
  for (const ch of channels) for (let i = skip; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]))
  return p
}
const rms = (channels) => {
  let s = 0, n = 0
  for (const ch of channels) { for (const v of ch) s += v * v; n += ch.length }
  return Math.sqrt(s / n)
}
const db = v => 20 * Math.log10(v)

/** A patch at the ceiling the named preset measures for this material. */
function patchFor(x, percentile, extra = {}) {
  const ceiling = measurePeakCeilingDb([x], SR, percentile)
  assert.ok(Number.isFinite(ceiling), 'probe must have a measurable ceiling')
  return {
    thresholdMode: 'fixed',
    fixedThresholdDb: ceiling,
    limiter: 100,
    shape: 'tanh4',
    ...extra,
  }
}

test('the makeup lands the output peak back on the input peak', () => {
  const x = material()
  const p = patchFor(x, 0.93)
  const makeupDb = computeSoftClipperAutoMakeupDb([x], SR, p)

  const out = processSoftClipperBuffer([x], SR, { ...p, outputTrimDb: makeupDb }).channelData
  const skip = softClipperLatencySamples(p, SR)

  // ONE PASS IS EXACT, so this is a tight bound rather than a tolerance: the
  // trim is a post-stage multiply, so scaling by the measured ratio puts the
  // peak exactly where the input's was. The slack that remains is the trim's
  // own smoothing ramp at the head of the render, which the latency skip
  // already steps past.
  assert.ok(
    Math.abs(db(peak(out, skip)) - db(peak([x]))) < 0.05,
    `output peak ${db(peak(out, skip)).toFixed(3)} should match input ${db(peak([x])).toFixed(3)}`,
  )
})

test('it is a real loudness gain, not a level match — RMS rises by nearly the makeup', () => {
  const x = material()
  const p = patchFor(x, 0.93)
  const makeupDb = computeSoftClipperAutoMakeupDb([x], SR, p)
  const out = processSoftClipperBuffer([x], SR, { ...p, outputTrimDb: makeupDb }).channelData

  // The whole argument for the feature: the stage removes a lot of PEAK and
  // almost no ENERGY, so handing the peak back is nearly free loudness. If
  // this ever collapses toward zero the makeup has become a no-op and the
  // stage is removing energy rather than transients.
  const gained = db(rms(out)) - db(rms([x]))
  assert.ok(makeupDb > 6, `expected a substantial makeup, got ${makeupDb.toFixed(2)} dB`)
  assert.ok(
    gained > makeupDb - 1.5,
    `RMS rose ${gained.toFixed(2)} dB against a makeup of ${makeupDb.toFixed(2)} dB`,
  )
})

test('deeper ceilings ask for more makeup, monotonically', () => {
  const x = material()
  const values = [0.97, 0.93, 0.85, 0.75].map(
    pct => computeSoftClipperAutoMakeupDb([x], SR, patchFor(x, pct)),
  )
  for (let i = 1; i < values.length; i++) {
    assert.ok(
      values[i] > values[i - 1],
      `makeup should deepen with the ceiling: ${values.map(v => v.toFixed(2)).join(' / ')}`,
    )
  }
})

test('an incoming outputTrimDb is ignored — the measurement cannot feed back into itself', () => {
  const x = material()
  const p = patchFor(x, 0.93)
  const clean = computeSoftClipperAutoMakeupDb([x], SR, p)
  // A stale trim in the patch is exactly what the panel holds while AUTO
  // re-measures. If it reached the render, the answer would chase its own
  // previous value and the knob would walk on every measurement.
  const stale = computeSoftClipperAutoMakeupDb([x], SR, { ...p, outputTrimDb: 9 })
  assert.equal(clean, stale)
})

test('it never asks the output to be hotter than the source', () => {
  const x = material()
  for (const pct of [0.97, 0.93, 0.85, 0.75]) {
    const p = patchFor(x, pct)
    const makeupDb = computeSoftClipperAutoMakeupDb([x], SR, p)
    const out = processSoftClipperBuffer([x], SR, { ...p, outputTrimDb: makeupDb }).channelData
    const skip = softClipperLatencySamples(p, SR)
    assert.ok(
      peak(out, skip) <= peak([x]) * 1.01,
      `percentile ${pct}: output peak exceeded the source's`,
    )
  }
})

test('it is clamped to the knob, so a deep setting undershoots rather than overshooting', () => {
  const x = material()
  const p = patchFor(x, 0.75)
  const makeupDb = computeSoftClipperAutoMakeupDb([x], SR, p, { maxDb: 2 })
  assert.equal(makeupDb, 2)
  assert.ok(computeSoftClipperAutoMakeupDb([x], SR, p) <= SOFT_CLIPPER_MAKEUP_MAX_DB)
})

test('silence measures zero rather than dividing by it', () => {
  const silence = new Float32Array(SR)
  assert.equal(
    computeSoftClipperAutoMakeupDb([silence], SR, {
      thresholdMode: 'fixed', fixedThresholdDb: -10, limiter: 100, shape: 'tanh4',
    }),
    0,
  )
})

test('an idle stage asks for no makeup', () => {
  const x = material()
  // A ceiling above everything in the file: nothing crosses, so there is no
  // peak reduction to hand back. The distinction matters because a stage that
  // did nothing and a stage whose makeup failed look identical on the knob.
  const p = {
    thresholdMode: 'fixed', fixedThresholdDb: 0, limiter: 0, shape: 'tanh4',
  }
  assert.ok(Math.abs(computeSoftClipperAutoMakeupDb([x], SR, p)) < 0.1)
})

test('CLIP and LIMIT both measure correctly despite their different latencies', () => {
  // The two peak paths report 50 and 226 samples at 44.1 kHz. The measurement
  // skips the stage's own lead-in, so it has to read the latency per patch —
  // the trap the apply path fell into once, trimming 50 samples off a
  // 226-sample render.
  const x = material()
  for (const limiter of [0, 100]) {
    const p = patchFor(x, 0.93, { limiter })
    const makeupDb = computeSoftClipperAutoMakeupDb([x], SR, p)
    const out = processSoftClipperBuffer([x], SR, { ...p, outputTrimDb: makeupDb }).channelData
    assert.ok(
      Math.abs(db(peak(out, softClipperLatencySamples(p, SR))) - db(peak([x]))) < 0.05,
      `limiter ${limiter}: peak did not land back on the source's`,
    )
  }
})
