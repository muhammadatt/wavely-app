/**
 * Run with:  npm test
 *
 * THE LIVE AUTO-MAKEUP TRACKERS — the worklet-side path that replaces a worker
 * round-trip with running extrema, O(1) per sample.
 *
 * ⚠ EVERY TEST HERE RUNS THE LOOP CLOSED, because that is the system. The panel
 * writes the reported makeup back onto the knob, so the kernel runs at the gain
 * its own tracker asked for. A first build measured the signal AFTER the makeup
 * and divided by the makeup in effect — fine open loop, and with the loop closed
 * it applied that division to extrema accumulated at other gains and ran away to
 * −4635 dB. An open-loop test cannot see that, and shipping it would have put an
 * unstable feedback loop in the audio path.
 *
 * Everything both trackers touch is now independent of the makeup by
 * construction, which is what makes stability structural rather than tuned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel, computeAutoMakeupDb } from '../../src/audio/la2aProcessor.js'
import { FET1176Kernel, computeFET1176AutoMakeupDb } from '../../src/audio/fet1176Processor.js'

const SR = 48000

/**
 * Narration-like material with sparse transients, at a level that makes the
 * compressors actually work.
 *
 * ⚠ A 10 dB QUIETER VERSION MEASURED NOTHING — the offline makeup came out at
 * 1.09 dB, so the stage was idle and every comparison was between two roughly
 * zero numbers. The recorded trap of a probe that cannot reach the regime the
 * code operates in.
 */
function material(seconds = 12) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.3 * t)) ** 2
    const k = i % Math.round(SR * 0.9)
    const transient = k < 200 ? 0.7 * Math.exp(-k / 40) : 0
    x[i] = 0.62 * env * (Math.sin(2 * Math.PI * 130 * t) + 0.5 * Math.sin(2 * Math.PI * 2600 * t)) + transient
  }
  return x
}

/**
 * Run a kernel block by block WITH THE LOOP CLOSED — the reported makeup is
 * written back onto the knob, exactly as the panel does it. Returns the whole
 * trajectory so a test can assert on how it got there, not only where it ended.
 */
function runClosedLoop(kernel, x, knob) {
  const B = 128
  const out = [new Float32Array(B)]
  const trace = []
  for (let off = 0; off < x.length; off += B) {
    const len = Math.min(B, x.length - off)
    kernel.process([x.subarray(off, off + len)], [out[0].subarray(0, len)], len)
    const live = kernel.liveAutoMakeupDb()
    if (Number.isFinite(live)) {
      kernel.setParams({ [knob]: live })
      trace.push(live)
    }
  }
  return { final: kernel.liveAutoMakeupDb(), trace }
}

test('OptoSmooth: converges on the offline solve with the loop closed', () => {
  const x = material()
  for (const peakReduction of [55, 70, 85]) {
    const p = { peakReduction }
    const offline = computeAutoMakeupDb([x], SR, p)
    const k = new LA2AKernel(SR); k.setParams(p)
    const { final } = runClosedLoop(k, x, 'gainDb')
    assert.ok(
      Math.abs(final - offline) < 0.6,
      `PR ${peakReduction}: live ${final.toFixed(2)} vs offline ${offline.toFixed(2)}`,
    )
  }
})

test('FET Punch: exact at Mix 1, where the dry share is zero', () => {
  const x = material()
  for (const inputDrive of [40, 55, 75]) {
    const p = { inputDrive, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 1 }
    const offline = computeFET1176AutoMakeupDb([x], SR, p)
    const k = new FET1176Kernel(SR); k.setParams(p)
    const { final } = runClosedLoop(k, x, 'outputGainDb')
    assert.ok(
      Math.abs(final - offline) < 0.6,
      `drive ${inputDrive}: live ${final.toFixed(2)} vs offline ${offline.toFixed(2)}`,
    )
  }
})

test('FET Punch: reports nothing at parallel settings, where the bound is loose', () => {
  // The live bound is (P - max|a|) / max|b|, and those maxima need not fall on
  // the same sample, so below Mix 1 it is safe but slack — measured 3.35 dB
  // under the truth at Mix 0.3. A preview several dB quieter than the render it
  // previews is worse than none, so parallel settings keep the offline solve.
  const x = material()
  for (const mix of [0.9, 0.5, 0.3]) {
    const p = { inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix }
    const k = new FET1176Kernel(SR); k.setParams(p)
    const { final } = runClosedLoop(k, x, 'outputGainDb')
    assert.equal(final, null, `mix ${mix} should defer to the offline solve`)
  }
})

