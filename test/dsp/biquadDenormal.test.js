/**
 * Run with:  npm test
 *
 * The denormal flush in `BiquadCascade.process`. An IIR fed digital silence
 * decays exponentially and never reaches zero, so its state spends a very long
 * time subnormal — and this app writes exact zeros into the timeline as a
 * matter of course, so that is ordinary use. The cost lands downstream: on the
 * vocal saturator, whose band split feeds three 62-tap FIR upsamplers, the
 * whole plugin ran 2.26x slower on gated material than on the same audio with a
 * -160 dBFS dither in the gaps.
 *
 * What has to hold is a pair of opposing properties, which is why both are
 * pinned here: the state must actually reach zero (or the flush is dead code
 * and the stall is back), and nothing above the floor may move by a single bit
 * (or a performance fix has quietly become a tone change).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lowpass, peaking, BiquadCascade, DENORMAL_FLOOR } from '../../src/audio/dsp/biquad.js'
import { VocalSatKernel } from '../../src/audio/vocalSatProcessor.js'

const SR = 44100
const MIN_NORMAL = 2.2250738585072014e-308

/**
 * The same transposed direct form II, without the flush — the reference the
 * shipped path must reproduce exactly on ordinary material. Deliberately a
 * separate implementation rather than a flag on the real one: a flag that can
 * be turned off is a second code path, and the question here is whether the
 * ONE path that ships still computes what it used to.
 */
function referenceProcess(sections, input, n) {
  const out = new Float64Array(n)
  const z1 = new Float64Array(sections.length)
  const z2 = new Float64Array(sections.length)
  for (let i = 0; i < n; i++) {
    let x = input[i]
    for (let s = 0; s < sections.length; s++) {
      const c = sections[s]
      const y = c.b0 * x + z1[s]
      z1[s] = c.b1 * x - c.a1 * y + z2[s]
      z2[s] = c.b2 * x - c.a2 * y
      x = y
    }
    out[i] = x
  }
  return out
}

function runCascade(sections, input, n, block = 128) {
  const cascade = new BiquadCascade(sections.length, 1)
  cascade.setSections(sections)
  const out = new Float64Array(n)
  for (let off = 0; off < n; off += block) {
    const len = Math.min(block, n - off)
    cascade.process(input.subarray(off, off + len), out.subarray(off, off + len), len, 0)
  }
  return { out, cascade }
}

test('ordinary audio is bit-identical to the unflushed filter', () => {
  // A resonant section on purpose. In a ringing filter z1 crosses zero every
  // cycle while z2 still carries full level, so a flush keyed on either half
  // alone — rather than on both — truncates the ring here. That mutation
  // passes every silence test and fails this one.
  const sections = [peaking(SR, 800, 12, { type: 'q', value: 8 }), lowpass(SR, 4000, 0.7)]
  const n = 8192
  const input = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    input[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / SR)
  }
  const { out } = runCascade(sections, input, n)
  const ref = referenceProcess(sections, input, n)
  for (let i = 0; i < n; i++) {
    assert.equal(out[i], ref[i], `output moved at sample ${i}`)
  }
})

test('a decaying tail is reproduced exactly until it is far below audibility', () => {
  // The flush must end a tail that is already over, not truncate one that is
  // still running. Everything above the floor has to match the unflushed
  // filter bit for bit, including the whole audible part of the decay.
  const sections = [peaking(SR, 300, 10, { type: 'q', value: 12 })]
  const n = 65536
  const input = new Float64Array(n)
  for (let i = 0; i < 256; i++) input[i] = Math.sin((2 * Math.PI * 300 * i) / SR)

  const { out } = runCascade(sections, input, n)
  const ref = referenceProcess(sections, input, n)

  let checked = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(ref[i]) < DENORMAL_FLOOR) continue
    assert.equal(out[i], ref[i], `decay diverged at sample ${i}`)
    checked++
  }
  // The tail has to actually be long, or this asserts nothing.
  assert.ok(checked > 20000, `only ${checked} samples of tail were above the floor`)
})

