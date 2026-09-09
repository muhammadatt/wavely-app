/**
 * Run with:  npm test
 *
 * `regionAlignDb` — the whole-file drive offset, walked off an edited timeline.
 *
 * ⚠ THE LOAD-BEARING TEST IS THAT IT AGREES WITH `inputAlignDbFor`. There are
 * two measurement paths into the same number: this one walks segments and never
 * materialises the audio, the other has a plain channel array in hand. The
 * panel shows one and the kernel is driven by the other, so the moment they
 * disagree the read-out is a lie about what is being rendered. That class of
 * measurement-path/render-path split has been the recurring defect in this
 * plugin, so it is asserted rather than reasoned about.
 *
 * Lives beside `regionPeak.test.js` and for the same reason: the function is in
 * analysisWindow.js precisely so `node --test` can reach it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { regionAlignDb } from '../../src/audio/analysisWindow.js'
import {
  inputAlignDbFor, gatedRmsFromBlocks, alignDbForRms,
  ALIGN_TARGET_DBFS, ALIGN_MAX_DB,
} from '../../src/audio/dsp/inputAlign.js'

const SR = 44100

const buffer = (channels) => ({ getChannelData: (ch) => channels[ch] })

function segment(samples, { outputStart = 0, sourceStart = 0 } = {}) {
  return {
    outputStart,
    sourceStart,
    sourceEnd: sourceStart + samples.length / SR,
    sourceBuffer: buffer([samples]),
  }
}

/** A SilenceSegment: no source buffer, an explicit duration. */
const silence = (duration, outputStart) => ({
  outputStart, duration, sourceBuffer: null, sourceStart: 0, sourceEnd: 0,
})

function speech(seconds, peakDbfs, seed = 99) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const ph = t % 0.6
    const burst = ph < 0.35 ? Math.min(1, ph / 0.004) * Math.exp(-ph * 2.5) : 0
    x[i] = burst * (0.6 * Math.sin(2 * Math.PI * 180 * t)
      + 0.25 * Math.sin(2 * Math.PI * 900 * t) + 0.15 * rnd())
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const g = Math.pow(10, peakDbfs / 20) / pk
  for (let i = 0; i < n; i++) x[i] = Math.fround(x[i] * g)
  return x
}

test('the segment walk agrees with the direct measurement', () => {
  const x = speech(6, -12)
  const viaSegments = regionAlignDb([segment(x)], 0, x.length / SR, SR, 1)
  const viaChannels = inputAlignDbFor([x], SR)
  assert.ok(Math.abs(viaSegments - viaChannels) < 1e-4,
    `segment walk ${viaSegments} vs direct ${viaChannels}`)
})

test('it agrees across a cut, where block alignment could drift', () => {
  // Two segments laid end to end reconstruct one continuous signal. Blocks are
  // indexed in OUTPUT time, so the join must be invisible; indexing per segment
  // would restart the grid at the cut and shift every block after it.
  const x = speech(6, -12)
  const half = Math.floor(x.length / 2)
  const a = x.slice(0, half)
  const b = x.slice(half)
  const joined = regionAlignDb(
    [segment(a), segment(b, { outputStart: half / SR })], 0, x.length / SR, SR, 1)
  assert.ok(Math.abs(joined - inputAlignDbFor([x], SR)) < 1e-4,
    `across a cut: ${joined} vs ${inputAlignDbFor([x], SR)}`)
})

test('a silence segment counts as quiet, not as absent', () => {
  // A gap must pull the block level DOWN where it lands, then be gated out.
  // Skipping uncovered samples instead would make a half-empty block read as
  // loud as a full one.
  const x = speech(4, -12)
  const withGap = regionAlignDb(
    [segment(x), silence(4, x.length / SR)], 0, x.length / SR + 4, SR, 1)
  const bare = regionAlignDb([segment(x)], 0, x.length / SR, SR, 1)
  assert.ok(Math.abs(withGap - bare) < 0.5,
    `4 s of digital silence moved the offset by ${(withGap - bare).toFixed(3)} dB`)
})

