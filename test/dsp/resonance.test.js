/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResonanceKernel,
  RESONANCE_KERNEL_DEFAULTS,
  processResonanceBuffer,
} from '../../src/audio/resonanceProcessor.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const LATENCY = 2048

/**
 * Pitched signal: a harmonic stack with slow pitch wobble over a broadband
 * floor. Used wherever a test needs harmonics to protect. It is NOT required
 * for the suppressor to do anything — see the unpitched test below, which is
 * the regression guard for the gate that used to switch the effect off on
 * anything the pitch tracker could not read.
 */
function voice({
  seconds = 3, f0 = 150, jitterHz = 3, amp = 0.2, noiseDb = -45,
} = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const noiseAmp = Math.pow(10, noiseDb / 20)
  let phase = 0
  let s = 4242
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const pitch = f0 + jitterHz * Math.sin(2 * Math.PI * 2.7 * t)
    phase += (2 * Math.PI * pitch) / SR
    let v = 0
    for (let k = 1; k <= 30; k++) {
      if (pitch * k >= SR / 2) break
      v += (amp / k) * Math.sin(k * phase + k * 0.9)
    }
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = v + noiseAmp * (s / 0x3fffffff - 1)
  }
  return out
}

/** Apply a resonant peaking boost — what a room mode or mic resonance does. */
function resonate(sig, freqHz, q, gainDb) {
  const cascade = new BiquadCascade(1, 1)
  cascade.setSections([peaking(SR, freqHz, q, gainDb)])
  const out = new Float32Array(sig.length)
  cascade.process(sig, out, sig.length, 0)
  return out
}

/** Unpitched broadband signal — the tracker reads 0 of 255 frames as pitched. */
function noise({ seconds = 3, db = -20 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const amp = Math.pow(10, db / 20)
  let s = 4242
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = amp * (s / 0x3fffffff - 1)
  }
  return out
}

/**
 * Mean power in dB across a band, measured on a Hann-windowed segment.
 *
 * The window is not optional: a rectangular window lets a strong harmonic leak
 * 30 dB into the inter-harmonic gaps, which swamps whatever is actually being
 * measured there.
 */
function bandDb(buf, freqHz, from, halfHz = 60) {
  const n = 16384
  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const windowed = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
    windowed[i] = buf[from + i] * w
  }
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(windowed, re, im)

  const binHz = SR / n
  const lo = Math.max(0, Math.round((freqHz - halfHz) / binHz))
  const hi = Math.min(bins - 1, Math.round((freqHz + halfHz) / binHz))
  let power = 0
  for (let k = lo; k <= hi; k++) power += re[k] * re[k] + im[k] * im[k]
  return 10 * Math.log10(power / (hi - lo + 1) / (n * n) + 1e-20)
}

/**
 * How much of a resonant boost the suppressor took back out, in dB.
 * Measured against the un-boosted signal so the voice itself cancels.
 */
function boostRemoved(dry, freqHz, q, gainDb, params) {
  const wet = resonate(dry, freqHz, q, gainDb)
  const out = processResonanceBuffer([wet], SR, params).channelData[0]
  const before = bandDb(wet, freqHz, SR) - bandDb(dry, freqHz, SR)
  const after = bandDb(out, freqHz, SR + LATENCY) - bandDb(dry, freqHz, SR)
  return before - after
}

/**
 * Parametric tests run with harmonic protection OFF so they measure detection
 * and reduction rather than the mask. With it on, protection covers 60–100% of
 * the spectrum (see the coverage test below) and whether a given probe
 * frequency is reachable depends on where the measured pitch put its harmonics
 * that frame — which makes for a flaky test of the wrong thing.
 */
const UNPROTECTED = { ...RESONANCE_KERNEL_DEFAULTS, preserveHarmonics: false }

test('reports a latency of exactly one FFT frame', () => {
  assert.equal(new ResonanceKernel(SR).latencySamples, LATENCY)
})