test('a first-order section keeps its state — both halves must be tiny to flush', () => {
  // A first-order filter expressed as a biquad has b2 = a2 = 0, so `z2` is
  // permanently exactly zero while `z1` carries the entire state. A flush keyed
  // on EITHER half would therefore fire on every block and clear a live filter,
  // turning it into a pass-through. That mutation survives every other test
  // here — real second-order state decays through the floor in both halves at
  // once, so nothing else can tell the two guards apart.
  //
  // This is a property of the primitive rather than of a caller that exists
  // today: the shipped first-order-shaped sections are pass-throughs, whose
  // state is zero anyway. It is pinned because `BiquadCascade` is shared, and
  // the next caller to need a one-pole would inherit a silent bug.
  const onePole = { b0: 0.05, b1: 0, b2: 0, a1: -0.95, a2: 0 }
  const n = 4096
  const input = new Float64Array(n)
  for (let i = 0; i < n; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / SR)

  const { out } = runCascade([onePole], input, n)
  const ref = referenceProcess([onePole], input, n)
  for (let i = 0; i < n; i++) {
    assert.equal(out[i], ref[i], `first-order state was cleared at sample ${i}`)
  }
})

test('state reaches exactly zero after silence, and stays there', () => {
  // The property the fix exists for. Without the flush the state decays
  // asymptotically and is subnormal-but-nonzero indefinitely.
  const sections = [lowpass(SR, 500, 0.7), lowpass(SR, 2000, 0.7)]
  const n = SR * 3
  const input = new Float64Array(n)
  for (let i = 0; i < SR / 4; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR)

  const { out, cascade } = runCascade(sections, input, n)

  for (let s = 0; s < cascade.sectionCount; s++) {
    assert.equal(cascade.z1[s], 0, `z1[${s}] never flushed`)
    assert.equal(cascade.z2[s], 0, `z2[${s}] never flushed`)
  }
  // And the output it hands downstream is exact zero, not a subnormal — which
  // is the whole point: the FIRs reading this were the expensive part.
  const tail = out.subarray(n - 4096)
  for (let i = 0; i < tail.length; i++) {
    assert.equal(tail[i], 0, `tail sample ${i} is ${tail[i]}, not zero`)
  }
})

test('the floor is far above the subnormal boundary and far below audibility', () => {
  // Both directions matter. Too low and the state is already subnormal by the
  // time it is caught, so the flush does nothing for the cost of a branch; too
  // high and it is a gate on quiet material.
  assert.ok(DENORMAL_FLOOR > MIN_NORMAL * 1e100, 'floor is not clear of the subnormal range')
  assert.ok(DENORMAL_FLOOR < 1e-20, 'floor is high enough to reach real signal')
})

test('the vocal saturator hands its upsamplers no subnormals', () => {
  // The end-to-end version of the bug, on the plugin that surfaced it. Measured
  // before the fix: 80.5% of the low band's samples in a silent tail were
  // subnormal, and each one was then fed through 62 FIR taps, three times over.
  const n = SR * 2
  const input = new Float32Array(n)
  for (let i = 0; i < SR / 2; i++) input[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)

  const kernel = new VocalSatKernel(SR)
  const out = new Float32Array(n)
  const BLOCK = 128
  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    kernel.process([input.subarray(off, off + BLOCK)], [out.subarray(off, off + BLOCK)], BLOCK)
  }

  // Re-run the split alone over the silent tail and count what it produces.
  const ch = kernel.channels[0]
  ch.lp.reset()
  const band = new Float64Array(BLOCK)
  let subnormal = 0
  let counted = 0
  for (let off = 0; off + BLOCK <= n; off += BLOCK) {
    ch.lp.process(input.subarray(off, off + BLOCK), band, BLOCK, 0)
    if (off < SR) continue
    for (let i = 0; i < BLOCK; i++) {
      const v = Math.abs(band[i])
      counted++
      if (v > 0 && v < MIN_NORMAL) subnormal++
    }
  }
  assert.ok(counted > 20000, 'silent tail was too short to measure')
  assert.equal(subnormal, 0, `${((100 * subnormal) / counted).toFixed(1)}% of the silent tail is subnormal`)
})