test('a quiet file asks for more drive, and the amount is the level difference', () => {
  const x = speech(6, -12)
  const quieter = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) quieter[i] = Math.fround(x[i] * Math.pow(10, -15 / 20))
  const a = regionAlignDb([segment(x)], 0, x.length / SR, SR, 1)
  const b = regionAlignDb([segment(quieter)], 0, x.length / SR, SR, 1)
  assert.ok(Math.abs((b - a) - 15) < 1e-3, `expected +15 dB, got ${b - a}`)
})

test('degenerate regions return no offset rather than NaN or a clamp', () => {
  assert.equal(regionAlignDb([], 0, 1, SR, 1), 0)
  assert.equal(regionAlignDb([segment(new Float32Array(SR))], 0, 1, SR, 1), 0)
})

/**
 * ⚠ THIS TEST USED TO ASSERT THE BUG. It pinned `regionAlignDb` returning 0 for
 * a sub-block region while `inputAlign.test.js` pinned `gatedRmsOfChannels`
 * falling back to measuring the lot as one block — so the two contracts
 * disagreed for every valid short region, and the suite asserted the
 * disagreement from both ends. The "two paths agree" test above never covered
 * it because it only ever used long regions.
 */
test('a region shorter than one block matches the direct path, not zero', () => {
  const short = speech(0.02, -12)
  const viaSegments = regionAlignDb([segment(short)], 0, short.length / SR, SR, 1)
  const viaChannels = inputAlignDbFor([short], SR)
  assert.notEqual(viaSegments, 0)
  assert.ok(Math.abs(viaSegments - viaChannels) < 0.1,
    `short region: segment walk ${viaSegments} vs direct ${viaChannels}`)
})

test('the segment walk sums channels as the mono tap does', () => {
  // The counterpart of the stereo regressions in inputAlign.test.js: this path
  // accumulates a scratch block rather than adding each channel's energy, and
  // opposed channels are what tell the two apart.
  const x = speech(4, -12)
  const flipped = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) flipped[i] = Math.fround(-x[i])
  const seg = {
    outputStart: 0,
    sourceStart: 0,
    sourceEnd: x.length / SR,
    sourceBuffer: buffer([x, flipped]),
  }
  assert.equal(regionAlignDb([seg], 0, x.length / SR, SR, 2), 0)

  const dead = {
    outputStart: 0,
    sourceStart: 0,
    sourceEnd: x.length / SR,
    sourceBuffer: buffer([x, new Float32Array(x.length)]),
  }
  const oneSided = regionAlignDb([dead], 0, x.length / SR, SR, 2)
  const mono = regionAlignDb([segment(x)], 0, x.length / SR, SR, 1)
  assert.ok(Math.abs((oneSided - mono) - 6.0206) < 0.05,
    `a dead channel should ask for 6.02 dB more drive, got ${(oneSided - mono).toFixed(3)}`)
})

test('the offset is clamped in both directions', () => {
  const loud = speech(6, -12)
  const tiny = new Float32Array(loud.length)
  for (let i = 0; i < loud.length; i++) tiny[i] = Math.fround(loud[i] * 1e-4)
  assert.equal(regionAlignDb([segment(tiny)], 0, loud.length / SR, SR, 1), ALIGN_MAX_DB)
})

test('the shared gate is what both paths use', () => {
  // Guards the refactor that split the gate out: if either path grows its own
  // copy, these stop tracking.
  const blocks = [0.5, 0.4, 0.45, 1e-6, 1e-7, 0.48]
  const r = gatedRmsFromBlocks(blocks)
  assert.ok(r > 0.4 && r < 0.5, `gate let the near-silent blocks through: ${r}`)
  assert.equal(alignDbForRms(r), ALIGN_TARGET_DBFS - 20 * Math.log10(r))
  assert.equal(gatedRmsFromBlocks([]), 0)
  assert.equal(alignDbForRms(0), 0)
})