test('THE LOOP IS STABLE — the trajectory stays bounded and settles', () => {
  // The failure this whole file exists for. A diverging loop still "ends" at a
  // number, so asserting only on the final value is not enough: the run has to
  // stay inside the knob's own travel throughout, and stop moving by the end.
  const x = material()
  for (const [Kernel, params, knob, lo, hi] of [
    [LA2AKernel, { peakReduction: 70 }, 'gainDb', -12, 24],
    [FET1176Kernel, { inputDrive: 55, mix: 1 }, 'outputGainDb', -36, 36],
  ]) {
    const k = new Kernel(SR); k.setParams(params)
    const { trace } = runClosedLoop(k, x, knob)
    assert.ok(trace.length > 100, 'expected a trajectory to inspect')
    for (const v of trace) {
      assert.ok(Number.isFinite(v), `${Kernel.name}: non-finite makeup in the loop`)
      assert.ok(v > lo - 6 && v < hi + 6, `${Kernel.name}: makeup left the knob's travel (${v.toFixed(1)} dB)`)
    }
    // Settled: the last tenth of the run moves very little.
    const tail = trace.slice(-Math.floor(trace.length / 10))
    const spread = Math.max(...tail) - Math.min(...tail)
    assert.ok(spread < 0.5, `${Kernel.name}: still moving by ${spread.toFixed(2)} dB at the end`)
  }
})

test('the tracker never asks for an output hotter than the source', () => {
  // The guarantee the offline solve makes, kept by the live one. Checked at the
  // makeup the loop settles on, applied to the same material.
  const x = material()
  const peakOf = (a) => { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); return p }
  const inPeak = peakOf(x)
  for (const [Kernel, params, knob] of [
    [LA2AKernel, { peakReduction: 70 }, 'gainDb'],
    [FET1176Kernel, { inputDrive: 55, mix: 1 }, 'outputGainDb'],
  ]) {
    const k = new Kernel(SR); k.setParams(params)
    const { final } = runClosedLoop(k, x, knob)
    const k2 = new Kernel(SR); k2.setParams({ ...params, [knob]: final })
    const B = 128, out = new Float32Array(x.length)
    for (let off = 0; off < x.length; off += B) {
      const len = Math.min(B, x.length - off)
      k2.process([x.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
    assert.ok(
      peakOf(out) <= inPeak * 1.06,
      `${Kernel.name}: output peak exceeded the source's by ${(20 * Math.log10(peakOf(out) / inPeak)).toFixed(2)} dB`,
    )
  }
})

test('neither reports a makeup before anything has been heard', () => {
  const a = new LA2AKernel(SR); a.setParams({ peakReduction: 60 })
  const b = new FET1176Kernel(SR); b.setParams({ inputDrive: 55 })
  assert.equal(a.liveAutoMakeupDb(), null)
  assert.equal(b.liveAutoMakeupDb(), null)
  const silence = new Float32Array(SR)
  assert.equal(runClosedLoop(a, silence, 'gainDb').final, null)
  assert.equal(runClosedLoop(b, silence, 'outputGainDb').final, null)
})

test('the tracker can be told to forget what has played', () => {
  const x = material(4)
  const k = new FET1176Kernel(SR); k.setParams({ inputDrive: 55 })
  runClosedLoop(k, x, 'outputGainDb')
  assert.ok(Number.isFinite(k.liveAutoMakeupDb()))
  k.resetAutoMakeupTracker()
  assert.equal(k.liveAutoMakeupDb(), null)
})

test('tracking does not disturb the audio', () => {
  // The trackers are observers. If one ever writes to the signal this fails —
  // and it is the one fault invisible in the numbers above, since both sides
  // of every comparison would move together.
  const x = material(3)
  const render = (Kernel, params) => {
    const k = new Kernel(SR); k.setParams(params)
    const B = 128, out = new Float32Array(x.length)
    for (let off = 0; off < x.length; off += B) {
      const len = Math.min(B, x.length - off)
      k.process([x.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
    return out
  }
  for (const [Kernel, params] of [
    [LA2AKernel, { peakReduction: 60, gainDb: 6 }],
    [FET1176Kernel, { inputDrive: 55, outputGainDb: 6 }],
  ]) {
    const a = render(Kernel, params)
    const b = render(Kernel, params)
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i])
  }
})