test('passes audio through delayed, not mangled, at zero depth', () => {
  const sig = voice({ seconds: 2 })
  const { channelData } = processResonanceBuffer([sig], SR, { depth: 0 })
  let maxErr = 0
  for (let i = LATENCY; i + LATENCY < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i + LATENCY] - sig[i]))
  }
  assert.ok(maxErr < 1e-5, `reconstruction error ${maxErr}`)
})

test('the delay is measurable, not merely advertised', () => {
  // applyWorkletRegion trims by exactly this number; a mismatch would
  // time-shift every applied region.
  const n = SR
  const sig = new Float32Array(n)
  for (let i = 2000; i < 2400; i++) {
    sig[i] = Math.sin((2 * Math.PI * 800 * i) / SR) * Math.sin((Math.PI * (i - 2000)) / 400)
  }
  const out = processResonanceBuffer([sig], SR, { depth: 0 }).channelData[0]

  const argmax = buf => {
    let idx = -1
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      if (Math.abs(buf[i]) > peak) {
        peak = Math.abs(buf[i])
        idx = i
      }
    }
    return idx
  }
  assert.equal(argmax(out) - argmax(sig), LATENCY)
})

test('harmonic mask geometry is pinned', () => {
  // These counts DIVERGE from resonance_suppressor.py, deliberately. Two
  // changes, both forced by this being a general-purpose effect rather than a
  // stage inside a speech chain:
  //
  //   - the walk ends at freqCeilHz instead of a fixed 100 harmonics, so the
  //     protected band no longer slides with pitch (at 40 Hz the Python stops
  //     at 4 kHz and leaves everything above exposed);
  //   - the half-width is clamped so neighbouring masks keep a gap.
  //
  // The second is what makes the first safe. With the cap lifted and no clamp,
  // coverage measured 100% for every f0 at or below 82 Hz — "protect the
  // harmonics" collapses into "protect everything" and the effect goes inert.
  const kernel = new ResonanceKernel(SR)
  const golden = { 100: 600, 120.5: 495, 150: 665, 154.7: 645, 220: 694, 300: 578 }
  for (const [f0, expected] of Object.entries(golden)) {
    const mask = kernel._harmonicMask(parseFloat(f0))
    let count = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++
    assert.equal(count, expected, `f0 ${f0}: ${count} bins masked, expected ${expected}`)
  }
})

test('no mask at all below the resolvable harmonic spacing', () => {
  // Under ~64.6 Hz at this bin width, consecutive harmonics land closer than
  // three bins and no comb with gaps can be drawn. Returning null says "no
  // protection available" rather than silently protecting the whole spectrum.
  const kernel = new ResonanceKernel(SR)
  assert.equal(kernel._harmonicMask(64), null)
  assert.ok(kernel._harmonicMask(70) instanceof Uint8Array)
})

test('harmonic protection leaves gaps at every frequency', () => {
  // The property that matters: the inter-harmonic floor stays reachable across
  // the whole band. This previously failed above roughly 50x F0 — for a 150 Hz
  // speaker, everything above ~7.5 kHz was fully masked and unreachable,
  // because the 1%-of-frequency half-width outgrew the harmonic spacing.
  const kernel = new ResonanceKernel(SR)
  const binHz = SR / 2048
  const coverage = (f0, loHz, hiHz) => {
    const mask = kernel._harmonicMask(f0)
    let total = 0
    let covered = 0
    for (let b = 0; b < mask.length; b++) {
      const f = b * binHz
      if (f >= loHz && f < hiHz) {
        total++
        if (mask[b]) covered++
      }
    }
    return covered / total
  }
  for (const f0 of [100, 150, 220, 300]) {
    for (const [lo, hi] of [[500, 1500], [8000, 12000], [16000, 20000]]) {
      const c = coverage(f0, lo, hi)
      assert.ok(
        c < 0.95,
        `f0 ${f0}, ${lo}-${hi} Hz: ${(c * 100).toFixed(1)}% masked, nothing left to work on`,
      )
    }
  }
})

