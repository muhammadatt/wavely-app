/**
 * Run with:  npm test
 *
 * The LA-2A's side-chain filtering — the 80 Hz high-pass and the R37 emphasis
 * trimmer.
 *
 * This file exists because R37 was modelled backwards and nothing caught it. It
 * was built as a high SHELF BOOST from unity, which leaves the lows at full
 * level: sweeping it end to end moved the gain reduction on a 120 Hz plosive by
 * 0.06 dB, and upward, because Peak Reduction drives a fixed internal threshold
 * so adding side-chain gain adds compression. The control had no test, so a
 * control that could not do the one thing it is for looked fine.
 *
 * Every assertion below is therefore about BEHAVIOUR the hardware's description
 * implies — "turning it counter-clockwise makes the compressor ignore low
 * frequencies" — rather than about the coefficients that happen to implement it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel, processLA2ABuffer } from '../../src/audio/la2aProcessor.js'

const SR = 44100

/** Peak gain reduction the cell reaches on a signal, in dB. */
function grFor(signal, emphasis, peakReduction = 65) {
  const kernel = new LA2AKernel(SR)
  kernel.setParams({ mode: 'compress', gainDb: 0, mix: 1, peakReduction, emphasis })
  const out = new Float32Array(128)
  for (let off = 0; off + 128 <= signal.length; off += 128) {
    kernel.process([signal.subarray(off, off + 128)], [out], 128)
  }
  return kernel.getMetering().maxGainReductionDb
}

/** A burst at one frequency: fast raised-cosine attack, exponential decay. */
function burst(freqHz, seconds = 0.5, amp = 0.6) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = t < 0.25 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 0.05) : Math.exp(-(t - 0.25) * 12)
    out[i] = amp * Math.sin(2 * Math.PI * freqHz * t) * Math.min(1, env)
  }
  return out
}

test('R37 at 0 is the factory position: exactly flat', () => {
  // Fully clockwise on the hardware. Whatever the emphasis path costs, it must
  // cost nothing here, or every existing setting drifts.
  const signal = burst(400)
  const flat = processLA2ABuffer([signal], SR, { peakReduction: 60, emphasis: 0 })
  const none = processLA2ABuffer([signal], SR, { peakReduction: 60 })
  for (let i = 0; i < signal.length; i++) {
    assert.ok(
      Math.abs(flat.channelData[0][i] - none.channelData[0][i]) < 1e-9,
      `sample ${i} diverged`,
    )
  }
})

test('R37 makes the cell progressively ignore low frequencies', () => {
  // The headline claim, and the one the old model failed. Monotonic, and by a
  // wide margin — not a rounding difference.
  const thump = burst(120)
  const sweep = [0, 0.25, 0.5, 0.75, 1].map(e => grFor(thump, e))
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(
      sweep[i] < sweep[i - 1] - 0.5,
      `gain reduction should fall as R37 opens: ${sweep.map(v => v.toFixed(2)).join(' → ')}`,
    )
  }
  assert.ok(
    sweep[0] - sweep[sweep.length - 1] > 5,
    `expected several dB of low-frequency rejection, got ${(sweep[0] - sweep[sweep.length - 1]).toFixed(2)} dB`,
  )
})

test('R37 leaves high frequencies driving the cell as before', () => {
  // The other half: it must reject the lows WITHOUT backing off the sibilance
  // it is supposed to make the unit more sensitive to. A pure level trim on the
  // side-chain would fail this.
  const sibilant = burst(8000)
  const delta = grFor(sibilant, 0) - grFor(sibilant, 1)
  assert.ok(Math.abs(delta) < 1, `HF gain reduction moved ${delta.toFixed(2)} dB`)
})

test('R37 attenuates the side-chain rather than boosting it', () => {
  // Direction matters because there is no threshold control: Peak Reduction is
  // side-chain gain into a FIXED threshold, so a model that boosts the top
  // increases compression where the hardware decreases it. Broadband material
  // must therefore see less reduction, never more.
  const n = SR
  const broadband = new Float32Array(n)
  let seed = 7
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    broadband[i] = ((seed / 0x7fffffff) - 0.5) * 0.8
  }
  assert.ok(
    grFor(broadband, 1) < grFor(broadband, 0),
    'opening R37 must remove side-chain drive, not add it',
  )
})

test('the 80 Hz high-pass is always in circuit, independent of R37', () => {
  // The stock unit's own deafness to rumble. It is not what R37 does, and it
  // does not switch off when R37 is at the factory position.
  const rumble = burst(30)
  const midrange = burst(400)
  assert.ok(
    grFor(rumble, 0) < grFor(midrange, 0) - 2,
    'a 30 Hz tone should drive the cell markedly less than a 400 Hz one at R37 = 0',
  )
})
