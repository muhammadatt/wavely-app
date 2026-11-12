/**
 * Auto Leveler — the apply path against the reference expansion.
 *
 * `applyGainSegments` walks the segment list and multiplies as it goes, because
 * expanding the curve first would double peak memory at the worst possible
 * moment. That saving is only worth having if the walk computes the same gain
 * the expansion does, so this pins one to the other — and the expansion is what
 * the parity suite already checks against the server, which makes this the
 * second link in the same chain.
 *
 * It also covers what the walk has that the expansion does not: a window offset
 * into the middle of the analysed region, which is what happens when someone
 * analyses a chapter and applies one paragraph of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyGainSegments, buildGainSegments, expandGainSegments,
  buildCrossfadePlans, buildPowerSum, CROSSFADE_MS,
} from '../../src/audio/dsp/autoLevel.js'

const SR = 44100

function clip(startSample, endSample) {
  return { hopStart: 0, hopEnd: 0, sampleStart: startSample, sampleEnd: endSample }
}

const CLIPS  = [clip(0, 44100), clip(66150, 110250), clip(110250, 154350)]
const GAINS  = [3.5, -2.25, 4.75]
const TOTAL  = 176400

function fixtureSegments() {
  const ps = buildPowerSum(new Float32Array(TOTAL))
  const xf = Math.max(1, Math.round(CROSSFADE_MS * 0.001 * SR))
  const plans = buildCrossfadePlans(CLIPS, GAINS, ps, xf, TOTAL)
  return buildGainSegments(CLIPS, GAINS, plans, TOTAL)
}

/** Deterministic pseudo-audio, so a failure is reproducible. */
function testTone(n, offset = 0) {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    a[i] = 0.4 * Math.sin(2 * Math.PI * 220 * (i + offset) / SR)
  }
  return a
}

test('the walk applies the same gain the expansion computes', () => {
  const segments = fixtureSegments()
  const audio = testTone(TOTAL)

  const walked = applyGainSegments([audio], segments, TOTAL)[0]

  const gainDb = expandGainSegments(segments, TOTAL)
  for (let i = 0; i < TOTAL; i++) {
    const expected = audio[i] * Math.pow(10, gainDb[i] / 20)
    assert.ok(
      Math.abs(walked[i] - expected) < 1e-6,
      `sample ${i}: walked ${walked[i]} vs expanded ${expected}`,
    )
  }
})

test('every channel gets the same curve', () => {
  const segments = fixtureSegments()
  const left = testTone(TOTAL)
  const right = testTone(TOTAL, 137)

  const [outL, outR] = applyGainSegments([left, right], segments, TOTAL)
  const gainDb = expandGainSegments(segments, TOTAL)

  for (let i = 0; i < TOTAL; i += 53) {
    const lin = Math.pow(10, gainDb[i] / 20)
    assert.ok(Math.abs(outL[i] - left[i] * lin) < 1e-6, `L at ${i}`)
    assert.ok(Math.abs(outR[i] - right[i] * lin) < 1e-6, `R at ${i}`)
  }
})

test('an offset window takes the gains belonging to its own position', () => {
  // Analyse a chapter, apply a paragraph. The gains must stay attached to the
  // audio they were measured from; sliding them to the head of the window would
  // apply one phrase's correction to a different phrase, which sounds like the
  // leveler making things worse rather than like an off-by-one.
  const segments = fixtureSegments()
  const full = testTone(TOTAL)
  const gainDb = expandGainSegments(segments, TOTAL)

  const offset = 70000
  const length = 60000
  const window = full.subarray(offset, offset + length)

  const walked = applyGainSegments([window], segments, length, offset)[0]

  for (let i = 0; i < length; i++) {
    const expected = window[i] * Math.pow(10, gainDb[offset + i] / 20)
    assert.ok(
      Math.abs(walked[i] - expected) < 1e-6,
      `offset sample ${i} (absolute ${offset + i}): ${walked[i]} vs ${expected}`,
    )
  }
})

test('a fade clipped by the window keeps its uncut shape', () => {
  // The window starts inside a crossfade. Measuring the fade's phase from the
  // window edge rather than the fade's own start would restart the cosine
  // mid-flight and put a step where the fade was.
  const segments = fixtureSegments()
  const ramp = segments.find(s => s.fromDb !== s.toDb)
  assert.ok(ramp, 'fixture has no fade to clip')

  const offset = ramp.startSample + 200      // partway into the fade
  const length = 4000
  const full = testTone(TOTAL)
  const window = full.subarray(offset, offset + length)

  const walked = applyGainSegments([window], segments, length, offset)[0]
  const gainDb = expandGainSegments(segments, TOTAL)

  for (let i = 0; i < 1000; i++) {
    const expected = window[i] * Math.pow(10, gainDb[offset + i] / 20)
    assert.ok(
      Math.abs(walked[i] - expected) < 1e-6,
      `clipped fade at ${i}: ${walked[i]} vs ${expected}`,
    )
  }
})

test('a window reaching past the curve passes that audio through untouched', () => {
  // Zero-filling the uncovered tail would be silence in the middle of a file,
  // and it would look correct in any test that only checks the covered part.
  const segments = fixtureSegments()
  const offset = TOTAL - 1000
  const length = 5000                        // 4000 samples past the curve
  const window = testTone(length)

  const walked = applyGainSegments([window], segments, length, offset)[0]

  for (let i = 1000; i < length; i++) {
    assert.equal(walked[i], window[i], `sample ${i} past the curve was modified`)
  }
})