test('suppresses a narrow resonance', () => {
  const dry = voice()
  const removed = boostRemoved(dry, 3000, 40, 12, UNPROTECTED)
  assert.ok(removed > 6, `only ${removed.toFixed(1)} dB of a 12 dB resonance came out`)
})


test('depth scales how much comes out', () => {
  const dry = voice()
  const light = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, depth: 0.2 })
  const heavy = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, depth: 1.0 })
  assert.ok(heavy > light + 2, `depth barely mattered: ${light.toFixed(1)} vs ${heavy.toFixed(1)}`)
})

test('selectivity gates what counts as a resonance', () => {
  const dry = voice()
  const removed = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, selectivity: 60 })
  assert.ok(removed < 2, `expected almost nothing at selectivity 60, got ${removed.toFixed(1)} dB`)
})

test('max reduction caps the cut', () => {
  const dry = voice()
  const capped = boostRemoved(dry, 3000, 40, 18, { ...UNPROTECTED, maxReductionDb: 3 })
  const uncapped = boostRemoved(dry, 3000, 40, 18, UNPROTECTED)
  assert.ok(capped < uncapped - 4, `cap had no effect: ${capped.toFixed(1)} vs ${uncapped.toFixed(1)}`)
})

test('band limits confine the reduction', () => {
  const dry = voice()
  const inBand = boostRemoved(dry, 3000, 40, 12, UNPROTECTED)
  const outOfBand = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, freqCeilHz: 2000 })
  assert.ok(inBand > 6, `in-band removal was only ${inBand.toFixed(1)} dB`)
  assert.ok(outOfBand < 1.5, `above the ceiling should be untouched, got ${outOfBand.toFixed(1)} dB`)
})

test('harmonic protection holds the suppressor off the voice', () => {
  // The mask is the safety mechanism the server refuses to run without. With
  // it on, a signal that is nothing but voice should come through close to
  // untouched; with it off the suppressor starts eating harmonics.
  const sig = voice()
  const withMask = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]
  const without = processResonanceBuffer([sig], SR, UNPROTECTED).channelData[0]

  const departure = out => {
    let sum = 0
    for (let i = LATENCY + 2000; i < sig.length - 2000; i++) {
      sum += Math.abs(out[i] - sig[i - LATENCY])
    }
    return sum / (sig.length - LATENCY - 4000)
  }
  const guarded = departure(withMask)
  const unguarded = departure(without)
  assert.ok(
    unguarded > guarded * 3,
    `mask made little difference: ${guarded.toExponential(2)} vs ${unguarded.toExponential(2)}`,
  )
})

test('suppresses a resonance in unpitched material', () => {
  // REGRESSION GUARD. Suppression used to be gated on the pitch tracker
  // reporting a pitch, which conflated "is there signal here" with "did we
  // find a periodic component". On this input the tracker reads 1 frame in 258
  // as pitched, so the old gate zeroed the reduction on 257 of them and the
  // effect did nothing at all. Drums, cymbals, synths, room tone and every
  // fricative in a narration land in the same hole.
  const sig = resonate(noise(), 3000, 40, 14)
  const out = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]

  const change = f => bandDb(out, f, SR + LATENCY) - bandDb(sig, f, SR)
  const onResonance = change(3000)
  assert.ok(onResonance < -1.5, `resonant band only moved ${onResonance.toFixed(2)} dB`)
  for (const control of [1500, 6000]) {
    assert.ok(
      change(control) > onResonance + 1,
      `${control} Hz moved as much as the resonance — the cut is not selective`,
    )
  }
})

test('the pitch search range is settable and clamped to what the frame resolves', () => {
  // The server hard-coded 70-400 Hz because it only ever saw speech. An
  // out-of-range source does not fail quietly here: the peak picker returns the
  // best lag WITHIN the range, so a 45 Hz source is reported as an octave
  // artefact with full confidence and the mask lands on non-harmonics.
  const kernel = new ResonanceKernel(SR)

  kernel.setParams({ pitchMinHz: 40, pitchMaxHz: 1200 })
  assert.ok(kernel.pitchRange.minHz >= 43, 'a 2048-sample frame cannot reach below ~43 Hz')
  assert.ok(kernel.pitchRange.minHz < 45, `clamped too hard: ${kernel.pitchRange.minHz}`)
  assert.equal(kernel.pitchRange.maxHz, 1200)
  assert.equal(kernel.f0.lagMin, Math.floor(SR / 1200))

  kernel.setParams({ pitchMinHz: 70, pitchMaxHz: 400 })
  assert.equal(kernel.pitchRange.minHz, 70)
  assert.equal(kernel.f0.lagMax, Math.floor(SR / 70))
})

test('the mask cache survives a knob move that does not change its geometry', () => {
  // The effect wrapper posts the whole param object on every knob move, so an
  // `in partial` test on the key would clear the cache on every twist.
  const kernel = new ResonanceKernel(SR)
  kernel._harmonicMask(150)
  assert.equal(kernel.maskCache.size, 1)

  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, depth: 0.4 })
  assert.equal(kernel.maskCache.size, 1, 'depth does not move a single harmonic')

  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, freqCeilHz: 12000 })
  assert.equal(kernel.maskCache.size, 0, 'the ceiling ends the harmonic walk')
})

test('output is independent of the block size it was fed in', () => {
  // The kernel walks a block in hop-sized pieces so a block spanning two
  // frames cannot leave later channels applying the wrong frame's gain.
  const sig = voice({ seconds: 1.5 })
  const n = sig.length
  const oneShot = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]

  const kernel = new ResonanceKernel(SR)
  kernel.setParams(RESONANCE_KERNEL_DEFAULTS)
  const chunked = new Float32Array(n)
  const sizes = [1, 128, 999, 2048, 37]
  let off = 0
  let i = 0
  while (off < n) {
    const len = Math.min(sizes[i++ % sizes.length], n - off)
    kernel.process([sig.subarray(off, off + len)], [chunked.subarray(off, off + len)], len)
    off += len
  }

  let maxErr = 0
  for (let k = 0; k < n; k++) maxErr = Math.max(maxErr, Math.abs(oneShot[k] - chunked[k]))
  assert.ok(maxErr < 1e-6, `block-size dependence: max error ${maxErr}`)
})

test('stereo channels share one gain, so the image cannot wander', () => {
  const sig = voice({ seconds: 1.5 })
  const { channelData } = processResonanceBuffer(
    [sig.slice(), sig.slice()], SR, RESONANCE_KERNEL_DEFAULTS,
  )
  let maxErr = 0
  for (let i = 0; i < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - channelData[1][i]))
  }
  assert.ok(maxErr < 1e-9, `channels diverged by ${maxErr}`)
})

test('survives silence without producing NaN', () => {
  const { channelData } = processResonanceBuffer(
    [new Float32Array(SR)], SR, RESONANCE_KERNEL_DEFAULTS,
  )
  for (let i = 0; i < channelData[0].length; i++) {
    assert.ok(Number.isFinite(channelData[0][i]), `non-finite output at ${i}`)
  }
})

test('reset returns the kernel to its initial behaviour', () => {
  const sig = voice({ seconds: 1 })
  const kernel = new ResonanceKernel(SR)
  kernel.setParams(RESONANCE_KERNEL_DEFAULTS)

  const run = () => {
    const out = new Float32Array(sig.length)
    for (let off = 0; off < sig.length; off += 128) {
      const len = Math.min(128, sig.length - off)
      kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
    return out
  }

  const a = run()
  kernel.reset()
  const b = run()
  let maxErr = 0
  for (let i = 0; i < sig.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]))
  assert.ok(maxErr < 1e-9, `reset did not restore state: ${maxErr}`)
})
